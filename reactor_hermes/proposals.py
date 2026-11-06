"""Proposals: a continue that really runs, released by a person's click.

Flow
----
1. The model calls ``reactor_continue_session``. The tool validates and calls :func:`register`. The proposal lives in
   server memory only (never on disk), for 5 minutes, and can be used once. The model gets back only a label and the
   words "awaiting click". It never gets the proposal id, which is what the backend needs to run it.
2. The Desktop card (a large card, Deny first) lists the proposal through ``dashboard/plugin_api.py`` and, on a real
   click, calls :func:`run` with the id.
3. :func:`run` consumes the proposal first (a replay is refused), then re-validates from scratch (the session still
   exists and is idle, the folder is the same folder, the id pattern holds) and only then hands the plan to
   :mod:`reactor_hermes.runner`.

The tool (loaded by the Hermes plugin loader) and the API (loaded by the dashboard mount) are different module objects
in the same Python process, so the state lives on one anchor module in ``sys.modules`` that both reach. If the API was
not loaded in this process (an isolated plugin host, a compute-host child) the tool sees ``api_ready`` is false and
refuses to register anything: a proposal nobody can click is worse than an honest "unavailable".

Logs hold fixed codes and counts only. The instruction and the output exist in memory and nowhere else.
"""

from __future__ import annotations

import logging
import secrets
import sys
import threading
import time
import types
from typing import Any, Optional

from . import continuation, runner
from .continuation import ContinueError
from .sessions import SESSION_ID_RE, SessionRec, resolve_ref
from .text import clean, clean_multiline, clean_title

logger = logging.getLogger(__name__)

PROPOSAL_TTL_SECONDS = 5 * 60
KEEP_AFTER_END_SECONDS = 10 * 60
MAX_PENDING = 5
MAX_RUNNING = 3
OUTPUT_SHOWN_CHARS = 8000
ID_RE_PATTERN = r"\A[A-Za-z0-9_-]{16,64}\Z"

_ANCHOR = "_reactor_hermes_shared_state_v1"

# States. pending -> (running | denied | expired); running -> (finished | failed | cancelled); a refused re-validation
# goes pending -> failed with a code and `started: false`.
PENDING, RUNNING, FINISHED, FAILED, CANCELLED, DENIED, EXPIRED = (
    "pending", "running", "finished", "failed", "cancelled", "denied", "expired",
)
TERMINAL = frozenset({FINISHED, FAILED, CANCELLED, DENIED, EXPIRED})


def shared() -> Any:
    """The one state object of this process, whichever copy of this module asks."""
    mod = sys.modules.get(_ANCHOR)
    if mod is None:
        fresh = types.ModuleType(_ANCHOR)
        fresh.lock = threading.RLock()
        fresh.proposals = {}  # id -> Proposal
        fresh.session_runs = {}  # session key -> proposal id (one run per session)
        fresh.api_ready = False
        fresh.roots = {"claude_root": None, "codex_root": None}  # test seam; production leaves both None
        mod = sys.modules.setdefault(_ANCHOR, fresh)
    return mod


class Proposal:
    __slots__ = (
        "id", "label", "agent", "ref", "session_id", "title", "cwd", "identity", "instruction", "created", "expires",
        "state", "code", "started", "started_at", "ended_at", "exit_code", "output", "truncated", "cancel",
    )

    def __init__(self, **kw: Any):
        for name in self.__slots__:
            setattr(self, name, kw.get(name))
        self.cancel = threading.Event()


def _now() -> float:
    return time.time()


def mark_api_ready(value: bool = True) -> None:
    shared().api_ready = bool(value)


def api_ready() -> bool:
    return bool(shared().api_ready)


def set_test_roots(claude_root: Optional[Any], codex_root: Optional[Any]) -> None:
    """Test seam: fixture roots for the session adapter. Production never calls this."""
    shared().roots = {"claude_root": claude_root, "codex_root": codex_root}


def _session_key(agent: str, session_id: str) -> str:
    return f"{agent}:{session_id.lower()}"


def _sweep(st: Any, now: float) -> None:
    """Expire old pending proposals and drop old finished ones. Caller holds the lock."""
    for pid, p in list(st.proposals.items()):
        if p.state == PENDING and now >= p.expires:
            p.state = EXPIRED
            p.ended_at = now
            p.instruction = ""
            p.cancel.set()
        elif p.state in TERMINAL and p.ended_at is not None and now - p.ended_at > KEEP_AFTER_END_SECONDS:
            del st.proposals[pid]


# --- registering (the tool side) ---------------------------------------------------------------------------------------


def register(rec: SessionRec, plan: continuation.Plan, *, now: Optional[float] = None) -> dict:
    """Keep a validated proposal in memory. Returns what the MODEL may see: a label, never the id.

    Raises :class:`ContinueError` with ``ui_unavailable`` or ``too_many_pending``.
    """
    st = shared()
    now = _now() if now is None else now
    if not st.api_ready:
        raise ContinueError("ui_unavailable")
    identity = continuation.folder_identity(plan.cwd)
    if identity is None:
        raise ContinueError("folder_missing")
    with st.lock:
        _sweep(st, now)
        # A newer proposal for the same session replaces the older one: the card then shows the new text, and a click
        # on the old card's id is refused ("unknown_proposal"), so nobody runs words they did not read.
        for pid, p in list(st.proposals.items()):
            if p.state == PENDING and p.ref == rec.ref:
                p.state = DENIED
                p.code = "superseded"
                p.ended_at = now
                p.instruction = ""
        pending = sum(1 for p in st.proposals.values() if p.state == PENDING)
        if pending >= MAX_PENDING:
            raise ContinueError("too_many_pending")
        pid = secrets.token_urlsafe(24)
        label = "jc-" + secrets.token_hex(3)  # a separate random value: knowing it does not help to run anything
        st.proposals[pid] = Proposal(
            id=pid,
            label=label,
            agent=rec.agent,
            ref=rec.ref,
            session_id=rec.session_id,
            title=rec.title,
            cwd=plan.cwd,
            identity=identity,
            instruction=plan.stdin.decode("utf-8"),
            created=now,
            expires=now + PROPOSAL_TTL_SECONDS,
            state=PENDING,
            started=False,
        )
    logger.info("reactor proposal registered (pending=%d)", pending + 1)
    return {"label": label, "expires_in_s": PROPOSAL_TTL_SECONDS}


# --- what the Desktop sees ---------------------------------------------------------------------------------------------


def view(p: Proposal, now: float) -> dict:
    """The card data. Everything that came from outside is cleaned; the instruction is shown as the exact text."""
    out = ""
    if p.output:
        out = p.output[-OUTPUT_SHOWN_CHARS:]
    return {
        "id": p.id,
        "label": p.label,
        "agent": p.agent,
        "ref": p.ref,
        "title": clean_title(p.title, 120),
        "folder": clean(p.cwd, 240),
        "instruction": p.instruction,
        "state": p.state,
        "code": p.code or "",
        "started": bool(p.started),
        "created_at": p.created,
        "expires_at": p.expires,
        "remaining_s": max(0, int(p.expires - now)) if p.state == PENDING else 0,
        "started_at": p.started_at,
        "ended_at": p.ended_at,
        "exit_code": p.exit_code,
        "output": out,
        "output_truncated": bool(p.truncated),
        "runs_under_own_permissions": True,
        # File names only (never values): project settings that define hooks take effect under `claude -p`.
        "project_hooks": continuation.project_hooks(p.cwd) if p.state == PENDING and p.agent == "claude" else [],
        "untrusted_fields": ["title", "folder", "instruction", "output"],
    }


def list_views(*, now: Optional[float] = None) -> list:
    st = shared()
    now = _now() if now is None else now
    with st.lock:
        _sweep(st, now)
        items = sorted(st.proposals.values(), key=lambda p: p.created)
        return [view(p, now) for p in items]


def get_view(pid: object, *, now: Optional[float] = None) -> Optional[dict]:
    st = shared()
    now = _now() if now is None else now
    if not isinstance(pid, str):
        return None
    with st.lock:
        _sweep(st, now)
        p = st.proposals.get(pid)
        return view(p, now) if p else None


# --- running (the API side) --------------------------------------------------------------------------------------------


def _revalidate(p: Proposal) -> continuation.Plan:
    """Look at the session again, from scratch. Raises :class:`ContinueError` with a fixed code."""
    st = shared()
    rec, status = resolve_ref(p.ref, **st.roots)
    if rec is None:
        raise ContinueError("session_gone" if status == "unknown_ref" else status)
    if not rec.session_id or not SESSION_ID_RE.match(rec.session_id):
        raise ContinueError("bad_session_id")
    if rec.session_id != p.session_id or rec.agent != p.agent:
        raise ContinueError("session_changed")
    if rec.cwd != p.cwd:
        raise ContinueError("folder_changed")
    plan = continuation.build_plan(rec, p.instruction)  # id pattern, folder exists, idle for 2 minutes, CLI found
    now_identity = continuation.folder_identity(plan.cwd)
    if now_identity is None or now_identity != p.identity:
        raise ContinueError("folder_changed")  # swapped for a junction, a symlink or another folder
    return plan


def run(pid: object, *, now: Optional[float] = None) -> dict:
    """Release a proposal. Returns the new view, or ``{"error": code}``. Never raises."""
    st = shared()
    now = _now() if now is None else now
    if not isinstance(pid, str):
        return {"error": "unknown_proposal"}
    with st.lock:
        _sweep(st, now)
        p = st.proposals.get(pid)
        if p is None:
            return {"error": "unknown_proposal"}
        if p.state != PENDING:
            return {"error": "already_used", "proposal": view(p, now)}
        key = _session_key(p.agent, p.session_id or "")
        if key in st.session_runs:
            return {"error": "session_busy", "proposal": view(p, now)}
        if len(st.session_runs) >= MAX_RUNNING:
            return {"error": "too_many_running", "proposal": view(p, now)}
        # Single use: the proposal is consumed here, before anything can fail, so a replay can never run twice.
        p.state = RUNNING
        p.started_at = now
        st.session_runs[key] = p.id
    try:
        plan = _revalidate(p)
    except ContinueError as exc:
        _finish(p, key, FAILED, code=exc.code, started=False)
        return {"proposal": get_view(pid)}
    except Exception as exc:  # health: allow BLE001 -- never raise into the API
        logger.warning("reactor run: revalidation failed: %s", type(exc).__name__)
        _finish(p, key, FAILED, code="internal_error", started=False)
        return {"proposal": get_view(pid)}
    thread = threading.Thread(target=_work, args=(p, key, plan), name="reactor-run", daemon=True)
    thread.start()
    logger.info("reactor run started (running=%d)", len(st.session_runs))
    return {"proposal": get_view(pid)}


def _work(p: Proposal, key: str, plan: continuation.Plan) -> None:
    try:
        with shared().lock:
            p.started = True
        result = runner.run_program(
            plan.argv,
            cwd=plan.cwd,
            stdin=plan.stdin,
            env=runner.child_env(),
            timeout=runner.TIMEOUT_SECONDS,
            cancel=p.cancel,
        )
    except Exception as exc:  # health: allow BLE001
        logger.warning("reactor run crashed: %s", type(exc).__name__)
        _finish(p, key, FAILED, code="internal_error")
        return
    text = clean_multiline(runner.decode_output(result.output), 0)
    if result.outcome == "finished":
        _finish(p, key, FINISHED, exit_code=result.exit_code, output=text, truncated=result.truncated)
    elif result.outcome == "cancelled":
        _finish(p, key, CANCELLED, code="cancelled", exit_code=result.exit_code, output=text, truncated=result.truncated)
    else:
        code = {"failed": "exit_nonzero", "timeout": "timeout", "output_limit": "output_limit", "spawn_failed": "spawn_failed"}.get(
            result.outcome, "internal_error"
        )
        started = result.outcome != "spawn_failed"
        _finish(p, key, FAILED, code=code, exit_code=result.exit_code, output=text, truncated=result.truncated, started=started)
    logger.info("reactor run ended: %s, %d bytes of output", result.outcome, result.total_bytes)


def _finish(p: Proposal, key: str, state: str, *, code: str = "", started: Optional[bool] = None, exit_code: Optional[int] = None,
            output: str = "", truncated: bool = False) -> None:
    st = shared()
    with st.lock:
        p.state = state
        p.code = code
        p.exit_code = exit_code
        p.output = output
        p.truncated = truncated
        p.ended_at = _now()
        if started is not None:
            p.started = started
        if st.session_runs.get(key) == p.id:
            del st.session_runs[key]


def cancel(pid: object, *, now: Optional[float] = None) -> dict:
    """Deny a pending proposal, or stop a running one. Never raises."""
    st = shared()
    now = _now() if now is None else now
    if not isinstance(pid, str):
        return {"error": "unknown_proposal"}
    with st.lock:
        _sweep(st, now)
        p = st.proposals.get(pid)
        if p is None:
            return {"error": "unknown_proposal"}
        if p.state == PENDING:
            p.state = DENIED
            p.code = "denied"
            p.ended_at = now
            p.instruction = ""
            p.cancel.set()
        elif p.state == RUNNING:
            p.cancel.set()  # the worker stops the process tree and records "cancelled"
        return {"proposal": view(p, now)}


def reset_for_tests() -> None:
    """Forget everything. Tests only."""
    st = shared()
    with st.lock:
        for p in st.proposals.values():
            p.cancel.set()
        st.proposals.clear()
        st.session_runs.clear()
        st.roots = {"claude_root": None, "codex_root": None}


# --- the tool entry ----------------------------------------------------------------------------------------------------


def propose(ref: object, instruction: object, lang: str = "en", *, which: Any = None) -> dict:
    """The result of ``reactor_continue_session``: a refusal with a fixed code, or ``awaiting_click``.

    The result never carries the proposal id, the instruction, a command or a path that would let the model run
    anything. ``executed`` is always False here: only a click on the Desktop card starts a program.
    """
    import shutil

    from .i18n import t

    st = shared()
    rec, status = resolve_ref(ref, **st.roots)
    if rec is None:
        return {"status": "refused", "code": status, "executed": False}
    try:
        plan = continuation.build_plan(rec, instruction, which=which or shutil.which)
        sent = register(rec, plan)
    except ContinueError as exc:
        return {"status": "refused", "code": exc.code, "executed": False}
    return {
        "status": "awaiting_click",
        "executed": False,
        "proposal_ref": sent["label"],
        "expires_in_s": sent["expires_in_s"],
        "agent": rec.agent,
        "title": clean_title(rec.title, 80),
        "message": t("cont.awaiting", lang),
        "may": t("cont.may", lang),
        "untrusted_fields": ["title"],
    }
