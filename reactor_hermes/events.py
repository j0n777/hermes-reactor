"""Events from the Python side to this plugin's own Desktop half, through Hermes' public event bridge.

``hermes_cli.plugin_events.broadcast_plugin_event`` is the documented door (``plugin.<plugin id>.<event>`` reaches every
connected Desktop window). It is fire-and-forget and a logged no-op in a process with no Desktop client. This module
never logs a payload: only fixed codes.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

PLUGIN_ID = "hermes-reactor"


def emit(event: str, payload: Optional[dict] = None) -> bool:
    """Send one event. False when the bridge is missing or refused; never raises."""
    try:
        from hermes_cli import plugin_events

        plugin_events.broadcast_plugin_event(PLUGIN_ID, event, dict(payload or {}))
        return True
    except ImportError:
        logger.info("reactor event %s: no plugin event bridge in this process", event)
        return False
    except Exception as exc:  # health: allow BLE001 -- never raise into the agent loop
        logger.warning("reactor event %s failed: %s", event, type(exc).__name__)
        return False
