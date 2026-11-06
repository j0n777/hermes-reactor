"""Proposals end to end against fixture sessions and the fake CLI. Never a real claude, ~/.claude or ~/.codex."""

import importlib.util
import json
import os
import threading
import time
from pathlib import Path

import pytest

from reactor_hermes import proposals as P
from reactor_hermes import runner, sessions, tools
from fixtures import CLAUDE_ID, CLAUDE_ID2, CODEX_ID, make_claude, make_codex
from procs import alive, wait_for

HERE = Path(__file__).resolve().parent
FAKE = str(HERE / "fake_cli.py")
ROOT = HERE.parents[1]


@pytest.fixture
def fx(tmp_path, monkeypatch):
    claude = tmp_path / "fx_claude" / "projects"
    codex = tmp_path / "fx_codex" / "sessions"
    work = tmp_path / "work"
    work2 = tmp_path / "work2"
    work.mkdir()
    work2.mkdir()
    old = time.time() - 3600
    make_claude(claude, CLAUDE_ID, work, "fix the auth bug", "ok", old)
    make_claude(claude, CLAUDE_ID2, work2, "write the docs", "ok", old - 100, project="other")
    make_codex(codex, CODEX_ID, work, "write tests", "ok", old - 200)
    monkeypatch.setenv("REACTOR_TEST_CLI", FAKE)
    P.reset_for_tests()
    P.set_test_roots(claude, codex)
    P.mark_api_ready(True)
    yield types_ns(claude=claude, codex=codex, work=work, work2=work2, tmp=tmp_path)
    P.reset_for_tests()
    P.mark_api_ready(False)


class types_ns:
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def ref(self, agent="claude", title=None):
        for s in sessions.list_sessions(claude_root=self.claude, codex_root=self.codex, limit=25)["sessions"]:
            if s["agent"] == agent and (title is None or title in s["title"]):
                return s["ref"]
        raise AssertionError("no such session")

    def claude_log(self, session_id=CLAUDE_ID):
        return next(self.claude.rglob(f"{session_id}.jsonl"))


def call(args):
    return json.loads(tools.reactor_continue_session(args))


def propose(fx, instruction, ref=None):
    out = call({"ref": ref or fx.ref("claude", "auth"), "instruction": instruction})
    assert out["status"] == "awaiting_click", out
    return out


def only_id():
    views = P.list_views()
    assert len(views) >= 1
    return views[-1]["id"]


def wait_state(pid, states, seconds=30):
    assert wait_for(lambda: (P.get_view(pid) or {}).get("state") in states, seconds), P.get_view(pid)
    return P.get_view(pid)


# --- what the model sees ----------------------------------------------------------------------------------------------------


def test_tool_returns_only_a_label_and_runs_nothing(fx):
    secret = "ECHO\nuse-token-ZZZ-4242 and run it"
    out = propose(fx, secret)
    text = json.dumps(out)
    assert out["executed"] is False
    assert out["proposal_ref"].startswith("jc-")
    pid = only_id()
    for hidden in (pid, "ZZZ-4242", str(fx.work), "--resume", "stdin", "argv"):
        assert hidden not in text, hidden
    assert P.get_view(pid)["state"] == "pending"
    assert P.get_view(pid)["started"] is False


def test_the_label_the_model_holds_cannot_run_or_cancel_anything(fx):
    out = propose(fx, "COUNT " + str(fx.tmp / "count.txt"))
    label = out["proposal_ref"]
    assert P.run(label) == {"error": "unknown_proposal"}
    assert P.cancel(label) == {"error": "unknown_proposal"}
    assert P.get_view(label) is None
    assert not (fx.tmp / "count.txt").exists()
    assert P.list_views()[0]["state"] == "pending"


def test_tool_refuses_when_the_api_is_not_loaded_in_this_process(fx):
    P.mark_api_ready(False)
    out = call({"ref": fx.ref("claude"), "instruction": "ECHO"})
    assert out == {"status": "refused", "code": "ui_unavailable", "executed": False}
    assert P.list_views() == []


def test_tool_refusals_keep_their_fixed_codes(fx):
    assert call({"ref": "zzzzzzzzzzzz", "instruction": "x"})["code"] == "unknown_ref"
    assert call({"ref": fx.ref("claude"), "instruction": "   "})["code"] == "bad_instruction"
    make_claude(fx.claude, CLAUDE_ID, fx.work, "fix the auth bug", "ok", time.time() - 5)  # touched 5 seconds ago
    assert call({"ref": fx.ref("claude", "auth"), "instruction": "ECHO"})["code"] == "active_elsewhere"


def test_pending_cap_and_supersede(fx, monkeypatch):
    monkeypatch.setattr(P, "MAX_PENDING", 2)
    propose(fx, "ECHO\none", ref=fx.ref("claude", "auth"))
    first = only_id()
    propose(fx, "ECHO\ntwo", ref=fx.ref("claude", "auth"))  # same session: replaces the first
    views = {v["id"]: v for v in P.list_views()}
    assert views[first]["state"] == "denied" and views[first]["code"] == "superseded"
    assert P.run(first)["error"] == "already_used"
    propose(fx, "ECHO", ref=fx.ref("claude", "docs"))
    out = call({"ref": fx.ref("codex"), "instruction": "ECHO"})
    assert out["code"] == "too_many_pending"


# --- the happy path ---------------------------------------------------------------------------------------------------------


def test_run_after_a_click_executes_in_the_session_folder_with_the_exact_instruction(fx):
    propose(fx, "ECHO\nrun the tests; then `rm -rf /` $(id) %PATH% \"quoted\"")
    pid = only_id()
    before = P.get_view(pid)
    assert before["instruction"].startswith("ECHO\nrun the tests")
    assert before["folder"] == str(fx.work) and before["agent"] == "claude"
    assert before["runs_under_own_permissions"] is True
    started = P.run(pid)
    assert started["proposal"]["state"] in ("running", "finished")
    done = wait_state(pid, {"finished", "failed"})
    assert done["state"] == "finished" and done["exit_code"] == 0 and done["started"] is True
    got = json.loads(done["output"])
    assert got["argv"] == ["-p", f"--resume={CLAUDE_ID}"]
    assert got["stdin"] == "ECHO\nrun the tests; then `rm -rf /` $(id) %PATH% \"quoted\""
    assert Path(got["cwd"]).resolve() == fx.work.resolve()
    assert "ECHO" in done["instruction"]


def test_codex_form(fx):
    propose(fx, "ECHO", ref=fx.ref("codex"))
    pid = only_id()
    P.run(pid)
    done = wait_state(pid, {"finished", "failed"})
    assert json.loads(done["output"])["argv"] == ["exec", "resume", CODEX_ID, "-"]


def test_nonzero_exit_is_a_failure_with_its_output(fx):
    propose(fx, "EXIT 5")
    pid = only_id()
    P.run(pid)
    done = wait_state(pid, {"finished", "failed"})
    assert done["state"] == "failed" and done["code"] == "exit_nonzero" and done["exit_code"] == 5 and done["started"] is True
    assert "exiting" in done["output"]


# --- single use, expiry, forged ids -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("forged", [None, 5, [], {}, "", "x", "A" * 32, "../../etc/passwd", "jc-abcdef", "a" * 500, "\x00"])
def test_forged_ids_run_nothing(fx, forged):
    propose(fx, "COUNT " + str(fx.tmp / "count.txt"))
    assert P.run(forged)["error"] == "unknown_proposal"
    assert P.cancel(forged)["error"] == "unknown_proposal"
    assert not (fx.tmp / "count.txt").exists()
    assert P.list_views()[0]["state"] == "pending"


def test_replay_after_finishing_does_not_run_again(fx):
    count = fx.tmp / "count.txt"
    propose(fx, f"COUNT {count}")
    pid = only_id()
    P.run(pid)
    wait_state(pid, {"finished"})
    for _ in range(5):
        assert P.run(pid)["error"] == "already_used"
    assert count.read_text().count("run") == 1


def test_double_click_from_many_threads_runs_once(fx):
    count = fx.tmp / "count.txt"
    propose(fx, f"COUNT {count}")
    pid = only_id()
    results = []
    barrier = threading.Barrier(12)

    def click():
        barrier.wait()
        results.append(P.run(pid))

    threads = [threading.Thread(target=click) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    accepted = [r for r in results if "error" not in r]
    refused = [r for r in results if r.get("error") == "already_used"]
    assert len(accepted) == 1 and len(refused) == 11
    wait_state(pid, {"finished"})
    assert count.read_text().count("run") == 1


def test_expired_proposal_is_not_run(fx):
    count = fx.tmp / "count.txt"
    now = time.time()
    out = P.propose(fx.ref("claude", "auth"), f"COUNT {count}", "en")
    assert out["status"] == "awaiting_click"
    pid = only_id()
    v = P.get_view(pid, now=now + P.PROPOSAL_TTL_SECONDS + 1)
    assert v["state"] == "expired" and v["instruction"] == ""
    assert P.run(pid, now=now + P.PROPOSAL_TTL_SECONDS + 1)["error"] == "already_used"
    assert not count.exists()


def test_proposal_lives_five_minutes(fx):
    assert P.PROPOSAL_TTL_SECONDS == 300
    propose(fx, "ECHO")
    v = P.list_views()[0]
    assert 290 <= v["remaining_s"] <= 300


def test_finished_records_are_forgotten_later(fx):
    propose(fx, "ECHO")
    pid = only_id()
    P.run(pid)
    done = wait_state(pid, {"finished"})
    assert P.get_view(pid, now=done["ended_at"] + P.KEEP_AFTER_END_SECONDS + 5) is None


# --- cancel -----------------------------------------------------------------------------------------------------------------


def test_cancel_a_pending_proposal_is_a_denial(fx):
    count = fx.tmp / "count.txt"
    propose(fx, f"COUNT {count}")
    pid = only_id()
    out = P.cancel(pid)
    assert out["proposal"]["state"] == "denied" and out["proposal"]["instruction"] == ""
    assert P.run(pid)["error"] == "already_used"
    assert not count.exists()


def test_cancel_a_running_proposal_stops_the_process_tree(fx):
    pidfile = fx.tmp / "pids.json"
    propose(fx, f"TREE {pidfile}")
    pid = only_id()
    P.run(pid)
    assert wait_for(lambda: pidfile.exists() and pidfile.stat().st_size > 0, 20)
    assert wait_for(lambda: bool(_pids(pidfile)), 5)
    pids = _pids(pidfile)
    assert alive(pids["parent"]) and alive(pids["child"])
    assert P.cancel(pid)["proposal"]["state"] in ("running", "cancelled")
    done = wait_state(pid, {"cancelled"})
    assert done["code"] == "cancelled"
    assert wait_for(lambda: not alive(pids["parent"]) and not alive(pids["child"]), 10), pids


def _pids(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def test_cancel_race_never_runs_twice_and_never_hangs(fx):
    """Click and Deny at the same moment, many times: at most one run, always a clean end state."""
    count = fx.tmp / "count.txt"
    for round_ in range(15):
        P.reset_for_tests()
        P.set_test_roots(fx.claude, fx.codex)
        P.mark_api_ready(True)
        propose(fx, f"COUNT {count}")
        pid = only_id()
        barrier = threading.Barrier(2)
        out = {}

        def do_run():
            barrier.wait()
            out["run"] = P.run(pid)

        def do_cancel():
            barrier.wait()
            out["cancel"] = P.cancel(pid)

        ts = [threading.Thread(target=do_run), threading.Thread(target=do_cancel)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(30)
        final = wait_state(pid, {"finished", "failed", "cancelled", "denied"})
        if final["state"] == "denied":
            assert out["run"]["error"] == "already_used"
    lines = count.read_text().count("run") if count.exists() else 0
    assert lines <= 15  # one run at most per round; a denied round runs nothing


def test_cancel_wins_over_a_run_that_has_not_started(fx):
    count = fx.tmp / "count.txt"
    propose(fx, f"COUNT {count}")
    pid = only_id()
    P.cancel(pid)
    assert P.run(pid)["error"] == "already_used"
    assert not count.exists()


# --- re-validation at run time ----------------------------------------------------------------------------------------------


def refused(pid, code):
    done = wait_state(pid, {"failed"})
    assert done["code"] == code and done["started"] is False and done["output"] == "", done
    return done


def test_session_touched_after_the_proposal_is_refused(fx):
    count = fx.tmp / "count.txt"
    propose(fx, f"COUNT {count}")
    pid = only_id()
    now = time.time()
    os.utime(fx.claude_log(), (now, now))  # an editor or another terminal just wrote to it
    P.run(pid)
    refused(pid, "active_elsewhere")
    assert not count.exists()


def test_session_gone_or_changed_is_refused(fx):
    count = fx.tmp / "count.txt"
    propose(fx, f"COUNT {count}")
    pid = only_id()
    fx.claude_log().unlink()
    P.run(pid)
    refused(pid, "session_gone")

    propose(fx, f"COUNT {count}", ref=fx.ref("claude", "docs"))
    pid2 = only_id()
    make_claude(fx.claude, "bbbbbbbb-1111-2222-3333-444444444444", fx.work2, "write the docs", "ok", time.time() - 4000, project="other", stem=CLAUDE_ID2)
    P.run(pid2)
    refused(pid2, "session_changed")
    assert not count.exists()


def test_session_id_that_is_not_a_uuid_is_refused(fx):
    count = fx.tmp / "count.txt"
    propose(fx, f"COUNT {count}")
    pid = only_id()
    make_claude(fx.claude, "../../evil", fx.work, "fix the auth bug", "ok", time.time() - 4000, stem=CLAUDE_ID)
    P.run(pid)
    done = wait_state(pid, {"failed"})
    assert done["started"] is False and done["code"] in ("bad_session_id", "session_changed")
    assert not count.exists()


def test_folder_deleted_is_refused(fx):
    count = fx.tmp / "count.txt"
    propose(fx, f"COUNT {count}")
    pid = only_id()
    fx.work.rmdir()
    P.run(pid)
    done = wait_state(pid, {"failed"})
    assert done["started"] is False and done["code"] in ("folder_missing", "folder_changed")
    assert not count.exists()


def swap_for_link(folder: Path, target: Path):
    folder.rmdir()
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(target), str(folder))
    else:
        os.symlink(target, folder, target_is_directory=True)


def test_folder_swapped_for_a_junction_or_symlink_is_refused(fx):
    count = fx.tmp / "count.txt"
    elsewhere = fx.tmp / "elsewhere"
    elsewhere.mkdir()
    propose(fx, f"COUNT {count}")
    pid = only_id()
    try:
        swap_for_link(fx.work, elsewhere)
    except OSError as exc:  # symlinks may need a privilege on some machines
        pytest.skip(f"cannot create a link here: {exc}")
    P.run(pid)
    refused(pid, "folder_changed")
    assert not count.exists()


def test_folder_that_is_already_a_link_at_proposal_time_is_stable_but_a_retarget_is_refused(fx):
    elsewhere = fx.tmp / "elsewhere"
    third = fx.tmp / "third"
    elsewhere.mkdir()
    third.mkdir()
    link = fx.tmp / "linkdir"
    try:
        if os.name == "nt":
            import _winapi

            _winapi.CreateJunction(str(elsewhere), str(link))
        else:
            os.symlink(elsewhere, link, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"cannot create a link here: {exc}")
    make_claude(fx.claude, CLAUDE_ID2, link, "linked", "ok", time.time() - 4000, project="other")
    count = fx.tmp / "count.txt"
    propose(fx, f"COUNT {count}", ref=fx.ref("claude", "linked"))
    pid = only_id()
    link.rmdir()
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(third), str(link))
    else:
        os.symlink(third, link, target_is_directory=True)
    P.run(pid)
    refused(pid, "folder_changed")
    assert not count.exists()


def test_cli_missing_at_run_time_is_refused(fx, monkeypatch):
    propose(fx, "ECHO")
    pid = only_id()
    monkeypatch.delenv("REACTOR_TEST_CLI")
    monkeypatch.setattr("shutil.which", lambda name: None)
    P.run(pid)
    refused(pid, "cli_missing")


def test_the_test_cli_override_is_ignored_outside_pytest(fx, monkeypatch):
    from reactor_hermes import continuation

    assert continuation._test_cli_override("claude") == (__import__("sys").executable, FAKE)
    monkeypatch.delenv("PYTEST_CURRENT_TEST")
    assert continuation._test_cli_override("claude") is None  # a normal process cannot redirect the CLI


# --- one run per session ------------------------------------------------------------------------------------------------------


def test_one_run_per_session(fx):
    count = fx.tmp / "count.txt"
    propose(fx, "SLEEP")
    first = only_id()
    P.run(first)
    wait_state(first, {"running"})
    propose(fx, f"COUNT {count}")  # the first is running, not pending, so a second proposal is allowed
    second = only_id()
    assert second != first
    assert P.run(second)["error"] == "session_busy"
    assert P.get_view(second)["state"] == "pending"  # not consumed by a busy refusal
    P.cancel(first)
    wait_state(first, {"cancelled"})
    assert wait_for(lambda: "error" not in P.run(second), 10)
    wait_state(second, {"finished"})
    assert count.read_text().count("run") == 1


def test_running_cap(fx, monkeypatch):
    monkeypatch.setattr(P, "MAX_RUNNING", 1)
    propose(fx, "SLEEP", ref=fx.ref("claude", "auth"))
    a = only_id()
    P.run(a)
    wait_state(a, {"running"})
    propose(fx, "ECHO", ref=fx.ref("claude", "docs"))
    b = only_id()
    assert P.run(b)["error"] == "too_many_running"
    P.cancel(a)
    wait_state(a, {"cancelled"})


# --- bounds, timeout, environment ---------------------------------------------------------------------------------------------


def test_big_output_is_bounded_in_what_the_card_gets(fx):
    propose(fx, "FLOOD 3")
    pid = only_id()
    P.run(pid)
    done = wait_state(pid, {"finished"}, seconds=60)
    assert len(done["output"]) <= P.OUTPUT_SHOWN_CHARS
    assert done["output_truncated"] is True
    assert done["output"].rstrip().endswith("END-OF-FLOOD")


def test_timeout_is_a_failure_and_the_process_is_gone(fx, monkeypatch):
    monkeypatch.setattr(runner, "TIMEOUT_SECONDS", 1.0)
    pidfile = fx.tmp / "pids.json"
    propose(fx, f"TREE {pidfile}")
    pid = only_id()
    P.run(pid)
    done = wait_state(pid, {"failed"}, seconds=40)
    assert done["code"] == "timeout" and done["started"] is True
    pids = _pids(pidfile)
    assert wait_for(lambda: not alive(pids["parent"]) and not alive(pids["child"]), 10)


def test_the_default_timeout_is_twenty_minutes():
    assert runner.TIMEOUT_SECONDS == 20 * 60


def test_planted_secrets_do_not_reach_the_agent(fx, monkeypatch):
    monkeypatch.setenv("HERMES_API_KEY", "hermes-secret-111")
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-secret-222")
    propose(fx, "ENV")
    pid = only_id()
    P.run(pid)
    done = wait_state(pid, {"finished"})
    env = json.loads(done["output"]) if done["output_truncated"] is False else {}
    # The environment dump may be cut by the card limit; the full check lives in test_runner. Here: not in the text at all.
    assert "hermes-secret-111" not in done["output"] and "or-secret-222" not in done["output"]
    assert "HERMES_API_KEY" not in done["output"].upper()
    assert env == {} or all(k.upper() in runner.ENV_ALLOWLIST or k in ("NO_COLOR", "TERM", "CI") for k in env)


def test_output_is_shown_as_clean_text(fx):
    propose(fx, "COLOR")
    pid = only_id()
    P.run(pid)
    done = wait_state(pid, {"finished"})
    assert "\x1b" not in done["output"] and "‮" not in done["output"] and "red" in done["output"]


# --- what is stored and logged --------------------------------------------------------------------------------------------------


def test_nothing_is_written_to_disk_and_logs_hold_no_text(fx, caplog, hermes_home):
    caplog.set_level("DEBUG")
    home = Path(os.environ["HOME"])
    secret = "ECHO\nconfidential-plan-QQQ-9911"
    propose(fx, secret)
    pid = only_id()
    P.run(pid)
    done = wait_state(pid, {"finished"})
    assert "confidential-plan-QQQ-9911" in done["output"]  # shown to the person, in memory only
    text = caplog.text
    assert "QQQ-9911" not in text and "fix the auth bug" not in text and str(fx.work) not in text and pid not in text
    assert list(hermes_home.rglob("*")) == []
    assert list(home.rglob("*")) == []


# --- tool and API in two module copies (as Hermes loads them) -----------------------------------------------------------------


def test_tool_and_api_modules_share_state_through_the_anchor(fx):
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_reactor_test", ROOT / "dashboard" / "plugin_api.py")
    api = importlib.util.module_from_spec(spec)
    import sys

    sys.modules[spec.name] = api
    spec.loader.exec_module(api)
    try:
        assert api.P is not P  # a different module object, loaded from the same files
        assert api.P.shared() is P.shared()
        propose(fx, "ECHO")
        mine = api.P.list_views()
        assert len(mine) == 1 and mine[0]["state"] == "pending"
        assert P.api_ready() is True
    finally:
        sys.modules.pop(spec.name, None)
