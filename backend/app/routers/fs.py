"""File browsing and editing within the allowed roots, performed as the logged-in
user (see fsops): guests get 401 on every endpoint except /roots."""
from __future__ import annotations

import base64
import time

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel

from app import config, fsops
from app.auth import Identity, require_user

router = APIRouter(prefix="/api/fs", tags=["fs"])

_DU_TTL = 600.0
_du_cache: dict[tuple[str, str], tuple[float, dict]] = {}


@router.get("/roots")
def roots() -> list[dict]:
    return [{"path": str(r), "exists": r.is_dir()} for r in config.ROOTS]


@router.get("/list")
def list_dir(path: str, show_hidden: bool = False, me: Identity = Depends(require_user)) -> dict:
    return fsops.run_as(me.user, "list", path=path, show_hidden=show_hidden)


@router.get("/browse")
def browse(path: str, show_hidden: bool = False, me: Identity = Depends(require_user)) -> dict:
    """Folders and files of one directory with sizes, modification times and the
    usage of the file system holding it."""
    return fsops.run_as(me.user, "browse", path=path, show_hidden=show_hidden)


@router.get("/du")
def dir_usage(path: str, refresh: bool = False, me: Identity = Depends(require_user)) -> dict:
    """Recursive size of a directory (like du -x); stops after a time limit (truncated)."""
    key = (me.user, path)
    hit = _du_cache.get(key)
    if hit and not refresh and time.monotonic() - hit[0] < _DU_TTL:
        return {**hit[1], "cached": True}
    out = fsops.run_as(me.user, "du", timeout=60, path=path)
    if not out["truncated"]:
        _du_cache[key] = (time.monotonic(), out)
    return {**out, "cached": False}


@router.get("/read")
def read_file(path: str, offset: int = 0, limit: int = 256 << 10, tail: bool = False,
              me: Identity = Depends(require_user)) -> dict:
    """A chunk of a file: text (UTF-8, invalid bytes replaced) or, for binary
    files, a hex dump of the first bytes. tail = the last `limit` bytes."""
    return fsops.run_as(me.user, "read", path=path, offset=offset, limit=limit, tail=tail)


@router.get("/image")
def image(path: str, me: Identity = Depends(require_user)) -> Response:
    r = fsops.run_as(me.user, "image", path=path)
    return Response(base64.b64decode(r["b64"]), media_type=r["media_type"], headers={
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; script-src 'none'"})


@router.get("/mesh")
def mesh(path: str, me: Identity = Depends(require_user)) -> Response:
    """A CAD file (stl, step, stp, iges, brep) as binary STL for the 3D preview;
    STEP/IGES are tessellated with FreeCAD and cached."""
    r = fsops.run_as(me.user, "mesh", timeout=300, path=path, cache_dir=str(config.CACHE_DIR / "cad"))
    return Response(base64.b64decode(r["b64"]), media_type="model/stl",
                    headers={"X-Mesh-Source": r["source"], "Cache-Control": "private, max-age=600"})


class MkdirsRequest(BaseModel):
    parent: str
    names: list[str]


@router.post("/mkdirs")
def mkdirs(body: MkdirsRequest, me: Identity = Depends(require_user)) -> dict:
    """Create sub-folders of parent; existing or invalid names are reported, not raised."""
    _du_cache.clear()
    return fsops.run_as(me.user, "mkdirs", parent=body.parent, names=body.names)


class NewFile(BaseModel):
    parent: str
    name: str
    content: str = ""


@router.post("/file")
def new_file(body: NewFile, me: Identity = Depends(require_user)) -> dict:
    """Create a new text file (never overwrites)."""
    return fsops.run_as(me.user, "newfile", parent=body.parent, name=body.name, content=body.content)


class DeleteRequest(BaseModel):
    path: str
    recursive: bool = False


@router.post("/delete")
def delete(body: DeleteRequest, me: Identity = Depends(require_user)) -> dict:
    """Delete a file, a symlink (not its target) or a folder (non-empty only with
    recursive). Roots, the app and its data folder and their parents are refused."""
    out = fsops.run_as(me.user, "delete", timeout=600, path=body.path, recursive=body.recursive)
    _du_cache.clear()
    return out


class RenameRequest(BaseModel):
    path: str
    name: str


@router.post("/rename")
def rename(body: RenameRequest, me: Identity = Depends(require_user)) -> dict:
    """Rename a file, folder or symlink within its folder; never overwrites."""
    out = fsops.run_as(me.user, "rename", path=body.path, name=body.name)
    _du_cache.clear()
    return out


class MoveRequest(BaseModel):
    paths: list[str]
    dest: str


@router.post("/move")
def move(body: MoveRequest, me: Identity = Depends(require_user)) -> dict:
    """Move files, folders or symlinks into an existing folder inside the writable roots;
    never overwrites. Items that cannot be moved are listed in `skipped`."""
    out = fsops.run_as(me.user, "move", timeout=600, paths=body.paths, dest=body.dest)
    _du_cache.clear()
    return out


@router.get("/whoami")
def fs_whoami(me: Identity = Depends(require_user)) -> dict:
    """Account the file operations run as (sanity check of the helper setup)."""
    return {**fsops.run_as(me.user, "whoami"), "mode": config.HELPER_MODE}
