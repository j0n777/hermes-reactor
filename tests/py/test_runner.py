"""The runner: the one module allowed to start a program. Everything runs against tests/py/fake_cli.py."""

import ast
import json
import sys
import threading
from pathlib import Path

import pytest

from reactor_hermes import runner
from procs import alive, wait_for

HERE = Path(__file__).resolve().parent
FAKE = str(HERE / "fake_cli.py")
PKG = Path(runner.__file__).resolve().parent


def go(instruction, *, args=("-p", "--resume=abc"), cwd=None, env=None, tmp_path=None, **kw):
    return runner.run_program(
        (sys.executable, FAKE, *args),
        cwd=str(cwd or tmp_path or HERE),
        stdin=instruction.encode("utf-8") if isinstance(instruction, str) else instruction,
        env=env if env is not None else runner.child_env(),
        **kw,
    )


ADVERSARIAL = [
    "ECHO\nit's \"quoted\" `backtick` $(sub) %PATH% ${HOME}",
    "ECHO\na & b && c | d || e ; f > g < h",
    "ECHO\npowershell -Command \"Remove-Item -Recurse C:\\\" ^& calc",
    "ECHO\n--dangerously-skip-permissions --yolo -p --resume=other",
    "ECHO\nline\r\nbreaks\n; rm -rf /\n" + "x" * 100_000,
    "ECHO\n\u00e7\u00e3o \u4e2d\u6587 \U0001f600",
]


@pytest.mark.parametrize("text", ADVERSARIAL, ids=[f"adv{i}" for i in range(len(ADVERSARIAL))])
def test_instruction_arrives_on_stdin_only_and_argv_is_untouched(tmp_path, text):
    res = go(text, tmp_path=tmp_path, keep_bytes=1_000_000)
    assert res.outcome == "finished" and res.exit_code == 0
    got = json.loads(res.output.decode("utf-8"))
    assert got["argv"] == ["-p", "--resume=abc"]
    assert got["stdin"] == text
    assert Path(got["cwd"]).resolve() == tmp_path.resolve()


def test_exit_code_decides_finished_or_failed(tmp_path):
    ok = go("EXIT 0", tmp_path=tmp_path)
    bad = go("EXIT 7", tmp_path=tmp_path)
    assert (ok.outcome, ok.exit_code) == ("finished", 0)
    assert (bad.outcome, bad.exit_code) == ("failed", 7)
    assert b"exiting" in bad.output


def test_missing_program_is_a_spawn_failure_not_an_exception(tmp_path):
    res = runner.run_program((str(tmp_path / "no-such-program"),), cwd=str(tmp_path), stdin=b"x", env={})
    assert res.outcome == "spawn_failed" and res.exit_code is None


def test_output_is_bounded_and_keeps_the_tail(tmp_path):
    res = go("FLOOD 3", tmp_path=tmp_path, keep_bytes=64 * 1024)
    assert res.outcome == "finished"
    assert len(res.output) <= 64 * 1024
    assert res.truncated is True
    assert res.total_bytes > 3 * 1024 * 1024
    assert res.output.rstrip().endswith(b"END-OF-FLOOD")


def test_runaway_output_is_stopped(tmp_path):
    res = go("FLOOD 30", tmp_path=tmp_path, hard_limit=2 * 1024 * 1024, timeout=60)
    assert res.outcome == "output_limit"
    assert len(res.output) <= runner.OUTPUT_KEEP_BYTES


def test_timeout_stops_the_process(tmp_path):
    res = go("SLEEP", tmp_path=tmp_path, timeout=0.6)
    assert res.outcome == "timeout"
    assert res.seconds < 20


def test_cancel_stops_the_process_and_is_not_a_failure(tmp_path):
    cancel = threading.Event()
    started = threading.Event()
    box = {}

    def work():
        box["res"] = go("SLEEP", tmp_path=tmp_path, cancel=cancel, on_started=started.set, timeout=60)

    t = threading.Thread(target=work)
    t.start()
    assert started.wait(10)
    cancel.set()
    t.join(20)
    assert not t.is_alive()
    assert box["res"].outcome == "cancelled"


def test_cancel_before_start_never_spawns(tmp_path):
    cancel = threading.Event()
    cancel.set()
    res = go("ECHO", tmp_path=tmp_path, cancel=cancel)
    assert res.outcome == "cancelled" and res.output == b"" and res.total_bytes == 0


def test_cancel_kills_the_whole_process_tree(tmp_path):
    """Parent and the grandchild it started are both gone after a cancel (a Windows job object, a process group elsewhere)."""
    pidfile = tmp_path / "pids.json"
    cancel = threading.Event()
    box = {}

    def work():
        box["res"] = go(f"TREE {pidfile}", tmp_path=tmp_path, cancel=cancel, timeout=60)

    t = threading.Thread(target=work)
    t.start()
    assert wait_for(lambda: pidfile.exists() and pidfile.stat().st_size > 0, 15)
    assert wait_for(lambda: bool(_pids(pidfile)), 5)
    pids = _pids(pidfile)
    assert alive(pids["parent"]) and alive(pids["child"])
    cancel.set()
    t.join(30)
    assert not t.is_alive()
    assert box["res"].outcome == "cancelled"
    assert wait_for(lambda: not alive(pids["parent"]) and not alive(pids["child"]), 10), pids


def test_timeout_kills_the_whole_process_tree(tmp_path):
    pidfile = tmp_path / "pids.json"
    res = go(f"TREE {pidfile}", tmp_path=tmp_path, timeout=3)
    assert res.outcome == "timeout"
    pids = _pids(pidfile)
    assert wait_for(lambda: not alive(pids["parent"]) and not alive(pids["child"]), 10), pids


def test_a_process_left_behind_is_stopped_when_the_run_ends(tmp_path):
    pidfile = tmp_path / "pids.json"
    res = go(f"ORPHAN {pidfile}", tmp_path=tmp_path)
    assert res.outcome == "finished"
    pids = _pids(pidfile)
    assert wait_for(lambda: not alive(pids["child"]), 10), pids


def _pids(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


# --- environment ----------------------------------------------------------------------------------------------------------


PLANTED = {
    "HERMES_API_KEY": "hermes-secret-111",
    "HERMES_HOME_TOKEN": "hermes-secret-222",
    "OPENAI_API_KEY": "sk-secret-333",
    "ANTHROPIC_API_KEY": "sk-ant-secret-444",
    "GITHUB_TOKEN": "ghp_secret555",
    "AWS_SECRET_ACCESS_KEY": "aws-secret-666",
    "HTTPS_PROXY": "http://user:proxy-secret-777@proxy.example:8080",
    "MY_PASSWORD": "pw-secret-888",
}


def test_child_env_is_an_allowlist(monkeypatch, tmp_path):
    for key, value in PLANTED.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/cfg")
    env = runner.child_env()
    assert not set(PLANTED) & set(k.upper() for k in env)
    blob = json.dumps(env)
    for value in PLANTED.values():
        assert value not in blob
    assert env["PATH"] == str(tmp_path) and env["CLAUDE_CONFIG_DIR"] == "/cfg"
    assert env["NO_COLOR"] == "1"
    assert all(k.upper() in runner.ENV_ALLOWLIST or k in ("NO_COLOR", "TERM", "CI") for k in env)


def test_planted_secrets_never_reach_the_child_process(tmp_path, monkeypatch):
    for key, value in PLANTED.items():
        monkeypatch.setenv(key, value)
    res = go("ENV", tmp_path=tmp_path, env=runner.child_env(), keep_bytes=1_000_000)
    assert res.outcome == "finished"
    seen = json.loads(res.output.decode("utf-8"))
    text = json.dumps(seen)
    for key, value in PLANTED.items():
        assert key not in {k.upper() for k in seen}
        assert value not in text
    assert any(k.upper() == "PATH" for k in seen)


def test_the_environment_given_is_the_environment_used(tmp_path):
    res = go("ENV", tmp_path=tmp_path, env={**runner.child_env(), "ONLY_HERE": "1"}, keep_bytes=100_000)
    assert json.loads(res.output.decode("utf-8"))["ONLY_HERE"] == "1"


def test_decode_output_strips_ansi_and_keeps_text(tmp_path):
    res = go("COLOR", tmp_path=tmp_path)
    text = runner.decode_output(res.output)
    assert "\x1b" not in text and "red" in text and "bell" in text


# --- the source rules ------------------------------------------------------------------------------------------------------


def package_sources():
    return {p.name: p.read_text(encoding="utf-8") for p in PKG.glob("*.py")}


def test_subprocess_exists_only_in_the_runner_module():
    needles = ("import subprocess", "from subprocess", "os.system", "os.popen", "os.exec", "os.spawn", "Popen(", "import pty", "multiprocessing")
    for name, src in package_sources().items():
        if name == "runner.py":
            continue
        for needle in needles:
            assert needle not in src, (name, needle)
    # The plugin entry points and the dashboard backend must not start programs either.
    for rel in ("__init__.py", "dashboard/plugin_api.py"):
        src = (PKG.parent / rel).read_text(encoding="utf-8")
        for needle in needles:
            assert needle not in src, (rel, needle)


def test_every_subprocess_call_is_shell_false():
    src = package_sources()["runner.py"]
    tree = ast.parse(src)
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
             and isinstance(n.func.value, ast.Name) and n.func.value.id == "subprocess" and n.func.attr in ("Popen", "run", "call", "check_output", "check_call")]
    assert len(calls) >= 2
    for call in calls:
        shell = [kw for kw in call.keywords if kw.arg == "shell"]
        assert len(shell) == 1 and isinstance(shell[0].value, ast.Constant) and shell[0].value.value is False
    for name, text in package_sources().items():
        assert "shell=True" not in text, name


FORBIDDEN_FLAGS = ("--dangerously-skip-permissions", "--yolo", "--full-auto", "--dangerously-bypass-approvals-and-sandbox",
                   "--permission-mode", "bypasspermissions", "--sandbox", "-y")


def test_no_permission_skipping_flag_exists_in_any_string_the_plugin_could_pass():
    for name, src in package_sources().items():
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) < 80:
                low = node.value.lower()
                for flag in FORBIDDEN_FLAGS:
                    assert low != flag and not low.startswith(flag + "="), (name, node.value)


@pytest.mark.skipif(sys.platform != "win32", reason="job objects are a Windows feature")
def test_windows_uses_a_job_object_for_the_tree_kill():
    import subprocess

    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        job = runner._windows_job_for(proc)
        assert job is not None
        assert runner._windows_terminate_job(job) is True
        assert wait_for(lambda: proc.poll() is not None, 10)
        runner._windows_close_job(job)
    finally:
        proc.kill()
