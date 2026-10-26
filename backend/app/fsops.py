"""File operations on behalf of a user.

sudo mode: `sudo -n -u <user> <HELPER_DIR>/fs` with a JSON request, so the kernel
applies that user's permissions. direct mode (no helpers installed): the same helper
module (deploy/helpers/fs_helper.py) is imported and called in-process, i.e. the
server account's permissions apply.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
from functools import lru_cache
from pathlib import Path

from fastapi import HTTPException

from app import config
from app.auth import server_account

_APP_DIR = Path(__file__).resolve().parents[2]


@lru_cache(maxsize=1)
def _module():
    spec = importlib.util.spec_from_file_location("mstar_post_fs_helper", config.HELPER_SRC / "fs_helper.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _request(op: str, args: dict) -> dict:
    return {"op": op, **args, "roots": [str(r) for r in config.ROOTS],
            "write_roots": [str(r) for r in config.WRITE_ROOTS],
            "protected": [str(config.DATA_DIR), str(_APP_DIR)]}


def run_as(user: str | None, op: str, timeout: float = 90, **args) -> dict:
    """Result of one helper op, or HTTPException with the helper's status."""
    req = _request(op, args)
    if config.HELPER_MODE == "sudo" and user and user != server_account():
        try:
            r = subprocess.run([*config.SUDO, "-u", user, str(config.HELPER_DIR / "fs")],
                               input=json.dumps(req), capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise HTTPException(504, f"file operation timed out after {timeout:g} s")
        try:
            reply = json.loads(r.stdout or "{}")
        except ValueError:
            reply = {}
        if not reply:
            raise HTTPException(500, f"file helper failed as {user}: {(r.stderr or '').strip()[-400:] or r.returncode}")
    else:
        reply = _module().handle(req)
    if not reply.get("ok"):
        raise HTTPException(int(reply.get("status") or 500), reply.get("error") or "file operation failed")
    return reply["result"]


def try_run_as(user: str | None, op: str, **args) -> dict | None:
    try:
        return run_as(user, op, **args)
    except HTTPException:
        return None
