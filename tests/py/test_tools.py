import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest

from reactor_hermes import schemas, tools
from fixtures import CLAUDE_ID, CODEX_ID, make_claude, make_codex
from standin import stand_in

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def fx(tmp_path, monkeypatch):
    claude = tmp_path / "fx_claude" / "projects"
    codex = tmp_path / "fx_codex" / "sessions"
    work = tmp_path / "work"
    work.mkdir()
    now = time.time()
    make_claude(claude, CLAUDE_ID, work, "fix the auth bug", "ok", now - 3600)
    make_codex(codex, CODEX_ID, work, "write tests", "ok", now - 7200)
    monkeypatch.setattr(tools, "_ROOTS", {"claude_root": claude, "codex_root": codex})
    return {"claude_root": claude, "codex_root": codex}


def call(handler, args):
    out = handler(args)
    assert isinstance(out, str)
    return json.loads(out)


def test_list_then_brief_flow(fx):
    listing = call(tools.reactor_list_sessions, {"query": "auth"})
    assert listing["count"] == 1
    ref = listing["sessions"][0]["ref"]
    brief = call(tools.reactor_session_brief, {"ref": ref})
    assert brief["status"] == "ok" and "untrusted_session_data" in brief["excerpt"]


def test_continue_waits_for_a_click_and_executes_nothing(fx, monkeypatch):
    from reactor_hermes import proposals

    proposals.reset_for_tests()
    proposals.mark_api_ready(True)
    monkeypatch.setattr("shutil.which", stand_in)
    try:
        ref = call(tools.reactor_list_sessions, {"query": "auth"})["sessions"][0]["ref"]
        out = call(tools.reactor_continue_session, {"ref": ref, "instruction": "run the tests"})
        assert out["status"] == "awaiting_click"
        assert out["executed"] is False
        assert out["proposal_ref"].startswith("jc-")
        assert set(out) <= {"status", "executed", "proposal_ref", "expires_in_s", "agent", "title", "message", "may", "untrusted_fields"}
        assert proposals.list_views()[0]["state"] == "pending"
    finally:
        proposals.reset_for_tests()
        proposals.mark_api_ready(False)


def test_continue_says_unavailable_when_the_backend_is_not_loaded(fx, monkeypatch):
    monkeypatch.setattr("shutil.which", stand_in)
    ref = call(tools.reactor_list_sessions, {"query": "auth"})["sessions"][0]["ref"]
    out = call(tools.reactor_continue_session, {"ref": ref, "instruction": "run the tests"})
    assert out == {"status": "refused", "code": "ui_unavailable", "executed": False}


def test_explain_risk_tool():
    out = call(tools.reactor_explain_risk, {"command": "rm -rf build"})
    assert out["level"] == "risky" and out["does"] and out["may"]
    assert call(tools.reactor_explain_risk, {"command": "git status"})["level"] == "safe"


@pytest.mark.parametrize("handler", [tools.reactor_list_sessions, tools.reactor_session_brief,
                                     tools.reactor_continue_session, tools.reactor_explain_risk])
@pytest.mark.parametrize("bad", [None, "string", 5, [], {"ref": 1, "query": [], "limit": {}, "command": {}, "instruction": 7}])
def test_handlers_never_raise_and_return_json(handler, bad):
    out = handler(bad, task_id="x", session_id="y", extra=1)
    assert isinstance(json.loads(out), dict)


def test_handler_survives_an_internal_failure(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("secret-looking text that must not be logged")

    monkeypatch.setattr(tools.sessions, "list_sessions", boom)
    out = json.loads(tools.reactor_list_sessions({}))
    assert out == {"status": "error", "code": "internal_error"}


def test_logs_never_contain_commands_or_instructions(fx, caplog, monkeypatch):
    monkeypatch.setattr("shutil.which", stand_in)
    caplog.set_level("DEBUG")
    secret_cmd = "rm -rf /very/secret/path-12345"
    secret_instr = "instruction-with-token-ZZZ987"
    call(tools.reactor_explain_risk, {"command": secret_cmd})
    ref = call(tools.reactor_list_sessions, {})["sessions"][0]["ref"]
    call(tools.reactor_continue_session, {"ref": ref, "instruction": secret_instr})
    text = caplog.text
    assert "path-12345" not in text and "ZZZ987" not in text
    assert "fix the auth bug" not in text


def test_schemas_are_wellformed():
    names = [s["name"] for s in schemas.ALL]
    assert names == ["reactor_list_sessions", "reactor_session_brief", "reactor_continue_session", "reactor_explain_risk", "reactor_show", "reactor_ask_profile"]
    for s in schemas.ALL:
        assert s["parameters"]["type"] == "object"
        assert set(s["parameters"]["required"]) <= set(s["parameters"]["properties"])
        assert len(s["description"]) > 80


def test_plugin_yaml_matches_registered_tools():
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    declared = [ln.strip()[2:] for ln in text.splitlines() if ln.strip().startswith("- reactor_")]
    assert declared == [s["name"] for s in schemas.ALL]
    assert 'requires_hermes: ">=0.23.0"' in text


class FakeCtx:
    def __init__(self):
        self.tools, self.cli, self.skills, self.hooks = [], [], [], []

    def register_hook(self, name, fn, **kw):
        self.hooks.append((name, fn))

    def register_tool(self, **kw):
        self.tools.append(kw)

    def register_cli_command(self, **kw):
        self.cli.append(kw)

    def register_skill(self, name, path):
        self.skills.append((name, Path(path)))


def load_root_plugin():
    import types

    parent = types.ModuleType("hermes_plugins")
    parent.__path__ = []
    sys.modules.setdefault("hermes_plugins", parent)
    name = "hermes_plugins.reactor_under_test"
    spec = importlib.util.spec_from_file_location(name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_register_wires_tools_cli_and_skill():
    module = load_root_plugin()
    ctx = FakeCtx()
    module.register(ctx)
    assert [t["name"] for t in ctx.tools] == [s["name"] for s in schemas.ALL]
    assert all(t["toolset"] == "reactor" and callable(t["handler"]) for t in ctx.tools)
    assert ctx.cli and ctx.cli[0]["name"] == "reactor"
    assert ctx.skills and ctx.skills[0][0] == "reactor" and ctx.skills[0][1].is_file()


def test_register_wires_the_persona_hook_and_the_read_only_kanban_observers():
    module = load_root_plugin()
    ctx = FakeCtx()
    module.register(ctx)
    assert [n for n, _ in ctx.hooks] == ["pre_llm_call", "kanban_task_claimed", "kanban_task_completed", "kanban_task_blocked", "on_kanban_task_updated"]


def test_plugin_yaml_declares_exactly_what_register_registers():
    import yaml

    module = load_root_plugin()
    ctx = FakeCtx()
    module.register(ctx)
    manifest = yaml.safe_load((ROOT / "plugin.yaml").read_text(encoding="utf-8"))
    assert manifest["name"] == "hermes-reactor"
    assert manifest["provides_tools"] == [t["name"] for t in ctx.tools]
    assert manifest["provides_hooks"] == [n for n, _ in ctx.hooks]
