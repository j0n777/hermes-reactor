"""reactor_ask_profile: a proposal in memory that only a person's click can release, once."""

import json
import threading
import time
from pathlib import Path

import pytest

from reactor_hermes import asks, proposals, schemas, tools


@pytest.fixture(autouse=True)
def fresh(hermes_home):
    (hermes_home / "profiles" / "writer").mkdir(parents=True)
    (hermes_home / "profiles" / "coder").mkdir(parents=True)
    asks.reset_for_tests()
    proposals.mark_api_ready(True)
    yield
    asks.reset_for_tests()
    proposals.mark_api_ready(False)


def call(args):
    return json.loads(tools.reactor_ask_profile(args))


def only_id():
    views = asks.list_views()
    assert len(views) == 1
    return views[0]["id"]


def test_ask_registers_a_pending_card_and_runs_nothing():
    out = call({"profile": "writer", "message": "Draft a tagline for the demo."})
    assert out["status"] == "awaiting_click" and out["executed"] is False
    assert set(out) <= {"status", "executed", "proposal_ref", "expires_in_s", "profile", "message", "may", "untrusted_fields"}
    view = asks.list_views()[0]
    assert view["profile"] == "writer" and view["message"] == asks.with_provenance("Draft a tagline for the demo.") and view["state"] == "pending"
    assert 0 < view["remaining_s"] <= asks.TTL_SECONDS == 300


def test_the_model_never_gets_the_id_or_the_message_back():
    out = call({"profile": "writer", "message": "secret-ish words"})
    blob = json.dumps(out)
    assert only_id() not in blob and "secret-ish words" not in blob
    assert out["proposal_ref"].startswith("pa-")


@pytest.mark.parametrize(
    "args,code",
    [
        ({"profile": "nobody", "message": "hi"}, "unknown_profile"),
        ({"profile": "../writer", "message": "hi"}, "bad_profile"),
        ({"profile": "wri ter", "message": "hi"}, "bad_profile"),
        ({"profile": "", "message": "hi"}, "bad_profile"),
        ({"profile": None, "message": "hi"}, "bad_profile"),
        ({"profile": "writer", "message": "   "}, "bad_message"),
        ({"profile": "writer", "message": "​‮"}, "bad_message"),
        ({"profile": "writer", "message": 5}, "bad_message"),
        ({"profile": "writer", "message": "x" * 4001}, "message_too_long"),
        ({"profile": "writer", "message": "\n".join(["l"] * 41)}, "message_too_long"),
    ],
)
def test_refusals_have_fixed_codes_and_register_nothing(args, code):
    out = call(args)
    assert out == {"status": "refused", "code": code, "executed": False}
    assert asks.list_views() == []


def test_the_default_profile_is_a_target_from_another_profile(hermes_home, monkeypatch):
    # This process serves the profile "writer": the default profile is somebody else.
    monkeypatch.setenv("HERMES_HOME", str(hermes_home / "profiles" / "writer"))
    assert call({"profile": "default", "message": "hello"})["status"] == "awaiting_click"


def test_hidden_characters_are_cleaned_before_the_card_so_the_card_is_what_is_sent():
    call({"profile": "writer", "message": "hel​lo‮ there"})
    assert asks.list_views()[0]["message"] == asks.with_provenance("hello there")


def test_release_returns_the_exact_text_once_and_then_refuses():
    call({"profile": "coder", "message": "Review the plan.\nBe brief."})
    pid = only_id()
    first = asks.release(pid)
    assert first == {"ask": {"profile": "coder", "message": asks.with_provenance("Review the plan.\nBe brief.")}}
    again = asks.release(pid)
    assert again["error"] == "already_used"
    view = asks.get_view(pid)
    assert view["state"] == "released" and view["message"] == ""  # the text is not kept after use


def test_deny_wipes_the_text_and_blocks_release():
    call({"profile": "coder", "message": "do it"})
    pid = only_id()
    assert asks.deny(pid)["ask"]["state"] == "denied"
    assert asks.get_view(pid)["message"] == ""
    assert asks.release(pid)["error"] == "already_used"


def test_expiry_wipes_the_text_and_blocks_release():
    call({"profile": "coder", "message": "do it"})
    pid = only_id()
    later = time.time() + asks.TTL_SECONDS + 1
    assert asks.get_view(pid, now=later)["state"] == "expired"
    assert asks.release(pid, now=later)["error"] == "already_used"


@pytest.mark.parametrize("bad", [None, 5, "", "short", "x" * 100, "../../etc"])
def test_forged_ids_are_unknown(bad):
    assert asks.release(bad)["error"] == "unknown_proposal"
    assert asks.deny(bad)["error"] == "unknown_proposal"


def test_double_release_from_threads_releases_exactly_once():
    call({"profile": "coder", "message": "do it"})
    pid = only_id()
    results = []
    gate = threading.Barrier(8)

    def go():
        gate.wait()
        results.append(asks.release(pid))

    threads = [threading.Thread(target=go) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sum(1 for r in results if "ask" in r and "error" not in r) == 1


def test_pending_cap():
    for i in range(asks.MAX_PENDING):
        assert call({"profile": "writer", "message": f"m{i}"})["status"] == "awaiting_click"
    assert call({"profile": "writer", "message": "one more"})["code"] == "too_many_pending"


def test_refuses_without_the_api_in_this_process():
    proposals.mark_api_ready(False)
    assert call({"profile": "writer", "message": "hi"}) == {"status": "refused", "code": "ui_unavailable", "executed": False}


def test_view_marks_text_as_untrusted_and_has_no_secret_fields():
    call({"profile": "writer", "message": "hi"})
    view = asks.list_views()[0]
    assert "message" in view["untrusted_fields"]
    assert set(view) >= {"id", "label", "profile", "message", "state", "remaining_s", "untrusted_fields"}


def test_schema_tells_the_model_it_cannot_send_or_read_the_reply():
    desc = schemas.ASK_PROFILE["description"]
    assert "does NOT send" in desc and "click" in desc and "own tools" in desc
    assert schemas.ASK_PROFILE["parameters"]["required"] == ["profile", "message"]


def test_the_module_cannot_start_a_program():
    text = Path(asks.__file__).read_text(encoding="utf-8")
    for word in ("subprocess", "os.system", "Popen", "runner"):
        assert word not in text
