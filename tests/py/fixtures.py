"""Builders for fake Claude Code and Codex session logs. Fixtures only: never the real Claude or Codex folders."""

import json
import os
from pathlib import Path

CLAUDE_ID = "11111111-2222-3333-4444-555555555555"
CLAUDE_ID2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
CODEX_ID = "99999999-8888-7777-6666-555555555555"


def write_lines(path: Path, objs, mtime=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(o) for o in objs) + "\n", encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def make_claude(root: Path, session_id, cwd, user, assistant, mtime, project="proj", stem=None):
    """root is the `projects` directory (what Hermes expects as claude_root)."""
    objs = [
        {"type": "user", "sessionId": session_id, "cwd": str(cwd), "message": {"role": "user", "content": user}},
        {
            "type": "assistant",
            "sessionId": session_id,
            "cwd": str(cwd),
            "message": {"role": "assistant", "content": [{"type": "text", "text": assistant}]},
        },
    ]
    write_lines(root / project / f"{stem or session_id}.jsonl", objs, mtime)


def make_codex(root: Path, session_id, cwd, user, assistant, mtime):
    """root is the `sessions` directory (what Hermes expects as codex_root)."""
    objs = [
        {"type": "session_meta", "payload": {"id": session_id, "cwd": str(cwd)}},
        {
            "type": "response_item",
            "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": user}]},
        },
        {
            "type": "response_item",
            "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": assistant}]},
        },
    ]
    write_lines(root / "2026" / "11" / "01" / f"rollout-2026-11-01T10-00-00-{session_id}.jsonl", objs, mtime)
