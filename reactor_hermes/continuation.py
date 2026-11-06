"""Continuing a Claude Code or Codex session: validation and the process plan. Nothing here starts a program.

The plan is an argument list plus the instruction for standard input (never a shell string). It is built twice: once
when the tool registers a proposal (so a bad request is refused early) and again, from a fresh look at the session,
at the moment a person clicks Run (see :mod:`reactor_hermes.proposals`). The program itself is started only by
:mod:`reactor_hermes.runner`.

Why a click and not a Hermes approval: the one public way for a plugin to require a Hermes approval is a
``pre_tool_call`` hook returning ``{"action": "approve"}``, and the gate behind it returns "approved" without asking
whenever YOLO is on, ``approvals.mode`` is ``off`` or the user once answered "session" or "always". The Reactor rule is
that a person releases every continue, so Reactor uses its own click. See README, "Approval finding".
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass
from typing import Callable, Optional

from .sessions import SESSION_ID_RE, SessionRec
from .text import clean_multiline

ACTIVE_WINDOW_SECONDS = 120
# The card must show the WHOLE instruction, so these two limits are what the card can show without clipping. Over
# either one the request is refused (`instruction_too_long`); nothing is ever cut silently. Keep in step with
# INSTRUCTION_MAX_CHARS / INSTRUCTION_MAX_LINES in src/model/proposals.js.
INSTRUCTION_MAX = 4000
INSTRUCTION_MAX_LINES = 40
PREVIEW_MAX = 160


class ContinueError(Exception):
    """A refusal with a fixed code. Never carries the instruction or a command."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Plan:
    argv: tuple  # program first; every later element is fixed text or the validated session id
    cwd: str
    stdin: bytes  # the instruction, delivered through the standard input and nowhere else
    shell: bool = False  # always False: no shell ever sees any of this


def _test_cli_override(agent: str) -> Optional[tuple]:
    """A stand-in program for tests. Honoured ONLY while pytest is running a test; a normal run ignores the variable.

    ``REACTOR_TEST_CLI`` names a Python script (or an executable). A script is started with the current interpreter.
    """
    if not os.environ.get("PYTEST_CURRENT_TEST") or "pytest" not in sys.modules:
        return None
    path = os.environ.get("REACTOR_TEST_CLI", "").strip()
    if not path:
        return None
    if path.lower().endswith(".py"):
        return (sys.executable, path)
    return (path,)


def _inside(path: str, folder: str) -> bool:
    a = os.path.normcase(os.path.realpath(path))
    b = os.path.normcase(os.path.realpath(folder))
    try:
        return os.path.commonpath([a, b]) == b
    except ValueError:  # another drive
        return False


def trusted_executable(path: object, cwd: object) -> Optional[str]:
    """The program path when it can be trusted to be what the user installed, else None.

    Absolute (never relative: on Windows ``shutil.which`` may return a hit from the current folder), it must exist as
    a file once symlinks are resolved, and neither the path nor its target may be inside the session folder, which
    is untrusted content (a repository can plant a ``claude.cmd`` in it).
    """
    if not isinstance(path, str) or not path or "\x00" in path or not os.path.isabs(path):
        return None
    try:
        real = os.path.realpath(path)
        if not os.path.isfile(real):
            return None
        if isinstance(cwd, str) and cwd and (_inside(path, cwd) or _inside(real, cwd)):
            return None
    except (OSError, ValueError):
        return None
    return os.path.normpath(path)


def _executable(agent: str, which: Callable[[str], Optional[str]], cwd: str) -> tuple:
    override = _test_cli_override(agent)
    if override:
        return override
    name = "claude" if agent == "claude" else "codex"
    exe = trusted_executable(which(name), cwd)
    if not exe:
        raise ContinueError("cli_missing")
    return (exe,)


def build_plan(
    rec: SessionRec,
    instruction: object,
    *,
    which: Optional[Callable[[str], Optional[str]]] = None,
    now: Optional[float] = None,
) -> Plan:
    """Validate and build the process plan, or raise :class:`ContinueError`.

    Non-interactive forms, taken from the tools' own help:
    - Claude Code: ``claude -p --resume=<session-id>`` with the prompt on stdin (``claude --help``: ``-p, --print``
      "Print response and exit (useful for pipes)", ``-r, --resume [value]`` "Resume a conversation by session ID").
    - Codex: ``codex exec resume <session-id> -`` where ``-`` makes ``codex exec`` read the prompt from stdin.
      Not verified here (Codex is not installed on this machine); the README marks it as unverified.
    No flag that skips permissions or approvals is ever added: the agent runs under its own permission settings.
    """
    if not rec.session_id or not SESSION_ID_RE.match(rec.session_id):
        raise ContinueError("bad_session_id")
    cwd = rec.cwd
    if not cwd or not isinstance(cwd, str) or "\x00" in cwd or not os.path.isdir(cwd):
        raise ContinueError("folder_missing")
    if (time.time() if now is None else now) - rec.mtime < ACTIVE_WINDOW_SECONDS:
        raise ContinueError("active_elsewhere")
    text = clean_multiline(instruction, 0)  # no cap here: a text that is too long is refused below, never cut
    if not text:
        raise ContinueError("bad_instruction")
    if len(text) > INSTRUCTION_MAX or text.count("\n") + 1 > INSTRUCTION_MAX_LINES:
        raise ContinueError("instruction_too_long")
    exe = _executable(rec.agent, which or shutil.which, cwd)
    sid = rec.session_id.lower()
    if rec.agent == "claude":
        argv = (*exe, "-p", f"--resume={sid}")
    else:
        argv = (*exe, "exec", "resume", sid, "-")
    return Plan(argv=argv, cwd=cwd, stdin=text.encode("utf-8"))


def folder_identity(cwd: str) -> Optional[tuple]:
    """Who this folder really is right now: ``(resolved path, device, file id)``, or None if it cannot be read.

    A plain tuple on purpose: the tool and the API run from two copies of this module, and tuples compare across
    copies (instances of two copies of one class do not). Used to notice a swap (junction, symlink, another folder).
    """
    try:
        real = os.path.normcase(os.path.realpath(cwd))
        st = os.stat(real)
        return (real, int(st.st_dev), int(st.st_ino))
    except (OSError, ValueError):
        return None


# --- project hooks ---------------------------------------------------------------------------------------------------

_HOOK_FILE_RE = re.compile(r"\Asettings[A-Za-z0-9._-]{0,40}\.json\Z")
_HOOK_FILE_MAX_BYTES = 256 * 1024
_HOOK_FILES_MAX = 4


def project_hooks(cwd: object) -> list:
    """Names of the project settings files in ``<folder>/.claude`` that define ``hooks``. Read only; names, never values.

    ``claude -p`` skips Claude Code's trust dialog, so hooks in the folder's settings take effect when the session
    starts, and the folder is untrusted content. A file that cannot be read as JSON, or is too big to read, is reported
    when its text mentions ``"hooks"`` (or always, when too big): when in doubt, warn.
    """
    if not isinstance(cwd, str) or not cwd or "\x00" in cwd:
        return []
    base = os.path.join(cwd, ".claude")
    found = []
    try:
        with os.scandir(base) as it:
            entries = sorted((e for e in it if _HOOK_FILE_RE.match(e.name)), key=lambda e: e.name)
    except OSError:
        return []
    for entry in entries[:50]:
        try:
            if not entry.is_file(follow_symlinks=False):
                continue
            with open(entry.path, "rb") as fh:
                data = fh.read(_HOOK_FILE_MAX_BYTES + 1)
        except OSError:
            continue
        if len(data) > _HOOK_FILE_MAX_BYTES:
            has = True
        else:
            try:
                obj = json.loads(data.decode("utf-8", "replace"))
                has = isinstance(obj, dict) and "hooks" in obj
            except ValueError:
                has = b'"hooks"' in data
        if has:
            found.append(".claude/" + entry.name)
        if len(found) >= _HOOK_FILES_MAX:
            break
    return found
