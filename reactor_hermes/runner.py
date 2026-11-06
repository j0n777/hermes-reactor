"""The ONLY module of this plugin that starts a program.

Everything that reaches this point has already been validated by :mod:`reactor_hermes.continuation` and has been
released by a person's click (see :mod:`reactor_hermes.proposals`). The rules, each one tested:

- an argument list and ``shell=False``: no shell ever sees the instruction or any path;
- the instruction travels on standard input and nowhere else;
- the working folder is the session's own folder;
- the environment is a small allowlist (enough for the CLI to find its own login). Hermes' keys, and anything else in
  the parent's environment, are not passed on;
- a timeout, a cancel switch and a cap on the output kept in memory (the tail) and on the output read at all;
- the whole process tree is stopped on cancel, timeout or when the run ends (a Windows job object, or a process
  group on POSIX), so nothing the agent started is left running unattended;
- no flag that skips permissions or approvals is ever added: the agent runs under its own permission settings.

Nothing is written to disk and nothing is logged here except fixed codes and counts.
"""

from __future__ import annotations

import logging
import os
import re
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable, Mapping, Optional

from .continuation import trusted_executable

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 20 * 60
OUTPUT_KEEP_BYTES = 64 * 1024  # the tail that is kept
OUTPUT_HARD_LIMIT_BYTES = 32 * 1024 * 1024  # more than this and the run is stopped
POLL_SECONDS = 0.05

# Names (upper case) copied from the parent environment. Enough for Claude Code and Codex to start and to find their
# own saved login in the user's profile. Deliberately NOT here: anything named HERMES_*, API keys, tokens, secrets,
# proxies with credentials, cloud credentials.
ENV_ALLOWLIST = frozenset(
    {
        "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
        "TEMP", "TMP", "TMPDIR",
        "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
        "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
        "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
        "USERNAME", "USERDOMAIN", "COMPUTERNAME", "USER", "LOGNAME",
        "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
        "LANG", "LC_ALL", "LC_CTYPE",
        "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
        "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_CODE_GIT_BASH_PATH",
        "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
    }
)
_FIXED_ENV = {"NO_COLOR": "1", "TERM": "dumb", "CI": "1"}

_ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")


def clean_path(value: str) -> str:
    """PATH without empty and relative entries.

    An empty entry or ``.`` means "the current folder" and the current folder is the session folder, which is
    untrusted content: a program planted there would win the search. Only absolute entries are kept.
    """
    kept = []
    for part in value.split(os.pathsep):
        entry = part.strip().strip('"')
        if entry and os.path.isabs(entry):
            kept.append(part.strip())
    return os.pathsep.join(kept)


def child_env(environ: Optional[Mapping[str, str]] = None) -> dict:
    """The environment the agent gets: the allowlist above plus a few fixed values."""
    source = os.environ if environ is None else environ
    env = {}
    for key, value in source.items():
        if isinstance(key, str) and isinstance(value, str) and key.upper() in ENV_ALLOWLIST and "\x00" not in value:
            env[key] = clean_path(value) if key.upper() == "PATH" else value
    env.update(_FIXED_ENV)
    return env


def decode_output(raw: bytes) -> str:
    """Untrusted agent output as plain printable text: UTF-8 with replacement, ANSI sequences removed."""
    text = raw.decode("utf-8", "replace")
    return _ANSI_RE.sub("", text)


@dataclass
class RunResult:
    outcome: str  # finished | failed | cancelled | timeout | output_limit | spawn_failed
    exit_code: Optional[int]
    output: bytes  # the tail, at most OUTPUT_KEEP_BYTES
    truncated: bool
    total_bytes: int
    seconds: float


# --- process tree ------------------------------------------------------------------------------------------------------


class _Tree:
    """Stops a process and everything it started."""

    def __init__(self, proc: subprocess.Popen):
        self.proc = proc
        self.job = None
        if os.name == "nt":
            self.job = _windows_job_for(proc)

    def kill(self) -> None:
        if os.name == "nt":
            # taskkill /T first, while the parent is still alive: it walks parent links, so it also reaches a
            # grandchild that started before the job object was attached (a race at the very start of a run).
            # Then the job: it takes everything that is inside it, whatever the parent links say.
            _windows_taskkill(self.proc.pid)
            if self.job is not None:
                _windows_terminate_job(self.job)
            return
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    def close(self) -> None:
        """The run is over: stop anything it left behind and release the handle."""
        if os.name == "nt":
            if self.job is not None:
                _windows_close_job(self.job)
                self.job = None
        else:
            self.kill()


def _windows_taskkill(pid: int) -> None:
    root = os.environ.get("SystemRoot") or r"C:\Windows"
    exe = os.path.join(root, "System32", "taskkill.exe")
    try:
        subprocess.run(
            [exe, "/PID", str(int(pid)), "/T", "/F"],
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as exc:
        logger.warning("reactor runner: taskkill failed: %s", type(exc).__name__)


def _windows_job_for(proc: subprocess.Popen):
    """A job object that kills its processes when closed, with ``proc`` in it. None when it cannot be made."""
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class BASIC(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IOC(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("a", "b", "c", "d", "e", "f")]

        class EXT(ctypes.Structure):
            _fields_ = [
                ("Basic", BASIC),
                ("Io", IOC),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k32.SetInformationJobObject.restype = wintypes.BOOL
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k32.AssignProcessToJobObject.restype = wintypes.BOOL
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]

        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = EXT()
        info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(job)
            return None
        if not k32.AssignProcessToJobObject(job, int(proc._handle)):  # noqa: SLF001 (the Popen handle is the only way)
            k32.CloseHandle(job)
            return None
        return job
    except Exception as exc:
        logger.warning("reactor runner: no job object: %s", type(exc).__name__)
        return None


def _windows_terminate_job(job) -> bool:
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.TerminateJobObject.restype = wintypes.BOOL
        k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        return bool(k32.TerminateJobObject(job, 1))
    except Exception:
        return False


def _windows_close_job(job) -> None:
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.CloseHandle(job)
    except Exception:
        pass


# --- the run -----------------------------------------------------------------------------------------------------------


def run_program(
    argv: tuple,
    *,
    cwd: str,
    stdin: bytes,
    env: Mapping[str, str],
    timeout: float = TIMEOUT_SECONDS,
    cancel: Optional[threading.Event] = None,
    keep_bytes: int = OUTPUT_KEEP_BYTES,
    hard_limit: int = OUTPUT_HARD_LIMIT_BYTES,
    on_started: Optional[Callable[[], None]] = None,
) -> RunResult:
    """Run ``argv`` (a tuple of strings, never a shell string) and wait for it. Never raises."""
    started = time.monotonic()
    cancel = cancel or threading.Event()
    if os.environ.get("PYTEST_CURRENT_TEST") and argv and os.path.basename(str(argv[0])).lower().startswith(("claude", "codex")):
        # Safety net for the test suite: a test must never start a real claude or codex.
        logger.error("reactor runner: refused to start a real CLI under pytest")
        return RunResult("spawn_failed", None, b"", False, 0, 0.0)
    if cancel.is_set():
        return RunResult("cancelled", None, b"", False, 0, 0.0)
    # The program itself is checked here too, not only when the plan was built: an absolute path to a file that exists
    # now (symlinks resolved) and is not inside the session folder. A bare or relative name would be searched for in
    # the session folder first on Windows.
    if not argv or not trusted_executable(str(argv[0]), cwd):
        logger.info("reactor runner: program is not an absolute path to an existing file outside the session folder")
        return RunResult("spawn_failed", None, b"", False, 0, 0.0)
    flags = 0
    extra: dict = {}
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        extra["start_new_session"] = True
    try:
        proc = subprocess.Popen(
            list(argv),
            shell=False,
            cwd=cwd,
            env=dict(env),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=flags,
            close_fds=True,
            **extra,
        )
    except Exception as exc:
        logger.info("reactor runner: spawn failed (%s)", type(exc).__name__)
        return RunResult("spawn_failed", None, b"", False, 0, time.monotonic() - started)

    tree = _Tree(proc)
    state = {"total": 0, "limit": False}
    chunks: list = []
    kept = {"n": 0}
    lock = threading.Lock()

    def reader() -> None:
        try:
            while True:
                data = proc.stdout.read(8192)
                if not data:
                    break
                with lock:
                    state["total"] += len(data)
                    chunks.append(data)
                    kept["n"] += len(data)
                    while kept["n"] - len(chunks[0]) >= keep_bytes and len(chunks) > 1:
                        kept["n"] -= len(chunks.pop(0))
                    if state["total"] > hard_limit:
                        state["limit"] = True
                        return
        except (OSError, ValueError):
            return

    def writer() -> None:
        try:
            view = memoryview(stdin)
            for i in range(0, len(view), 8192):
                proc.stdin.write(view[i : i + 8192])
            proc.stdin.flush()
        except (OSError, ValueError):
            pass
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    t_read = threading.Thread(target=reader, name="reactor-run-out", daemon=True)
    t_write = threading.Thread(target=writer, name="reactor-run-in", daemon=True)
    t_read.start()
    t_write.start()
    if on_started:
        try:
            on_started()
        except Exception:
            pass

    outcome = None
    while proc.poll() is None:
        if cancel.is_set():
            outcome = "cancelled"
        elif state["limit"]:
            outcome = "output_limit"
        elif time.monotonic() - started > timeout:
            outcome = "timeout"
        if outcome:
            tree.kill()
            break
        time.sleep(POLL_SECONDS)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        tree.kill()
    code = proc.poll()
    tree.close()  # stops anything the agent left running and releases the job
    t_read.join(timeout=3)
    t_write.join(timeout=1)
    for stream in (proc.stdout, proc.stdin):
        try:
            if stream:
                stream.close()
        except OSError:
            pass

    with lock:
        raw = b"".join(chunks)
        total = state["total"]
    truncated = total > len(raw) or len(raw) > keep_bytes
    if len(raw) > keep_bytes:
        raw = raw[-keep_bytes:]
    if outcome is None:
        outcome = "finished" if code == 0 else "failed"
    return RunResult(outcome, code, raw, truncated, total, time.monotonic() - started)
