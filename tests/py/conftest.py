"""Test isolation: no test may ever reach the real Hermes, Claude or Codex data."""

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    """Point every home-like variable at a temp dir, so a bug cannot touch real data."""
    home = tmp_path / "home"
    hermes_home = tmp_path / "hermes_home"
    home.mkdir()
    hermes_home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude_cfg"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex_cfg"))
    monkeypatch.setenv("HERMES_GATEWAY_LOCK_DIR", str(tmp_path / "locks"))
    monkeypatch.delenv("APPDATA", raising=False)
    from reactor_hermes import screens

    screens.reset_for_tests()
    yield


@pytest.fixture(autouse=True)
def no_real_agent_clis(monkeypatch):
    """`claude` and `codex` do not exist as far as the tests are concerned (a test that wants one passes a stand-in)."""
    import shutil

    real_which = shutil.which
    monkeypatch.setattr(shutil, "which", lambda name, *a, **k: None if str(name).lower() in ("claude", "codex") else real_which(name, *a, **k))
    monkeypatch.delenv("REACTOR_TEST_CLI", raising=False)
    yield


@pytest.fixture
def hermes_home():
    return Path(os.environ["HERMES_HOME"])
