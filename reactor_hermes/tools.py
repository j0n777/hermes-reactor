"""Tool handlers. Each takes `(args: dict, **kwargs)` and returns a JSON string, always; none raises.

Logging rule: only counts and fixed codes are ever logged. Commands, instructions, titles and excerpts never are.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

from . import asks, proposals, screens, sessions
from .i18n import resolve_lang
from .risk import classify

logger = logging.getLogger(__name__)

# Test seam: roots for fixtures. Production leaves both as None so Hermes uses the tools' own folders.
_ROOTS: dict = {"claude_root": None, "codex_root": None}


def _args(args: Any) -> dict:
    return args if isinstance(args, dict) else {}


def _safe(name: str, fn: Callable[[dict], dict]) -> Callable[..., str]:
    def handler(args: Any = None, **_kwargs: Any) -> str:
        try:
            return json.dumps(fn(_args(args)), ensure_ascii=False)
        except Exception as exc:  # never raise into the agent loop
            logger.warning("reactor tool %s failed: %s", name, type(exc).__name__)
            return json.dumps({"status": "error", "code": "internal_error"})

    handler.__name__ = name
    return handler


def _list(a: dict) -> dict:
    out = sessions.list_sessions(a.get("query"), a.get("limit"), **_ROOTS)
    logger.info("reactor_list_sessions: %s rows, status %s", out.get("count"), out.get("status"))
    return out


def _brief(a: dict) -> dict:
    out = sessions.brief(a.get("ref"), **_ROOTS)
    logger.info("reactor_session_brief: status %s", out.get("status"))
    return out


def _continue(a: dict) -> dict:
    # Tests point the shared proposal state at fixture roots through proposals.set_test_roots; the _ROOTS seam of this
    # module is honoured too so older tests keep working.
    if _ROOTS["claude_root"] is not None or _ROOTS["codex_root"] is not None:
        proposals.set_test_roots(_ROOTS["claude_root"], _ROOTS["codex_root"])
    out = proposals.propose(a.get("ref"), a.get("instruction"), resolve_lang())
    logger.info("reactor_continue_session: %s %s", out.get("status"), out.get("code", ""))
    return out


def _risk(a: dict) -> dict:
    verdict = classify(a.get("command"), resolve_lang())
    logger.info("reactor_explain_risk: %s %s", verdict["kind"], ",".join(verdict["codes"]))
    return verdict


reactor_list_sessions = _safe("reactor_list_sessions", _list)
reactor_session_brief = _safe("reactor_session_brief", _brief)
reactor_continue_session = _safe("reactor_continue_session", _continue)
reactor_explain_risk = _safe("reactor_explain_risk", _risk)


def _show(a: dict) -> dict:
    out = screens.show(a.get("view"))
    logger.info("reactor_show: %s %s", out.get("status"), out.get("code", ""))
    return out


def _ask(a: dict) -> dict:
    out = asks.propose(a.get("profile"), a.get("message"), resolve_lang())
    logger.info("reactor_ask_profile: %s %s", out.get("status"), out.get("code", ""))
    return out


reactor_show = _safe("reactor_show", _show)
reactor_ask_profile = _safe("reactor_ask_profile", _ask)
