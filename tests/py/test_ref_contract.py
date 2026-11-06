"""The `ref` of a session must be the first 12 hex digits of the id Hermes Desktop shows for the same row.

Desktop rows come from `session.foreign.list`, whose id is `sha256(f"{source}:{path}")` (hermes_cli/foreign_sessions_browser.py).
`::reactor-session{ref="..."}` cards match a Desktop row by that prefix, so both sides must hash the same text.
"""

import hashlib
import json
import time
from pathlib import Path

import pytest

from reactor_hermes import sessions
from fixtures import CLAUDE_ID, CLAUDE_ID2, CODEX_ID, make_claude, make_codex

VECTORS = Path(__file__).resolve().parents[1] / "shared" / "ref-vectors.json"


def expected_ref(agent, path):
    return hashlib.sha256(f"{agent}:{path}".encode()).hexdigest()[:12]


def test_make_ref_is_the_desktop_prefix():
    win = r"C:\x\a.jsonl"
    assert sessions._make_ref("claude", CLAUDE_ID, win) == expected_ref("claude", win)
    # The session id does not take part: two paths, one session id, two refs (as in Desktop).
    assert sessions._make_ref("codex", None, "/a/b.jsonl") == expected_ref("codex", "/a/b.jsonl")
    assert sessions._make_ref("claude", CLAUDE_ID, "/p1") != sessions._make_ref("claude", CLAUDE_ID, "/p2")


def test_shared_vectors_hold():
    """The same vectors are read by tests/js/ref-contract.test.js."""
    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    assert len(data["vectors"]) >= 3
    for v in data["vectors"]:
        digest = hashlib.sha256(f"{v['agent']}:{v['path']}".encode()).hexdigest()
        assert v["id"] == digest
        assert v["ref"] == digest[:12]
        assert sessions._make_ref(v["agent"], v.get("session_id"), v["path"]) == v["ref"]


def test_scan_refs_match_hermes_own_desktop_listing(tmp_path):
    """Same fixture, both sides: the plugin's scan() and Hermes' own `list_foreign_sessions()` (the Desktop RPC)."""
    browser = pytest.importorskip("hermes_cli.foreign_sessions_browser")
    import os

    claude_root = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects"
    codex_root = Path(os.environ["CODEX_HOME"]) / "sessions"
    work = tmp_path / "work"
    work.mkdir()
    now = time.time()
    make_claude(claude_root, CLAUDE_ID, work, "fix the auth bug", "ok", now - 3600)
    make_claude(claude_root, CLAUDE_ID2, work, "write the docs", "ok", now - 4000, project="other")
    make_codex(codex_root, CODEX_ID, work, "write tests", "ok", now - 7200)

    desktop_rows = browser.list_foreign_sessions(None, 0, 50)["sessions"]
    assert len(desktop_rows) == 3
    mine, status = sessions.scan(claude_root=None, codex_root=None)
    assert status == "ok" and len(mine) == 3
    desktop_ids = {r["id"] for r in desktop_rows}
    for rec in mine:
        matches = [i for i in desktop_ids if i.startswith(rec.ref)]
        assert len(matches) == 1, (rec.agent, rec.path)
        assert matches[0] == hashlib.sha256(f"{rec.agent}:{rec.path}".encode()).hexdigest()
