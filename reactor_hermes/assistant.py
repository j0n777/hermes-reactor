"""The assistant's display name, and the persona line that makes the model answer to it.

Applied two ways and no other: the Desktop UI shows the name, and :func:`pre_llm_call` hands the model one short
context line each turn (the documented ``pre_llm_call`` context injection). Nothing here edits the user's persona file
or any profile; the plugin never configures a profile.

The name is free text, 1 to 24 characters, and it is quoted into a line the model reads, so it is reduced to letters,
digits, marks, space, hyphen, underscore, apostrophe and period: no quote, angle bracket, colon or line break can
survive. ``tests/shared/name-vectors.json`` runs one list through this function and ``sanitizeName`` in
``src/model/assistant.js``.

The name lives in server memory (never a file). Desktop keeps the person's choice in its own storage and sends it on
start and on every reconnect (``POST /assistant``); until then the default is used.
"""

from __future__ import annotations

import sys
import threading
import types
import unicodedata
from typing import Any

from .text import clean

DEFAULT_NAME = "Hermes"
# Presets offered in the UI. Free text is also allowed. A third party's trademark is not offered as a preset.
PRESETS = ("Hermes", "Jarbas")
NAME_MAX = 24
_EXTRA_ALLOWED = set(" -_'.")
_ANCHOR = "_reactor_hermes_assistant_v1"


def sanitize_name(value: object) -> str:
    """The name as it may be shown and quoted, or ``""`` when nothing usable is left."""
    if not isinstance(value, str):
        return ""
    text = clean(value, 0)  # control, bidi, zero-width and tag characters out; whitespace collapsed
    text = unicodedata.normalize("NFC", text)
    kept = "".join(ch for ch in text if ch in _EXTRA_ALLOWED or unicodedata.category(ch)[0] in "LNM")
    kept = " ".join(kept.split())
    if len(kept) > NAME_MAX:
        kept = kept[:NAME_MAX].rstrip()
    return kept


def _state() -> Any:
    mod = sys.modules.get(_ANCHOR)
    if mod is None:
        fresh = types.ModuleType(_ANCHOR)
        fresh.lock = threading.Lock()
        fresh.name = DEFAULT_NAME
        mod = sys.modules.setdefault(_ANCHOR, fresh)
    return mod


def get_name() -> str:
    return _state().name


def set_name(value: object) -> dict:
    """Set the name. A blank or unusable value is refused and the old name stays."""
    st = _state()
    name = sanitize_name(value)
    if not name:
        return {"ok": False, "error": "bad_name", "name": st.name}
    with st.lock:
        st.name = name
    return {"ok": True, "name": name}


def context() -> str:
    """One line for the model: who it answers as, and which language to speak. Fixed text plus the clean name."""
    name = get_name()
    return (
        f'[Reactor] The person calls you "{name}"; answer to that name and use it when you introduce yourself. '
        "Reply in the language the person spoke or wrote. Your replies may be spoken aloud, so keep them short."
    )


def pre_llm_call(**_kwargs: Any) -> dict:
    """The ``pre_llm_call`` hook: returns context for this turn. Never raises, never blocks the turn."""
    try:
        return {"context": context()}
    except Exception:  # health: allow BLE001 -- a hook must not break the turn
        return {"context": ""}


def reset_for_tests() -> None:
    st = _state()
    with st.lock:
        st.name = DEFAULT_NAME
