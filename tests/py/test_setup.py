import argparse
import os
from pathlib import Path

import pytest

from reactor_hermes import setup_cmd
from reactor_hermes.setup_cmd import PT_BR_DEFAULTS, plan_changes, run_setup

EXISTING = """\
# my own config
model:
  default: some-model   # keep this comment
tts:
  provider: edge
  edge:
    voice: en-US-AriaNeural
stt:
  language: en
"""


def snapshot(root: Path):
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


@pytest.fixture
def cfg(hermes_home):
    return hermes_home / "config.yaml"


def run(cfg, **kw):
    lines = []
    code = run_setup(config_path=cfg, out=lines.append, **kw)
    return code, "\n".join(lines)


def test_config_path_resolves_inside_the_isolated_home(hermes_home):
    assert Path(setup_cmd.default_config_path()).resolve() == (hermes_home / "config.yaml").resolve()


def test_preview_is_default_and_touches_nothing(cfg, hermes_home):
    cfg.write_text(EXISTING, encoding="utf-8")
    before = snapshot(hermes_home)
    code, out = run(cfg)
    assert code == 0
    assert snapshot(hermes_home) == before
    assert "Preview only" in out and "--apply" in out
    assert "stt.language: en -> pt" in out


def test_preview_does_not_create_home_or_config(tmp_path):
    home = tmp_path / "does_not_exist_yet"
    cfg = home / "config.yaml"
    code, out = run(cfg)
    assert code == 0 and not home.exists()


def test_dry_run_wins_over_apply(cfg, hermes_home):
    cfg.write_text(EXISTING, encoding="utf-8")
    before = snapshot(hermes_home)
    code, _ = run(cfg, apply=True, dry_run=True)
    assert code == 0 and snapshot(hermes_home) == before


def test_apply_backs_up_then_writes_and_keeps_comments(cfg, hermes_home):
    cfg.write_text(EXISTING, encoding="utf-8")
    code, out = run(cfg, apply=True)
    assert code == 0 and "Backup" in out
    backups = [p for p in hermes_home.iterdir() if p.name.startswith("config.yaml.reactor-bak-")]
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == EXISTING  # exact copy of the old file
    new = cfg.read_text(encoding="utf-8")
    assert "# my own config" in new and "# keep this comment" in new
    assert "some-model" in new
    from ruamel.yaml import YAML

    data = YAML(typ="safe").load(new)
    assert data["stt"]["language"] == "pt" and data["stt"]["local"]["language"] == "pt"
    assert data["stt"]["provider"] == "local"
    assert data["tts"]["edge"]["voice"] == PT_BR_DEFAULTS["tts_edge_voice"]
    assert data["model"]["default"] == "some-model"


def test_apply_is_idempotent(cfg, hermes_home):
    cfg.write_text(EXISTING, encoding="utf-8")
    run(cfg, apply=True)
    after_first = cfg.read_bytes()
    n_backups = len(list(hermes_home.glob("config.yaml.reactor-bak-*")))
    code, out = run(cfg, apply=True)
    assert code == 0 and "already matches" in out
    assert cfg.read_bytes() == after_first
    assert len(list(hermes_home.glob("config.yaml.reactor-bak-*"))) == n_backups  # no new backup when nothing changes


def test_apply_without_existing_config_creates_it(cfg):
    code, out = run(cfg, apply=True)
    assert code == 0 and cfg.exists()
    assert "no config file" in out


def test_wake_phrase_default_is_hey_hermes_and_wake_stays_off():
    changes = dict((c[0], c[2]) for c in plan_changes({}, wake_phrase=None, tts="edge", enable_wake=False))
    assert changes["wake_word.phrase"] == "hey hermes"
    assert "wake_word.enabled" not in changes
    assert "wake_word.provider" not in changes


def test_custom_wake_phrase_uses_sherpa_and_is_flagged_unverified(cfg):
    code, out = run(cfg, wake_phrase="jarbas")
    assert "wake_word.phrase" in out and "jarbas" in out and "sherpa" in out
    assert "not verified" in out


def test_enable_wake_is_opt_in():
    changes = dict((c[0], c[2]) for c in plan_changes({}, wake_phrase=None, tts="edge", enable_wake=True))
    assert changes["wake_word.enabled"] is True


@pytest.mark.parametrize("phrase", ["x", "a" * 41, "hey; rm -rf /", "hey\nhermes", "hey `id`", "$(x)", "‮yar", "hey: bad"])
def test_bad_wake_phrase_is_refused_and_nothing_written(cfg, hermes_home, phrase):
    before = snapshot(hermes_home)
    code, out = run(cfg, apply=True, wake_phrase=phrase)
    assert code == 2 and snapshot(hermes_home) == before


def test_piper_option(cfg):
    code, out = run(cfg, tts="piper")
    assert "tts.piper.voice" in out and PT_BR_DEFAULTS["tts_piper_voice"] in out


def test_voice_ids_are_marked_unverified(cfg):
    _, out = run(cfg)
    assert "not verified" in out
    assert PT_BR_DEFAULTS["verified"] == {"stt": True, "tts_edge_voice": False, "tts_piper_voice": False}


def test_pt_br_output(cfg):
    _, out = run(cfg, lang="pt-BR")
    assert "Só prévia" in out and "não foi verificado" in out


def test_broken_yaml_is_not_overwritten(cfg, hermes_home):
    cfg.write_text("key: [unclosed\n  : :\n", encoding="utf-8")
    before = snapshot(hermes_home)
    code, out = run(cfg, apply=True)
    assert code == 1 and snapshot(hermes_home) == before


def test_non_mapping_top_level_is_not_overwritten(cfg, hermes_home):
    cfg.write_text("- a\n- b\n", encoding="utf-8")
    before = snapshot(hermes_home)
    code, _ = run(cfg, apply=True)
    assert code == 1 and snapshot(hermes_home) == before


def test_credentials_are_never_read_or_written(cfg, hermes_home):
    (hermes_home / ".env").write_text("SECRET=abc\n", encoding="utf-8")
    (hermes_home / "auth.json").write_text('{"token": "abc"}', encoding="utf-8")
    cfg.write_text(EXISTING, encoding="utf-8")
    run(cfg, apply=True)
    assert (hermes_home / ".env").read_text(encoding="utf-8") == "SECRET=abc\n"
    assert (hermes_home / "auth.json").read_text(encoding="utf-8") == '{"token": "abc"}'
    src = Path(setup_cmd.__file__).read_text(encoding="utf-8")
    assert "auth.json" not in src and '".env"' not in src and "'.env'" not in src


def test_argparse_wiring(cfg):
    parser = argparse.ArgumentParser()
    setup_cmd.setup_argparse(parser)
    args = parser.parse_args(["setup"])
    assert args.apply is False and args.dry_run is False
    args = parser.parse_args(["setup", "--apply", "--tts", "piper", "--wake-phrase", "hey jarbas"])
    assert args.apply and args.tts == "piper" and args.wake_phrase == "hey jarbas"
    with pytest.raises(SystemExit):
        parser.parse_args(["setup", "--tts", "elevenlabs"])


def test_handler_preview_by_default(cfg, hermes_home, capsys):
    cfg.write_text(EXISTING, encoding="utf-8")
    before = snapshot(hermes_home)
    parser = argparse.ArgumentParser()
    setup_cmd.setup_argparse(parser)
    args = parser.parse_args(["setup"])
    setup_cmd.handle(args)
    assert "Preview only" in capsys.readouterr().out
    assert snapshot(hermes_home) == before


# --- --wake-model: records the path of a local TFLite model the person owns, nothing else ---------------------------


def make_tflite(path: Path, size: int = 256) -> Path:
    path.write_bytes(b"\x1c\x00\x00\x00TFL3" + b"\x00" * (size - 8))
    return path


def test_wake_model_records_provider_and_path_only(cfg, hermes_home, tmp_path):
    model = make_tflite(tmp_path / "mine" / "jarbas.tflite") if (tmp_path / "mine").mkdir() is None else None
    cfg.write_text(EXISTING, encoding="utf-8")
    code, out = run(cfg, wake_model=str(model))
    assert code == 0
    assert "wake_word.provider: (unset) -> openwakeword" in out
    assert f"wake_word.openwakeword.model: (unset) -> {model}" in out
    assert "sherpa" not in out
    code, _ = run(cfg, wake_model=str(model), apply=True)
    assert code == 0
    text = cfg.read_text(encoding="utf-8")
    assert "provider: openwakeword" in text and str(model) in text
    assert "# keep this comment" in text
    # the model itself is never copied into the Hermes home or the config
    assert not list(hermes_home.rglob("*.tflite"))


def test_wake_model_preview_writes_nothing(cfg, hermes_home, tmp_path):
    model = make_tflite(tmp_path / "m.tflite")
    cfg.write_text(EXISTING, encoding="utf-8")
    before = snapshot(hermes_home)
    code, out = run(cfg, wake_model=str(model))
    assert code == 0 and "Preview only" in out
    assert snapshot(hermes_home) == before


def test_wake_model_onnx_is_refused_because_it_crashes_the_hermes_loader(cfg, hermes_home, tmp_path):
    onnx = tmp_path / "jarbas.onnx"
    onnx.write_bytes(b"\x08\x07" + b"onnx" * 40)
    cfg.write_text(EXISTING, encoding="utf-8")
    before = snapshot(hermes_home)
    code, out = run(cfg, wake_model=str(onnx), apply=True)
    assert code == 2
    assert "TensorFlow Lite" in out and "Nothing was written" in out
    assert snapshot(hermes_home) == before


@pytest.mark.parametrize("name,body", [("x.tflite", b"not a flatbuffer at all" * 10), ("x.bin", b"\x1c\x00\x00\x00TFL3" + b"\x00" * 300), ("tiny.tflite", b"\x1c\x00\x00\x00TFL3")])
def test_wake_model_must_be_a_real_tflite_file(cfg, hermes_home, tmp_path, name, body):
    f = tmp_path / name
    f.write_bytes(body)
    cfg.write_text(EXISTING, encoding="utf-8")
    before = snapshot(hermes_home)
    code, out = run(cfg, wake_model=str(f), apply=True)
    assert code == 2 and "TensorFlow Lite" in out
    assert snapshot(hermes_home) == before


def test_wake_model_missing_or_odd_paths(cfg, hermes_home, tmp_path):
    cfg.write_text(EXISTING, encoding="utf-8")
    before = snapshot(hermes_home)
    for bad in (str(tmp_path / "nope.tflite"), "", "   ", str(tmp_path)):
        code, _ = run(cfg, wake_model=bad, apply=True)
        assert code == 2
    assert snapshot(hermes_home) == before


def test_wake_model_messages_in_pt_br(cfg, tmp_path):
    code, out = run(cfg, wake_model=str(tmp_path / "jarbas.onnx"), lang="pt-BR")
    assert code == 2 and "não foi encontrado" in out
    onnx = tmp_path / "j.onnx"
    onnx.write_bytes(b"x" * 100)
    code, out = run(cfg, wake_model=str(onnx), lang="pt-BR")
    assert code == 2 and "TensorFlow Lite" in out and "Nada foi gravado" in out


def test_argparse_accepts_wake_model():
    parser = argparse.ArgumentParser()
    setup_cmd.setup_argparse(parser)
    args = parser.parse_args(["setup", "--wake-model", "C:/m/jarbas.tflite"])
    assert args.wake_model == "C:/m/jarbas.tflite"
    assert parser.parse_args(["setup"]).wake_model is None


def test_the_plugin_repo_ships_no_model_files():
    """Catalog rule 17: no compiled or model binaries in the plugin (and the factory model is CC BY-NC-SA)."""
    root = Path(__file__).resolve().parents[2]
    skip = {".git", "node_modules", "__pycache__", ".pytest_cache"}
    found = [str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() and not (set(p.relative_to(root).parts) & skip)
             and p.suffix.lower() in {".onnx", ".tflite", ".ppn", ".pt", ".bin", ".dll", ".exe", ".so"}]
    assert found == []
