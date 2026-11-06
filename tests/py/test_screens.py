"""reactor_show: a closed list of screens, a plugin event for Desktop, and nothing else."""

import json
import logging

import pytest

from reactor_hermes import events, schemas, screens, tools


@pytest.fixture
def sent(monkeypatch):
    calls = []

    def fake(plugin_id, event, payload=None):
        calls.append((plugin_id, event, payload))

    from hermes_cli import plugin_events

    monkeypatch.setattr(plugin_events, "broadcast_plugin_event", fake)
    return calls


def test_the_closed_list():
    assert screens.VIEWS == ("stage", "graph", "agents", "profiles", "kanban", "cron", "messaging", "capabilities")
    assert schemas.SHOW["parameters"]["properties"]["view"]["enum"] == list(screens.VIEWS)


@pytest.mark.parametrize("view", screens.VIEWS)
def test_a_known_view_broadcasts_one_event_under_the_plugin_id(sent, view):
    out = json.loads(tools.reactor_show({"view": view}))
    assert out["status"] == "requested" and out["view"] == view
    assert sent == [("hermes-reactor", "show", {"view": view})]


def test_case_and_spaces_are_forgiven_but_nothing_else(sent):
    assert json.loads(tools.reactor_show({"view": "  Graph "}))["view"] == "graph"
    assert sent == [("hermes-reactor", "show", {"view": "graph"})]


@pytest.mark.parametrize("bad", ["", "settings", "../x", "graph; rm -rf", None, 5, ["graph"], {"v": 1}, "STAGES"])
def test_an_unknown_view_does_nothing(sent, bad):
    out = json.loads(tools.reactor_show({"view": bad}))
    assert out["status"] == "refused" and out["code"] == "unknown_view" and out["views"] == list(screens.VIEWS)
    assert sent == []


def test_missing_args_do_nothing(sent):
    assert json.loads(tools.reactor_show(None))["status"] == "refused"
    assert json.loads(tools.reactor_show({}))["status"] == "refused"
    assert sent == []


def test_no_desktop_in_this_process_is_reported_honestly(monkeypatch):
    def boom(*a, **k):
        raise ImportError("no gateway")

    from hermes_cli import plugin_events

    monkeypatch.setattr(plugin_events, "broadcast_plugin_event", boom)
    out = json.loads(tools.reactor_show({"view": "stage"}))
    assert out["status"] == "refused" and out["code"] == "ui_unavailable"


def test_a_failing_broadcast_never_raises_into_the_agent(monkeypatch, caplog):
    from hermes_cli import plugin_events

    monkeypatch.setattr(plugin_events, "broadcast_plugin_event", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("secret detail")))
    with caplog.at_level(logging.DEBUG):
        out = json.loads(tools.reactor_show({"view": "stage"}))
    assert out["status"] == "refused" and "secret detail" not in json.dumps(out)
    assert "secret detail" not in caplog.text


def test_events_emit_returns_false_when_there_is_no_gateway(monkeypatch):
    from hermes_cli import plugin_events

    monkeypatch.setattr(plugin_events, "broadcast_plugin_event", lambda *a, **k: None)
    assert events.emit("show", {"view": "stage"}) is True
    assert events.PLUGIN_ID == "hermes-reactor"


def test_the_event_names_are_valid_wire_names():
    from hermes_cli.plugin_events import plugin_event_name

    for name in ("show", "kanban.claimed", "kanban.completed", "kanban.blocked", "kanban.updated"):
        assert plugin_event_name(events.PLUGIN_ID, name).startswith("plugin.hermes-reactor.")
