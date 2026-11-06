"""The dashboard backend: who may call it, and that a click on the card is the only thing that runs a program."""

import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from reactor_hermes import asks as asks_mod  # noqa: E402
from reactor_hermes import proposals as P  # noqa: E402
from reactor_hermes import sessions, tools  # noqa: E402
from fixtures import CLAUDE_ID, make_claude  # noqa: E402
from procs import wait_for  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FAKE = str(HERE / "fake_cli.py")
PREFIX = "/api/plugins/hermes-reactor"

OWNER = {"capabilities": frozenset({"http:owner"}), "purpose": "native-http", "profile_id": "x"}


def load_api():
    """Load plugin_api.py the way Hermes' dashboard mount does: by file path, with no package."""
    name = "hermes_dashboard_plugin_hermes_reactor"
    spec = importlib.util.spec_from_file_location(name, ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def api(tmp_path, monkeypatch):
    mod = load_api()
    app = FastAPI()

    @app.middleware("http")
    async def fake_hermes_auth(request, call_next):
        # Stand-in for hermes_cli/dashboard_auth/native_http.py: it stamps the principal only for a redeemed ticket.
        mode = request.headers.get("x-test-auth", "")
        if mode == "native":
            request.state.native_http_principal = dict(OWNER)
        elif mode == "wrong-capability":
            request.state.native_http_principal = {"capabilities": frozenset({"session:read"})}
        elif mode == "string-principal":
            request.state.native_http_principal = "yes"
        return await call_next(request)

    app.include_router(mod.router, prefix=PREFIX)

    claude = tmp_path / "fx_claude" / "projects"
    work = tmp_path / "work"
    work.mkdir()
    make_claude(claude, CLAUDE_ID, work, "fix the auth bug", "ok", time.time() - 3600)
    monkeypatch.setenv("REACTOR_TEST_CLI", FAKE)
    P.reset_for_tests()
    P.set_test_roots(claude, tmp_path / "no_codex")
    P.mark_api_ready(True)
    client = TestClient(app, raise_server_exceptions=True)
    yield type("A", (), {"client": client, "tmp": tmp_path, "claude": claude, "mod": mod})
    P.reset_for_tests()
    P.mark_api_ready(False)
    sys.modules.pop("hermes_dashboard_plugin_hermes_reactor", None)


NATIVE = {"x-test-auth": "native"}


def make_proposal(api, instruction="ECHO"):
    ref = sessions.list_sessions(claude_root=api.claude, codex_root=api.tmp / "no_codex")["sessions"][0]["ref"]
    out = json.loads(tools.reactor_continue_session({"ref": ref, "instruction": instruction}))
    assert out["status"] == "awaiting_click", out
    return api.client.get(PREFIX + "/proposals", headers=NATIVE).json()["proposals"][-1]["id"]


ROUTES = [
    ("get", "/health"),
    ("get", "/proposals"),
    ("get", "/proposals/" + "a" * 32),
    ("post", "/proposals/" + "a" * 32 + "/run"),
    ("post", "/proposals/" + "a" * 32 + "/cancel"),
    ("get", "/assistant"),
    ("post", "/assistant"),
    ("get", "/asks"),
    ("post", "/asks/" + "a" * 32 + "/release"),
    ("post", "/asks/" + "a" * 32 + "/deny"),
]


@pytest.mark.parametrize("method,path", ROUTES)
@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"x-hermes-session-token": "anything", "authorization": "Bearer anything"},  # the dashboard session token is not enough
        {"x-test-auth": "wrong-capability"},
        {"x-test-auth": "string-principal"},
        {"x-test-auth": "native", "origin": "http://localhost:9119"},  # a browser page
    ],
    ids=["no-principal", "session-token-only", "wrong-capability", "string-principal", "browser-origin"],
)
def test_every_route_refuses_anything_but_a_native_owner_ticket(api, method, path, headers):
    r = getattr(api.client, method)(PREFIX + path, headers=headers)
    assert r.status_code == 403 and r.json()["detail"] == "native_only"


def test_a_refused_caller_cannot_run_a_known_id(api):
    count = api.tmp / "count.txt"
    pid = make_proposal(api, f"COUNT {count}")
    for headers in ({}, {"x-hermes-session-token": "t"}, {"x-test-auth": "wrong-capability"}):
        r = api.client.post(f"{PREFIX}/proposals/{pid}/run", headers=headers)
        assert r.status_code == 403
    assert not count.exists()
    assert api.client.get(f"{PREFIX}/proposals/{pid}", headers=NATIVE).json()["proposal"]["state"] == "pending"


def test_native_flow_list_run_status(api):
    count = api.tmp / "count.txt"
    pid = make_proposal(api, f"COUNT {count}")
    listing = api.client.get(PREFIX + "/proposals", headers=NATIVE).json()
    assert listing["ok"] is True and [p["id"] for p in listing["proposals"]] == [pid]
    card = listing["proposals"][0]
    assert card["state"] == "pending" and card["instruction"].startswith("COUNT") and card["agent"] == "claude"
    ran = api.client.post(f"{PREFIX}/proposals/{pid}/run", headers=NATIVE).json()
    assert ran["ok"] is True and ran["proposal"]["state"] in ("running", "finished"), ran
    assert wait_for(lambda: api.client.get(f"{PREFIX}/proposals/{pid}", headers=NATIVE).json()["proposal"]["state"] == "finished", 30)
    again = api.client.post(f"{PREFIX}/proposals/{pid}/run", headers=NATIVE).json()
    assert again["ok"] is False and again["error"] == "already_used"
    assert count.read_text().count("run") == 1


def test_cancel_route_denies_a_pending_proposal(api):
    count = api.tmp / "count.txt"
    pid = make_proposal(api, f"COUNT {count}")
    out = api.client.post(f"{PREFIX}/proposals/{pid}/cancel", headers=NATIVE).json()
    assert out["ok"] is True and out["proposal"]["state"] == "denied"
    assert api.client.post(f"{PREFIX}/proposals/{pid}/run", headers=NATIVE).json()["error"] == "already_used"
    assert not count.exists()


@pytest.mark.parametrize("bad", ["x", "../etc", "a" * 100, "%00", "id with space", "jc-abc"])
def test_malformed_ids_are_404_and_run_nothing(api, bad):
    pid = make_proposal(api, "ECHO")
    for method, suffix in (("get", ""), ("post", "/run"), ("post", "/cancel")):
        r = getattr(api.client, method)(f"{PREFIX}/proposals/{bad}{suffix}", headers=NATIVE)
        assert r.status_code in (404, 200)
        if r.status_code == 200:
            assert r.json()["ok"] is False
    assert api.client.get(f"{PREFIX}/proposals/{pid}", headers=NATIVE).json()["proposal"]["state"] == "pending"


def test_unknown_but_well_formed_id(api):
    r = api.client.post(f"{PREFIX}/proposals/{'b' * 32}/run", headers=NATIVE).json()
    assert r == {"ok": False, "error": "unknown_proposal"}


def test_the_tool_result_does_not_contain_what_the_api_returns(api):
    ref = sessions.list_sessions(claude_root=api.claude, codex_root=api.tmp / "no_codex")["sessions"][0]["ref"]
    out = tools.reactor_continue_session({"ref": ref, "instruction": "ECHO\nsecret-words-XYZ"})
    pid = api.client.get(PREFIX + "/proposals", headers=NATIVE).json()["proposals"][-1]["id"]
    assert pid not in out and "secret-words-XYZ" not in out and json.loads(out)["proposal_ref"] != pid


def test_api_ready_flag_follows_the_module_being_loaded(api):
    P.mark_api_ready(False)
    load_api()  # importing the backend marks it ready again
    assert P.api_ready() is True


def test_the_routes_never_list_a_route_that_takes_an_instruction(api):
    """No route can set or replace an instruction or an ask text; the only body is the assistant's name."""
    paths = {(tuple(sorted(r.methods)), r.path) for r in api.mod.router.routes if hasattr(r, "methods")}
    assert paths == {
        (("GET",), "/health"),
        (("GET",), "/proposals"),
        (("GET",), "/proposals/{pid}"),
        (("POST",), "/proposals/{pid}/run"),
        (("POST",), "/proposals/{pid}/cancel"),
        (("GET",), "/assistant"),
        (("POST",), "/assistant"),
        (("GET",), "/asks"),
        (("POST",), "/asks/{pid}/release"),
        (("POST",), "/asks/{pid}/deny"),
    }


# --- the assistant name and the asks for another profile -------------------------------------------------------------------


@pytest.fixture
def profiles(api, hermes_home):
    from reactor_hermes import asks, assistant

    (hermes_home / "profiles" / "writer").mkdir(parents=True)
    asks.reset_for_tests()
    assistant.reset_for_tests()
    yield
    asks.reset_for_tests()
    assistant.reset_for_tests()


def test_assistant_name_round_trip_and_sanitizing(api, profiles):
    got = api.client.get(PREFIX + "/assistant", headers=NATIVE).json()
    assert got == {"ok": True, "name": "Hermes", "default": "Hermes", "presets": ["Hermes", "Jarbas"]}
    r = api.client.post(PREFIX + "/assistant", headers=NATIVE, json={"name": "  Ori<on>!  "}).json()
    assert r == {"ok": True, "name": "Orion"}
    bad = api.client.post(PREFIX + "/assistant", headers=NATIVE, json={"name": "???"}).json()
    assert bad == {"ok": False, "name": "Orion", "error": "bad_name"}
    assert api.client.post(PREFIX + "/assistant", headers=NATIVE, json={"nope": 1}).json()["ok"] is False


def test_ask_flow_release_once_to_the_native_caller_only(api, profiles):
    out = json.loads(tools.reactor_ask_profile({"profile": "writer", "message": "Give me a tagline."}))
    assert out["status"] == "awaiting_click"
    listing = api.client.get(PREFIX + "/asks", headers=NATIVE).json()
    card = listing["asks"][0]
    assert card["profile"] == "writer" and card["message"] == asks_mod.with_provenance("Give me a tagline.") and card["state"] == "pending"
    pid = card["id"]
    for headers in ({}, {"x-hermes-session-token": "t"}, {"x-test-auth": "wrong-capability"}):
        assert api.client.post(f"{PREFIX}/asks/{pid}/release", headers=headers).status_code == 403
    assert api.client.get(PREFIX + "/asks", headers=NATIVE).json()["asks"][0]["state"] == "pending"
    rel = api.client.post(f"{PREFIX}/asks/{pid}/release", headers=NATIVE).json()
    assert rel == {"ok": True, "ask": {"profile": "writer", "message": asks_mod.with_provenance("Give me a tagline.")}}
    again = api.client.post(f"{PREFIX}/asks/{pid}/release", headers=NATIVE).json()
    assert again == {"ok": False, "error": "already_used"}


def test_ask_deny_route(api, profiles):
    tools.reactor_ask_profile({"profile": "writer", "message": "hi"})
    pid = api.client.get(PREFIX + "/asks", headers=NATIVE).json()["asks"][0]["id"]
    assert api.client.post(f"{PREFIX}/asks/{pid}/deny", headers=NATIVE).json()["ask"]["state"] == "denied"
    assert api.client.post(f"{PREFIX}/asks/{pid}/release", headers=NATIVE).json()["error"] == "already_used"


@pytest.mark.parametrize("bad", ["x", "../etc", "a" * 100, "id with space"])
def test_malformed_ask_ids_are_404(api, profiles, bad):
    r = api.client.post(f"{PREFIX}/asks/{bad}/release", headers=NATIVE)
    assert r.status_code in (404, 200)
    if r.status_code == 200:
        assert r.json()["ok"] is False
