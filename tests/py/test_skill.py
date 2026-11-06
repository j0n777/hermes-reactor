"""The persona skill: it must describe every tool, say that actions need a click, and never mention a trademark preset."""

from pathlib import Path

from reactor_hermes import schemas, screens

SKILL = (Path(__file__).resolve().parents[2] / "skills" / "reactor" / "SKILL.md").read_text(encoding="utf-8")


def test_every_tool_is_described():
    for schema in schemas.ALL:
        assert f"`{schema['name']}" in SKILL, schema["name"]


def test_every_view_is_listed():
    for view in screens.VIEWS:
        assert f"`{view}`" in SKILL, view


def test_it_says_actions_need_a_click_and_nothing_is_sent_before():
    low = SKILL.lower()
    assert "click" in low and "nothing has been sent yet" in low
    assert "cannot click" in low or "you cannot click" in low


def test_it_documents_the_default_wake_phrase_and_the_custom_one():
    assert "hey hermes" in SKILL and "--wake-phrase" in SKILL


def test_it_asks_for_brief_spoken_replies_in_the_users_language():
    low = SKILL.lower()
    assert "short sentences" in low and "language" in low


def test_no_third_party_trademark():
    assert "jarvis" not in SKILL.lower()
