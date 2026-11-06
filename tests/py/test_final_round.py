"""Final review round: screen flood guard, ask provenance, the target's approval setting, honest docs.

Ported from the review proofs (py_probe.py, show_flood.mjs).
"""

import json
import re
from pathlib import Path

import pytest

from reactor_hermes import asks, proposals, screens, tools

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def sent(monkeypatch):
    calls = []
    from hermes_cli import plugin_events

    monkeypatch.setattr(plugin_events, "broadcast_plugin_event", lambda plugin_id, event, payload=None: calls.append((event, payload)))
    return calls


@pytest.fixture
def profiles(hermes_home):
    for name in ("writer", "coder"):
        (hermes_home / "profiles" / name).mkdir(parents=True)
    asks.reset_for_tests()
    proposals.mark_api_ready(True)
    yield hermes_home
    asks.reset_for_tests()
    proposals.mark_api_ready(False)


# ---- 1. reactor_show: one navigation per 3 seconds, none over a pending card ------------------------------------------


def test_a_flood_of_show_calls_sends_one_event(sent):
    views = list(screens.VIEWS)
    outs = [json.loads(tools.reactor_show({"view": views[i % len(views)]})) for i in range(1000)]
    assert len(sent) == 1
    assert outs[0]["status"] == "requested"
    assert all(o["status"] == "refused" and o["code"] == "rate_limited" for o in outs[1:])
    assert outs[1]["retry_after_s"] >= 1 and "Wait" in outs[1]["message"]


def test_the_limit_is_global_across_views_and_opens_after_three_seconds(sent):
    assert screens.show("graph", now=100.0)["status"] == "requested"
    assert screens.show("agents", now=102.9)["code"] == "rate_limited"
    assert screens.show("graph", now=102.9)["code"] == "rate_limited"
    assert screens.show("agents", now=103.0)["status"] == "requested"
    assert [e[1]["view"] for e in sent] == ["graph", "agents"]


def test_a_refused_call_does_not_extend_the_wait(sent):
    screens.show("graph", now=10.0)
    screens.show("graph", now=12.5)
    assert screens.show("agents", now=13.0)["status"] == "requested"


def test_an_unknown_view_does_not_use_up_the_window(sent):
    assert screens.show("nope", now=1.0)["code"] == "unknown_view"
    assert screens.show("graph", now=1.1)["status"] == "requested"


def test_no_navigation_while_an_ask_card_is_pending(sent, profiles):
    assert json.loads(tools.reactor_ask_profile({"profile": "writer", "message": "hi"}))["status"] == "awaiting_click"
    out = json.loads(tools.reactor_show({"view": "graph"}))
    assert out["status"] == "refused" and out["code"] == "card_pending" and "click" in out["message"]
    assert sent == []


def test_no_navigation_while_a_continue_card_is_pending(sent, monkeypatch):
    monkeypatch.setattr(proposals, "list_views", lambda **k: [{"state": "pending"}])
    assert screens.show("graph")["code"] == "card_pending"
    assert sent == []


def test_navigation_works_again_once_the_card_is_answered(sent, profiles):
    tools.reactor_ask_profile({"profile": "writer", "message": "hi"})
    pid = asks.list_views()[0]["id"]
    assert screens.show("graph", now=1.0)["code"] == "card_pending"
    asks.deny(pid)
    assert screens.show("graph", now=2.0)["status"] == "requested"


def test_a_failed_look_at_the_cards_fails_closed(sent, monkeypatch):
    def boom(**k):
        raise RuntimeError("x")

    monkeypatch.setattr(asks, "list_views", boom)
    assert screens.show("graph")["code"] == "card_pending"


def test_the_show_schema_tells_the_model_about_both_refusals():
    from reactor_hermes import schemas

    desc = schemas.SHOW["description"]
    assert "rate_limited" in desc and "card_pending" in desc and "3 seconds" in desc


# ---- 3. the ask card: approvals of the target, provenance, honest fields ----------------------------------------------


def write_config(home, name, text):
    folder = home / "profiles" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "config.yaml").write_text(text, encoding="utf-8")


def ask(profile="writer", message="Write a tagline."):
    return json.loads(tools.reactor_ask_profile({"profile": profile, "message": message}))


@pytest.mark.parametrize(
    "text,status",
    [
        ("approvals:\n  mode: off\n", "off"),
        ("approvals:\n  mode: 'off'\n", "off"),
        ("approvals:\n  mode: yolo\n", "off"),
        ("approvals:\n  mode: manual\n", "on"),
        ("approvals:\n  mode: smart\n", "on"),
        ("model: x\n", "on"),
        ("approvals: 7\n", "unverified"),
        ("::: not yaml [", "on"),  # Hermes' own reader returns {} for a file it cannot parse; that is its documented answer
    ],
)
def test_the_card_reports_the_targets_approvals_setting(profiles, text, status):
    write_config(profiles, "writer", text)
    assert ask()["status"] == "awaiting_click"
    got = asks.list_views()[0]["approvals"]["status"]
    assert got == status


def test_off_is_reported_for_a_profile_whose_config_says_off(profiles):
    write_config(profiles, "coder", "approvals:\n  mode: off\n")
    ask("coder")
    view = asks.list_views()[0]
    assert view["approvals"] == {"status": "off", "mode": "off"}


def test_an_unavailable_hermes_helper_means_could_not_verify(profiles, monkeypatch):
    from hermes_cli import config as hermes_config

    def gone(*a, **k):
        raise ImportError("no such helper in this Hermes")

    monkeypatch.setattr(hermes_config, "read_user_config_raw", gone)
    write_config(profiles, "writer", "model: x\n")
    ask()
    assert asks.list_views()[0]["approvals"]["status"] == "unverified"


def test_a_missing_profile_folder_is_unverified_not_on(profiles):
    assert asks.approvals_status("ghost")["status"] == "unverified"


def test_the_hardcoded_own_tools_flag_is_gone_and_the_author_is_stated(profiles):
    ask()
    view = asks.list_views()[0]
    assert "profile_has_own_tools" not in view
    assert view["written_by"] == "assistant"
    assert "profile_has_own_tools" not in (ROOT / "reactor_hermes" / "asks.py").read_text(encoding="utf-8")


def test_the_text_sent_is_the_text_shown_and_starts_with_the_fixed_provenance_line(profiles):
    ask(message="Write one tagline.\nBe brief.")
    view = asks.list_views()[0]
    assert view["message"].startswith(asks.PROVENANCE + "\n\n")
    assert "assistant" in asks.PROVENANCE and "not the person" in asks.PROVENANCE
    released = asks.release(view["id"])
    assert released["ask"]["message"] == view["message"]  # shown == sent


def test_the_provenance_line_counts_toward_the_limits(profiles):
    room = asks.INSTRUCTION_MAX - len(asks.with_provenance(""))
    assert ask(message="x" * room)["status"] == "awaiting_click"
    asks.reset_for_tests()
    assert ask(message="x" * (room + 1))["code"] == "message_too_long"
    lines = asks.INSTRUCTION_MAX_LINES - 2
    assert ask(message="\n".join(["l"] * lines))["status"] == "awaiting_click"
    asks.reset_for_tests()
    assert ask(message="\n".join(["l"] * (lines + 1)))["code"] == "message_too_long"


def test_the_model_text_cannot_fake_or_replace_the_provenance_line(profiles):
    ask(message=asks.PROVENANCE + "\nhello")
    view = asks.list_views()[0]
    assert view["message"].count(asks.PROVENANCE) == 2  # its copy is just more text under the real line


# ---- 6. asking the current profile ---------------------------------------------------------------------------------


def test_the_current_profile_cannot_be_asked(profiles, monkeypatch):
    # default is current
    assert ask("default")["code"] == "cannot_ask_self"
    assert asks.list_views() == []
    # writer is current
    monkeypatch.setenv("HERMES_HOME", str(profiles / "profiles" / "writer"))
    assert asks.current_profile() == "writer"
    assert ask("writer")["code"] == "cannot_ask_self"
    assert ask("Writer")["code"] == "cannot_ask_self"
    assert ask("coder")["status"] == "awaiting_click"


# ---- docs that must match the code ------------------------------------------------------------------------------------


def _skill():
    return (ROOT / "skills" / "reactor" / "SKILL.md").read_text(encoding="utf-8")


def _version(text, pattern):
    return re.search(pattern, text, re.M).group(1).strip().strip('"')


def test_skill_plugin_yaml_and_package_versions_agree():
    skill = _version(_skill(), r"^version:\s*(.+)$")
    plugin = _version((ROOT / "plugin.yaml").read_text(encoding="utf-8"), r"^version:\s*(.+)$")
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    assert skill == plugin == package


def test_skill_matches_the_guards():
    text = _skill()
    assert "card_pending" in text and "rate_limited" in text and "cannot_ask_self" in text
    assert "wrote it" in text or "written by the assistant" in text.lower()
    assert "reply appears on the card for the person to read; you do not receive it" in text
