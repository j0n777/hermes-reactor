"""Reactor backend routes, mounted by Hermes at ``/api/plugins/hermes-reactor/``.

These routes list, run, cancel and report on the continuations that ``reactor_continue_session`` registered. They are
what turns a person's click on the Desktop card into a running program, so the first rule is WHO may call them.

How Hermes authenticates ``/api/plugins/*`` (read from the 0.23.0 source, see README "Who can call the routes"):

- A local Desktop talks to the gateway-hosted listener. That listener withholds the dashboard session token
  (``gateway/run_api.py``) and Desktop's ``ctx.rest`` carries a single-use ``x-hermes-gateway-ticket`` that is minted over
  an owner-only control channel (a same-user named pipe on Windows, ``hermes_cli/dashboard_auth/native_http.py``). The
  server redeems it and sets ``request.state.native_http_principal``.
- ``hermes dashboard`` and a headless ``hermes serve`` instead publish the session token at ``GET /`` to any local peer,
  so there ANY local process could call a plugin route.

So these routes insist on the native principal and refuse everything else (HTTP 403). A caller that only holds the
dashboard session token, a remote token, or a plugin host forward is refused: fail closed.

Proposal ids are 192-bit random values shown only to this API's callers. The model gets a different, useless label.
"""

from __future__ import annotations

import importlib
import importlib.util
import re
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()

_ID_RE = re.compile(r"\A[A-Za-z0-9_-]{16,64}\Z")
_PKG = "reactor_hermes_api_pkg"


def _proposals():
    """The proposals module, loaded from this plugin's own folder (this file is imported without a package)."""
    name = f"{_PKG}.proposals"
    mod = sys.modules.get(name)
    if mod is not None:
        return mod
    root = Path(__file__).resolve().parent.parent / "reactor_hermes"
    spec = importlib.util.spec_from_file_location(_PKG, root / "__init__.py", submodule_search_locations=[str(root)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[_PKG] = pkg
    try:
        spec.loader.exec_module(pkg)
        return importlib.import_module(name)
    except Exception:
        sys.modules.pop(_PKG, None)
        raise


P = _proposals()
ASKS = importlib.import_module(f"{_PKG}.asks")
ASSISTANT = importlib.import_module(f"{_PKG}.assistant")


class NameBody(BaseModel):
    name: str = ""


def require_native_owner(request: Request) -> None:
    """Only a request Hermes authenticated with a native same-user ticket (capability ``http:owner``)."""
    if request.headers.get("origin") is not None:
        raise HTTPException(status_code=403, detail="native_only")
    principal = getattr(request.state, "native_http_principal", None)
    caps = principal.get("capabilities") if isinstance(principal, dict) else None
    if not caps or "http:owner" not in caps:
        raise HTTPException(status_code=403, detail="native_only")


def _id(pid: str) -> str:
    if not isinstance(pid, str) or not _ID_RE.match(pid):
        raise HTTPException(status_code=404, detail="unknown_proposal")
    return pid


def _answer(result: dict) -> dict:
    if "error" in result:
        out = {"ok": False, "error": result["error"]}
        if result.get("proposal"):
            out["proposal"] = result["proposal"]
        return out
    return {"ok": True, "proposal": result["proposal"]}


@router.get("/health", dependencies=[Depends(require_native_owner)])
def health():
    return {"ok": True, "ready": P.api_ready()}


@router.get("/proposals", dependencies=[Depends(require_native_owner)])
def list_proposals():
    return {"ok": True, "proposals": P.list_views()}


@router.get("/proposals/{pid}", dependencies=[Depends(require_native_owner)])
def get_proposal(pid: str):
    found = P.get_view(_id(pid))
    return {"ok": True, "proposal": found} if found else {"ok": False, "error": "unknown_proposal"}


@router.post("/proposals/{pid}/run", dependencies=[Depends(require_native_owner)])
def run_proposal(pid: str):
    return _answer(P.run(_id(pid)))


@router.post("/proposals/{pid}/cancel", dependencies=[Depends(require_native_owner)])
def cancel_proposal(pid: str):
    return _answer(P.cancel(_id(pid)))


# --- the assistant's name (Desktop sends the person's choice here; it only ever lives in memory) -------------------------


@router.get("/assistant", dependencies=[Depends(require_native_owner)])
def get_assistant():
    return {"ok": True, "name": ASSISTANT.get_name(), "default": ASSISTANT.DEFAULT_NAME, "presets": list(ASSISTANT.PRESETS)}


@router.post("/assistant", dependencies=[Depends(require_native_owner)])
def set_assistant(body: NameBody):
    out = ASSISTANT.set_name(body.name)
    return {"ok": bool(out["ok"]), "name": out["name"], **({} if out["ok"] else {"error": out["error"]})}


# --- asks for another profile: released once, by a click, to this caller only ------------------------------------------------


@router.get("/asks", dependencies=[Depends(require_native_owner)])
def list_asks():
    return {"ok": True, "asks": ASKS.list_views()}


@router.post("/asks/{pid}/release", dependencies=[Depends(require_native_owner)])
def release_ask(pid: str):
    out = ASKS.release(_id(pid))
    if "error" in out:
        return {"ok": False, "error": out["error"]}
    return {"ok": True, "ask": out["ask"]}


@router.post("/asks/{pid}/deny", dependencies=[Depends(require_native_owner)])
def deny_ask(pid: str):
    out = ASKS.deny(_id(pid))
    if "error" in out:
        return {"ok": False, "error": out["error"]}
    return {"ok": True, "ask": out["ask"]}


# Last line: from here on the tools in this same process may register proposals (see proposals.py, "api_ready").
P.mark_api_ready(True)
