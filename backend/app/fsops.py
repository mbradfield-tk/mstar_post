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
from collections.abc import Iterator
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


def helper_stale() -> bool:
    """True when the installed fs helper differs from the repo copy (needs deploy/update_helpers.sh)."""
    if config.HELPER_MODE != "sudo":
        return False
    try:
        return (config.HELPER_DIR / "fs").read_bytes() != (config.HELPER_SRC / "fs_helper.py").read_bytes()
    except OSError:
        return False


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
        raise _fail(reply)
    return reply["result"]


def try_run_as(user: str | None, op: str, **args) -> dict | None:
    try:
        return run_as(user, op, **args)
    except HTTPException:
        return None


def _sudo(user: str | None) -> bool:
    return config.HELPER_MODE == "sudo" and bool(user) and user != server_account()


def _fail(reply: dict) -> HTTPException:
    if "unknown op" in str(reply.get("error", "")) and helper_stale():
        return HTTPException(501, "the installed file helper is older than the app: an admin must run "
                                  "`sudo deploy/update_helpers.sh` on the server")
    return HTTPException(int(reply.get("status") or 500), reply.get("error") or "file operation failed")


def open_as(user: str | None, path: str) -> tuple[dict, Iterator[bytes]]:
    """(header {name, size, mtime}, chunk iterator) of a file read as the user (streamed
    through the helper in sudo mode)."""
    req = _request("cat", {"path": path})
    if _sudo(user):
        proc = subprocess.Popen([*config.SUDO, "-u", user, str(config.HELPER_DIR / "fs")],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        proc.stdin.write((json.dumps(req) + "\n").encode())
        proc.stdin.close()
        line = proc.stdout.readline()
        try:
            hdr = json.loads(line or b"{}")
        except ValueError:
            hdr = {}
        if not hdr.get("ok"):
            proc.kill()
            err = (proc.stderr.read() or b"").decode(errors="replace").strip()[-400:]
            raise _fail(hdr or {"error": f"file helper failed as {user}: {err}"})

        def chunks():
            try:
                while True:
                    b = proc.stdout.read(1 << 20)
                    if not b:
                        break
                    yield b
            finally:
                proc.stdout.close()
                proc.wait()
        return hdr, chunks()
    mod = _module()
    try:
        hdr, fh = mod.open_cat(req)
    except mod.Fail as e:
        raise HTTPException(e.status, str(e))

    def direct():
        with fh:
            while True:
                b = fh.read(1 << 20)
                if not b:
                    break
                yield b
    return hdr, direct()


def put_as(user: str | None, parent: str, name: str, src, overwrite: bool = False,
           limit: int | None = None) -> dict:
    """Write the bytes of src (binary file-like) to <parent>/<name> as the user."""
    req = _request("put", {"parent": parent, "name": name, "overwrite": overwrite, "limit": limit})
    if _sudo(user):
        proc = subprocess.Popen([*config.SUDO, "-u", user, str(config.HELPER_DIR / "fs")],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            proc.stdin.write((json.dumps(req) + "\n").encode())
            while True:
                b = src.read(1 << 20)
                if not b:
                    break
                proc.stdin.write(b)
            proc.stdin.close()
        except BrokenPipeError:
            pass  # the helper refused early: its reply says why
        out = proc.stdout.read()
        err = proc.stderr.read()
        proc.wait(timeout=60)
        try:
            reply = json.loads(out.splitlines()[0] if out else b"{}")
        except (ValueError, IndexError):
            reply = {}
        if not reply:
            raise HTTPException(500, f"file helper failed as {user}: {err.decode(errors='replace').strip()[-400:] or proc.returncode}")
        if not reply.get("ok"):
            raise _fail(reply)
        return reply["result"]
    mod = _module()
    try:
        return mod.put_from(req, src, limit)
    except mod.Fail as e:
        raise HTTPException(e.status, str(e))
