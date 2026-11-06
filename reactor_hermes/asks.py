"""``reactor_ask_profile``: a message for another Hermes profile, held as a proposal until a person clicks.

The same rules as a continue (see :mod:`reactor_hermes.proposals`): the proposal lives in server memory only, for
5 minutes, and can be used once. The model gets back a label and the words "awaiting click", never the id the Desktop
needs to release it. Releasing hands the exact text to the Desktop caller one time and wipes it here; the Desktop
then sends it to the other profile itself (``host.requestProfile``) and shows the reply as untrusted text. This
module starts no program and sends nothing.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import sys
import threading
import time
import types
from pathlib import Path
from typing import Any, Optional

from . import proposals
from .continuation import INSTRUCTION_MAX, INSTRUCTION_MAX_LINES
from .text import clean, clean_multiline

logger = logging.getLogger(__name__)

# Sent in front of every message, and drawn on the card as part of it: what the person reads is what the other profile gets.
# The other profile cannot tell an assistant's draft from the person's own words unless the text says so.
PROVENANCE = (
    "[Sent through Reactor from another profile. The assistant there wrote the text below and the person approved "
    "sending it with a click. These are not the person's own words.]"
)
PROVENANCE_SEPARATOR = "\n\n"

TTL_SECONDS = 5 * 60
KEEP_AFTER_END_SECONDS = 10 * 60
MAX_PENDING = 5
PROFILE_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")  # the shape Hermes uses for a profile handle
ID_RE = re.compile(r"\A[A-Za-z0-9_-]{16,64}\Z")
_ANCHOR = "_reactor_hermes_asks_v1"

PENDING, RELEASED, DENIED, EXPIRED = "pending", "released", "denied", "expired"
TERMINAL = frozenset({RELEASED, DENIED, EXPIRED})


class AskError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _state() -> Any:
    mod = sys.modules.get(_ANCHOR)
    if mod is None:
        fresh = types.ModuleType(_ANCHOR)
        fresh.lock = threading.RLock()
        fresh.items = {}
        mod = sys.modules.setdefault(_ANCHOR, fresh)
    return mod


class Ask:
    __slots__ = ("id", "label", "profile", "message", "created", "expires", "state", "ended_at", "approvals")

    def __init__(self, **kw: Any):
        for name in self.__slots__:
            setattr(self, name, kw.get(name))


def _profiles_dir() -> Optional[Path]:
    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    if (home / "profiles").is_dir():
        return home / "profiles"
    if home.parent.name == "profiles" and home.parent.is_dir():
        return home.parent
    return None


def profile_exists(name: str) -> bool:
    """Read-only look at the profile folders. When they cannot be listed the answer is yes: Desktop checks again."""
    if name.lower() == "default":
        return True
    try:
        root = _profiles_dir()
        if root is None:
            return True
        return (root / name).is_dir()
    except OSError:
        return True


def with_provenance(text: str) -> str:
    """The exact text that is shown and sent: the fixed provenance line, a blank line, then the assistant's words."""
    return PROVENANCE + PROVENANCE_SEPARATOR + text


def current_profile() -> str:
    """The profile this process serves: the folder name under ``profiles/``, else ``default``. Read only."""
    try:
        from hermes_constants import get_hermes_home  # the public helper, honours a routed profile

        home = Path(get_hermes_home())
    except Exception:  # health: allow BLE001 -- fall back to the environment
        home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    if home.parent.name == "profiles" and not (home / "profiles").is_dir():
        return home.name
    return "default"


_OFF_MODES = frozenset({"off", "false", "no", "yolo", "disabled", "never"})


def approvals_status(name: str) -> dict:
    """What the target profile's own config says about Hermes approvals, read only, through Hermes' own helpers.

    ``{"status": "on" | "off" | "unverified", "mode": str}``. ``off`` means ``approvals.mode`` is off (a YOLO setting):
    the other profile then runs its tools without asking anyone. ``unverified`` means the check could not be made
    (no public helper in this Hermes, an unreadable file); the card says so rather than guess. A process-wide
    ``--yolo`` or a session ``/yolo`` toggle lives in memory elsewhere and cannot be seen from here.
    """
    try:
        from hermes_cli import config as hermes_config
        from hermes_constants import get_default_hermes_root

        root = Path(get_default_hermes_root())  # the Hermes root, where profiles/<name> lives
        folder = root if name.lower() == "default" else root / "profiles" / name
        if not folder.is_dir():
            return {"status": "unverified", "mode": ""}
        path = folder / "config.yaml"
        data = hermes_config.read_user_config_raw(path) if path.exists() else {}
    except Exception:  # health: allow BLE001 -- anything unexpected means "could not verify"
        return {"status": "unverified", "mode": ""}
    if not isinstance(data, dict):
        return {"status": "unverified", "mode": ""}
    block = data.get("approvals")
    if block is None:
        return {"status": "on", "mode": "default"}
    if not isinstance(block, dict):
        return {"status": "unverified", "mode": ""}
    mode = block.get("mode", "default")
    if mode is False:  # YAML 1.1 reads an unquoted `off` as false
        return {"status": "off", "mode": "off"}
    shown = clean(str(mode), 24).lower() if mode is not None else "default"
    if shown in _OFF_MODES or block.get("yolo") is True:
        return {"status": "off", "mode": shown or "off"}
    return {"status": "on", "mode": shown or "default"}


def _sweep(st: Any, now: float) -> None:
    for pid, a in list(st.items.items()):
        if a.state == PENDING and now >= a.expires:
            a.state, a.ended_at, a.message = EXPIRED, now, ""
        elif a.state in TERMINAL and a.ended_at is not None and now - a.ended_at > KEEP_AFTER_END_SECONDS:
            del st.items[pid]


def view(a: Ask, now: float) -> dict:
    return {
        "id": a.id,
        "label": a.label,
        "profile": a.profile,
        "message": a.message,
        "state": a.state,
        "created_at": a.created,
        "expires_at": a.expires,
        "remaining_s": max(0, int(a.expires - now)) if a.state == PENDING else 0,
        "written_by": "assistant",
        "approvals": dict(a.approvals) if isinstance(a.approvals, dict) else {"status": "unverified", "mode": ""},
        "untrusted_fields": ["message"],
    }


def list_views(*, now: Optional[float] = None) -> list:
    st = _state()
    now = time.time() if now is None else now
    with st.lock:
        _sweep(st, now)
        return [view(a, now) for a in sorted(st.items.values(), key=lambda x: x.created)]


def get_view(pid: object, *, now: Optional[float] = None) -> Optional[dict]:
    st = _state()
    now = time.time() if now is None else now
    if not isinstance(pid, str):
        return None
    with st.lock:
        _sweep(st, now)
        a = st.items.get(pid)
        return view(a, now) if a else None


def register(profile: object, message: object, *, now: Optional[float] = None) -> dict:
    """Keep a validated ask in memory. Raises :class:`AskError`. Returns what the MODEL may see."""
    now = time.time() if now is None else now
    if not isinstance(profile, str) or not PROFILE_RE.match(profile.strip()):
        raise AskError("bad_profile")
    name = profile.strip()
    body = clean_multiline(message, 0)  # not capped here: too long is refused below, never cut
    if not body:
        raise AskError("bad_message")
    text = with_provenance(body)  # the limits count what is sent, provenance line included
    if len(text) > INSTRUCTION_MAX or text.count("\n") + 1 > INSTRUCTION_MAX_LINES:
        raise AskError("message_too_long")
    if name.lower() == current_profile().lower():
        raise AskError("cannot_ask_self")  # the reply would belong to the profile that is asking
    if not profile_exists(name):
        raise AskError("unknown_profile")
    if not proposals.api_ready():
        raise AskError("ui_unavailable")
    approvals = approvals_status(name)
    st = _state()
    with st.lock:
        _sweep(st, now)
        if sum(1 for a in st.items.values() if a.state == PENDING) >= MAX_PENDING:
            raise AskError("too_many_pending")
        pid = secrets.token_urlsafe(24)
        label = "pa-" + secrets.token_hex(3)
        st.items[pid] = Ask(id=pid, label=label, profile=name, message=text, created=now, expires=now + TTL_SECONDS, state=PENDING, approvals=approvals)
    logger.info("reactor ask registered")
    return {"label": label, "expires_in_s": TTL_SECONDS}


def release(pid: object, *, now: Optional[float] = None) -> dict:
    """The click: hand the exact text over once. Returns ``{"ask": {profile, message}}`` or ``{"error": code}``."""
    st = _state()
    now = time.time() if now is None else now
    if not isinstance(pid, str) or not ID_RE.match(pid):
        return {"error": "unknown_proposal"}
    with st.lock:
        _sweep(st, now)
        a = st.items.get(pid)
        if a is None:
            return {"error": "unknown_proposal"}
        if a.state != PENDING:
            return {"error": "already_used", "ask": view(a, now)}
        out = {"profile": a.profile, "message": a.message}
        a.state, a.ended_at, a.message = RELEASED, now, ""  # consumed first, wiped at once
        return {"ask": out}


def deny(pid: object, *, now: Optional[float] = None) -> dict:
    st = _state()
    now = time.time() if now is None else now
    if not isinstance(pid, str) or not ID_RE.match(pid):
        return {"error": "unknown_proposal"}
    with st.lock:
        _sweep(st, now)
        a = st.items.get(pid)
        if a is None:
            return {"error": "unknown_proposal"}
        if a.state == PENDING:
            a.state, a.ended_at, a.message = DENIED, now, ""
        return {"ask": view(a, now)}


def reset_for_tests() -> None:
    st = _state()
    with st.lock:
        st.items.clear()


def propose(profile: object, message: object, lang: str = "en") -> dict:
    """The result of ``reactor_ask_profile``: a refusal with a fixed code, or ``awaiting_click``."""
    from .i18n import t

    try:
        sent = register(profile, message)
    except AskError as exc:
        return {"status": "refused", "code": exc.code, "executed": False}
    return {
        "status": "awaiting_click",
        "executed": False,
        "proposal_ref": sent["label"],
        "expires_in_s": sent["expires_in_s"],
        "profile": clean(str(profile).strip(), 64),
        "message": t("ask.awaiting", lang),
        "may": t("ask.may", lang),
        "untrusted_fields": [],
    }
