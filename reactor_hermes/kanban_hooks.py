"""Kanban observers. Read-only: they tell the Desktop half that a task changed state, and nothing else.

Hermes fires ``kanban_task_claimed``, ``kanban_task_completed``, ``kanban_task_blocked`` and ``on_kanban_task_updated``
after the board change has committed, as observers (return values are ignored). Each one becomes one plugin event with
ids, the assignee and a state only. Task titles, summaries and block reasons are task prose and are never forwarded.
The plugin never reads or writes the board.

Where these run: ``claimed`` fires in the dispatcher process, ``completed`` and ``blocked`` in the worker, and a
plugin event reaches Desktop only from the process a Desktop window is connected to (see ``events.emit``). In another
process the event is a logged no-op, so the status line may miss transitions that happen elsewhere.
"""

from __future__ import annotations

from typing import Any

from . import events
from .text import clean



def _s(value: object, limit: int) -> str:
    return clean(value, limit) if isinstance(value, str) else ""


def _payload(kw: dict) -> dict:
    run_id = kw.get("run_id")
    return {
        "task_id": _s(kw.get("task_id"), 64),
        "board": _s(kw.get("board"), 48),
        "assignee": _s(kw.get("assignee"), 48),
        "profile": _s(kw.get("profile_name"), 48),
        "run_id": run_id if isinstance(run_id, int) and not isinstance(run_id, bool) else None,
    }


def _send(event: str, kw: dict, extra: dict | None = None) -> None:
    try:
        payload = _payload(kw)
        if extra:
            payload.update(extra)
        events.emit(event, payload)
    except Exception:  # health: allow BLE001 -- an observer must never break the board
        return None


def on_claimed(**kw: Any) -> None:
    _send("kanban.claimed", kw)


def on_completed(**kw: Any) -> None:
    _send("kanban.completed", kw)


def on_blocked(**kw: Any) -> None:
    _send("kanban.blocked", kw)


def on_updated(**kw: Any) -> None:
    fields = kw.get("changed_fields")
    names = [_s(f, 32) for f in fields if isinstance(f, str)][:12] if isinstance(fields, (list, tuple)) else []
    _send("kanban.updated", kw, {"changed": [n for n in names if n]})


def register(ctx: Any) -> None:
    ctx.register_hook("kanban_task_claimed", on_claimed)
    ctx.register_hook("kanban_task_completed", on_completed)
    ctx.register_hook("kanban_task_blocked", on_blocked)
    ctx.register_hook("on_kanban_task_updated", on_updated)
