"""``reactor_show``: ask Desktop to open one of a closed list of screens.

The model names a view; this module checks it against the list and sends one event. Desktop validates the name again
against the same list and navigates. Nothing else can be requested: an unknown view does nothing.

Two guards keep a model (or text it was fed) from pushing the screen around:

- one navigation per 3 seconds, across all views (``rate_limited``), and
- no navigation while a card is waiting for the person's click (``card_pending``), so a card is never scrolled or
  covered away from the person who has to read it. Desktop applies the same two rules on its side, including for
  Hermes approval cards that only Desktop can see.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

from . import events

# Keep identical to SHOW_VIEWS in src/model/screens.js (a test compares them).
VIEWS = ("stage", "graph", "agents", "profiles", "kanban", "cron", "messaging", "capabilities")

# Keep identical to MIN_GAP_MS in src/model/screens.js.
MIN_GAP_SECONDS = 3.0

_lock = threading.Lock()
_last_at: Optional[float] = None


def reset_for_tests() -> None:
    global _last_at
    with _lock:
        _last_at = None


def _card_waiting() -> bool:
    """True while one of this plugin's own cards (an ask or a continue) is waiting for a click."""
    from . import asks, proposals

    try:
        if any(v.get("state") == "pending" for v in asks.list_views()):
            return True
        return any(v.get("state") == "pending" for v in proposals.list_views())
    except Exception:  # health: allow BLE001 -- a failed look must not open a screen over a card
        return True


def show(view: object, *, now: Optional[float] = None) -> dict:
    global _last_at
    name = view.strip().lower() if isinstance(view, str) else ""
    if name not in VIEWS:
        return {"status": "refused", "code": "unknown_view", "views": list(VIEWS)}
    at = time.monotonic() if now is None else now
    if _card_waiting():
        return {
            "status": "refused",
            "code": "card_pending",
            "message": "A card is waiting for the person's click. Do not change the screen until they have answered it.",
        }
    with _lock:
        if _last_at is not None and at - _last_at < MIN_GAP_SECONDS:
            wait = max(1, int(MIN_GAP_SECONDS - (at - _last_at) + 0.999))
            return {
                "status": "refused",
                "code": "rate_limited",
                "retry_after_s": wait,
                "message": f"The screen was changed a moment ago. Wait {wait} seconds before opening another one.",
            }
        if not events.emit("show", {"view": name}):
            return {"status": "refused", "code": "ui_unavailable", "views": list(VIEWS)}
        _last_at = at
    return {"status": "requested", "view": name}
