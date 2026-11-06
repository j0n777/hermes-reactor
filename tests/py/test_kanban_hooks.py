"""Kanban observers: ids and states go to the Desktop status line and card badges. Never task text, never a write."""

import json
from pathlib import Path

import pytest

from reactor_hermes import kanban_hooks


@pytest.fixture
def sent(monkeypatch):
    calls = []
    from hermes_cli import plugin_events

    monkeypatch.setattr(plugin_events, "broadcast_plugin_event", lambda pid, ev, payload=None: calls.append((pid, ev, payload)))
    return calls


def test_claimed_completed_blocked_become_plugin_events(sent):
    kanban_hooks.on_claimed(task_id="t_abc", board="main", assignee="writer", run_id=7, profile_name="default")
    kanban_hooks.on_completed(task_id="t_abc", board="main", assignee="writer", run_id=7, profile_name="writer", summary="SECRET SUMMARY")
    kanban_hooks.on_blocked(task_id="t_abc", board="main", assignee="writer", run_id=7, profile_name="writer", reason="SECRET REASON")
    kanban_hooks.on_updated(task_id="t_abc", board="main", assignee="writer", run_id=None, profile_name="default", changed_fields=["title", "assignee"])
    assert [c[1] for c in sent] == ["kanban.claimed", "kanban.completed", "kanban.blocked", "kanban.updated"]
    assert all(c[0] == "hermes-reactor" for c in sent)
    blob = json.dumps(sent)
    assert "SECRET" not in blob  # task prose never leaves the process through this plugin
    assert sent[0][2] == {"task_id": "t_abc", "board": "main", "assignee": "writer", "profile": "default", "run_id": 7}
    assert sent[3][2]["changed"] == ["title", "assignee"]


def test_values_are_cleaned_capped_and_typed(sent):
    kanban_hooks.on_claimed(task_id="t_\u202eevil" + "x" * 500, board=None, assignee=5, run_id="no", profile_name="a\nb")
    payload = sent[0][2]
    assert len(payload["task_id"]) <= 64 and "\u202e" not in payload["task_id"]
    assert payload["board"] == "" and payload["assignee"] == "" and payload["run_id"] is None and payload["profile"] == "a b"


def test_a_hook_never_raises(monkeypatch):
    from hermes_cli import plugin_events

    monkeypatch.setattr(plugin_events, "broadcast_plugin_event", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    assert kanban_hooks.on_claimed(task_id="t", board="b") is None
    assert kanban_hooks.on_completed() is None
    assert kanban_hooks.on_updated(changed_fields="not a list") is None


def test_changed_fields_are_names_only(sent):
    kanban_hooks.on_updated(task_id="t1", changed_fields=["title", 5, "x" * 80, {"a": 1}] + ["f"] * 40)
    changed = sent[0][2]["changed"]
    assert all(isinstance(c, str) and len(c) <= 32 for c in changed) and len(changed) <= 12


def test_register_attaches_only_observer_hooks():
    class Ctx:
        def __init__(self):
            self.hooks = []

        def register_hook(self, name, fn, **kw):
            self.hooks.append(name)

    ctx = Ctx()
    kanban_hooks.register(ctx)
    assert ctx.hooks == ["kanban_task_claimed", "kanban_task_completed", "kanban_task_blocked", "on_kanban_task_updated"]


def test_the_module_does_not_import_or_write_to_the_board():
    text = Path(kanban_hooks.__file__).read_text(encoding="utf-8")
    for word in ("kanban_db", "sqlite", "kanban.db", "open(", "write_text", "subprocess"):
        assert word not in text
