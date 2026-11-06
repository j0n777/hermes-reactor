"""`hermes reactor setup`: show, and only on `--apply` write, the Brazilian Portuguese voice configuration.

Preview is the default and never touches the disk (it does not even create the Hermes home). Applying needs the
explicit `--apply` flag, copies the current config to `config.yaml.reactor-bak-<timestamp>` first, changes only the
keys listed here (comments and every other key are kept) and replaces the file atomically. The wake word stays off
unless `--enable-wake` is given: it opens the microphone, so the person decides.

Voice ids marked unverified are not present in the Hermes source and were not checked against the vendor lists.
"""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .i18n import resolve_lang, t

# Defaults from the spike (SPIKE.md Q3). `verified` says what could be confirmed from the Hermes source.
PT_BR_DEFAULTS = {
    "wake_phrase": "hey hermes",  # Hermes' own default; "jarbas" with the English sherpa model is unproven
    "stt_provider": "local",
    "stt_language": "pt",
    "stt_model": "small",
    "tts_edge_voice": "pt-BR-FranciscaNeural",
    "tts_piper_voice": "pt_BR-faber-medium",
    "verified": {"stt": True, "tts_edge_voice": False, "tts_piper_voice": False},
}

_PHRASE_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9 '\-]{0,38}[A-Za-z0-9]\Z")

# Hermes' openwakeword provider is pyopen-wakeword, which runs TensorFlow Lite models only (tools/wake_word.py:
# "pyopen-wakeword runs TFLite only"). Handing it anything else is not a polite error: the native loader dies with an
# access violation (proved in the lab with an ONNX openWakeWord model). So `--wake-model` accepts only a real TFLite
# flatbuffer and only ever records its path: the plugin never copies, ships or reads the model beyond 8 header bytes.
_MODEL_MAX_BYTES = 64 * 1024 * 1024


def check_wake_model(path: Any) -> tuple:
    """Return (absolute path, "") for a usable local TFLite model, or ("", reason code)."""
    try:
        raw = str(path).strip()
    except Exception:
        return "", "badpath"
    if not raw or "\x00" in raw:
        return "", "badpath"
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = Path(os.path.abspath(p))
    if not p.is_file():
        return "", "missing"
    suffix = p.suffix.lower()
    if suffix == ".onnx":
        return "", "onnx"
    if suffix != ".tflite":
        return "", "notflite"
    try:
        size = p.stat().st_size
        if size < 64 or size > _MODEL_MAX_BYTES:
            return "", "notflite"
        with open(p, "rb") as fh:
            head = fh.read(8)
    except OSError:
        return "", "unreadable"
    if len(head) < 8 or head[4:8] != b"TFL3":
        return "", "notflite"
    return str(p), ""


def default_config_path() -> Path:
    """The active Hermes config file (honours HERMES_HOME and profiles)."""
    try:
        from hermes_cli.config import get_config_path

        return Path(get_config_path())
    except Exception:
        home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
        return Path(home) / "config.yaml"


def _get(data: Any, dotted: str) -> Any:
    node = data
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def _set(data: Any, dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    node = data
    for part in parts[:-1]:
        child = node.get(part)
        if not isinstance(child, dict):
            node[part] = type(node)() if hasattr(node, "fromkeys") else {}
            child = node[part]
        node = child
    node[parts[-1]] = value


def plan_changes(
    current: Any, *, wake_phrase: Optional[str], tts: str, enable_wake: bool, wake_model: Optional[str] = None
) -> list:
    """List of (dotted key, old value, new value) that differ from `current`."""
    d = PT_BR_DEFAULTS
    phrase = wake_phrase or d["wake_phrase"]
    wanted = [
        ("wake_word.phrase", phrase),
        ("wake_word.start_new_session", True),
        ("stt.provider", d["stt_provider"]),
        ("stt.language", d["stt_language"]),
        ("stt.local.model", d["stt_model"]),
        ("stt.local.language", d["stt_language"]),
    ]
    if wake_model:
        # A model the person owns: the openwakeword engine, keyed by that model (the phrase is only a label there).
        wanted += [("wake_word.provider", "openwakeword"), ("wake_word.openwakeword.model", wake_model)]
    elif wake_phrase and wake_phrase != d["wake_phrase"]:
        wanted.append(("wake_word.provider", "sherpa"))  # an open phrase only works with the sherpa engine
    if enable_wake:
        wanted.append(("wake_word.enabled", True))
    if tts == "piper":
        wanted += [("tts.provider", "piper"), ("tts.piper.voice", d["tts_piper_voice"])]
    else:
        wanted += [("tts.provider", "edge"), ("tts.edge.voice", d["tts_edge_voice"])]
    return [(key, _get(current, key), new) for key, new in wanted if _get(current, key) != new]


def _unverified_notes(tts: str, wake_phrase: Optional[str], wake_model: Optional[str] = None) -> list:
    notes = []
    if tts == "piper":
        notes.append("Piper voice " + PT_BR_DEFAULTS["tts_piper_voice"])
    else:
        notes.append("Edge voice " + PT_BR_DEFAULTS["tts_edge_voice"])
    if wake_phrase and wake_phrase != PT_BR_DEFAULTS["wake_phrase"] and not wake_model:
        notes.append(f"detection of the phrase '{wake_phrase}' with the English sherpa model")
    return notes


def _show(value: Any) -> str:
    return "(unset)" if value is None else str(value)


def run_setup(
    *,
    apply: bool = False,
    dry_run: bool = False,
    wake_phrase: Optional[str] = None,
    tts: str = "edge",
    enable_wake: bool = False,
    wake_model: Optional[str] = None,
    lang: Optional[str] = None,
    out: Callable[[str], Any] = print,
    config_path: Optional[Any] = None,
) -> int:
    """Returns 0 on success, 1 when the existing config cannot be handled, 2 for a bad argument."""
    lg = resolve_lang(lang)
    if wake_phrase is not None and not _PHRASE_RE.match(str(wake_phrase)):
        out(t("setup.badphrase", lg))
        return 2
    model_path = None
    if wake_model is not None:
        model_path, why = check_wake_model(wake_model)
        if not model_path:
            out(t("setup.badmodel." + why, lg))
            return 2
    path = Path(config_path) if config_path else default_config_path()
    writing = bool(apply) and not dry_run

    try:
        from ruamel.yaml import YAML

        yaml = YAML(typ="rt")
        yaml.preserve_quotes = True
        yaml.width = 4096
        existed = path.is_file()
        if existed:
            with open(path, "r", encoding="utf-8") as fh:
                data = yaml.load(fh)
            if data is None:
                data = yaml.map()
            if not isinstance(data, dict):
                raise ValueError("config.yaml is not a mapping")
        else:
            data = yaml.map()
    except Exception as exc:
        out(t("setup.fail", lg, why=type(exc).__name__))
        return 1

    changes = plan_changes(data, wake_phrase=wake_phrase, tts=tts, enable_wake=enable_wake, wake_model=model_path)
    out(t("setup.header", lg, path=str(path)))
    if not changes:
        out(t("setup.nochange", lg))
        return 0
    for key, old, new in changes:
        out(t("setup.change", lg, key=key, old=_show(old), new=_show(new)))
    for note in _unverified_notes(tts, wake_phrase, model_path):
        out(t("setup.unverified", lg, what=note))
    if not writing:
        out(t("setup.preview", lg))
        return 0

    try:
        backup = None
        path.parent.mkdir(parents=True, exist_ok=True)
        if existed:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            backup = path.with_name(f"{path.name}.reactor-bak-{stamp}")
            n = 0
            while backup.exists():
                n += 1
                backup = path.with_name(f"{path.name}.reactor-bak-{stamp}-{n}")
            shutil.copy2(path, backup)
        for key, _old, new in changes:
            _set(data, key, new)
        fd, tmp_name = tempfile.mkstemp(prefix=".config-", suffix=".tmp", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                yaml.dump(data, fh)
            os.replace(tmp_name, path)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
    except Exception as exc:
        out(t("setup.fail", lg, why=type(exc).__name__))
        return 1
    out(t("setup.applied", lg, backup=str(backup)) if backup else t("setup.created", lg))
    return 0


# --- argparse wiring (hermes reactor ...) ----------------------------------------------------------------------------


def setup_argparse(parser) -> None:
    subs = parser.add_subparsers(dest="reactor_command")
    sp = subs.add_parser("setup", help="Show (or apply with --apply) the pt-BR voice configuration")
    sp.add_argument("--apply", action="store_true", help="write the changes (a backup of config.yaml is made first)")
    sp.add_argument("--dry-run", action="store_true", help="show the changes and write nothing (this is the default)")
    sp.add_argument("--wake-phrase", default=None, help="wake phrase (default: 'hey hermes')")
    sp.add_argument("--tts", choices=("edge", "piper"), default="edge", help="text-to-speech engine")
    sp.add_argument(
        "--wake-model",
        default=None,
        metavar="PATH",
        help="path to a local TensorFlow Lite wake word model you own (Hermes' openwakeword engine); only the path is recorded",
    )
    sp.add_argument("--enable-wake", action="store_true", help="also turn the wake word on (opens the microphone)")
    parser.set_defaults(func=handle)


def handle(args) -> int:
    if getattr(args, "reactor_command", None) != "setup":
        print("usage: hermes reactor setup [--apply] [--dry-run] [--wake-phrase PHRASE] [--wake-model PATH] [--tts edge|piper] [--enable-wake]")
        return 0
    return run_setup(
        apply=bool(getattr(args, "apply", False)),
        dry_run=bool(getattr(args, "dry_run", False)),
        wake_phrase=getattr(args, "wake_phrase", None),
        tts=getattr(args, "tts", "edge") or "edge",
        enable_wake=bool(getattr(args, "enable_wake", False)),
        wake_model=getattr(args, "wake_model", None),
    )
