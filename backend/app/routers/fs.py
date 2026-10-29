"""File browsing and editing within the allowed roots, performed as the logged-in
user (see fsops): guests get 401 on every endpoint except /roots."""
from __future__ import annotations

import base64
import time
import zipfile
from pathlib import PurePosixPath
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response, StreamingResponse
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


def _attachment(name: str) -> dict:
    safe = name.encode("ascii", "replace").decode().replace('"', "_")
    return {"Content-Disposition": f"attachment; filename=\"{safe}\"; filename*=UTF-8''{quote(name)}"}


class _Sink:
    """Write target for zipfile that hands finished bytes to a generator."""
    def __init__(self) -> None:
        self.buf = bytearray()
        self.pos = 0
    def write(self, b: bytes) -> int:
        self.buf += b
        self.pos += len(b)
        return len(b)
    def tell(self) -> int:
        return self.pos
    def flush(self) -> None:
        pass
    def take(self) -> bytes:
        out = bytes(self.buf)
        self.buf.clear()
        return out


@router.get("/download")
def download(path: list[str] = Query(...), name: str | None = None, me: Identity = Depends(require_user)):
    """One file as an attachment, or several files (repeat `path`) streamed as a zip
    (stored, no compression; folders are not accepted). Read as the logged-in user."""
    return _download(path, name, me)


@router.post("/download")
def download_form(path: list[str] = Form(...), name: str | None = Form(None), me: Identity = Depends(require_user)):
    """Same as GET /download as a form post (the browser submits a hidden form, so long
    selections are not limited by the URL length)."""
    return _download(path, name, me)


def _download(path: list[str], name: str | None, me: Identity):
    if len(path) > 500:
        raise HTTPException(422, "at most 500 files per download")
    if len(path) == 1:
        hdr, chunks = fsops.open_as(me.user, path[0])
        return StreamingResponse(chunks, media_type="application/octet-stream",
                                 headers={**_attachment(hdr["name"]), "Content-Length": str(hdr["size"])})
    # open every file first so permission errors become a normal HTTP error, not a broken zip
    opened = [fsops.open_as(me.user, p) for p in path]
    names: dict[str, int] = {}

    def unique(n: str) -> str:
        k = names.get(n, 0)
        names[n] = k + 1
        if not k:
            return n
        stem, dot, ext = n.rpartition(".")
        return f"{stem} ({k}).{ext}" if dot and stem else f"{n} ({k})"

    def gen():
        sink = _Sink()
        with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
            for hdr, chunks in opened:
                info = zipfile.ZipInfo(unique(hdr["name"]), time.localtime(hdr["mtime"])[:6])
                info.file_size = hdr["size"]
                with z.open(info, "w", force_zip64=True) as dst:
                    for b in chunks:
                        dst.write(b)
                        if sink.pos and len(sink.buf) >= 1 << 20:
                            yield sink.take()
                yield sink.take()
        yield sink.take()
    zip_name = (name or (PurePosixPath(path[0]).parent.name or "files")) + ".zip"
    return StreamingResponse(gen(), media_type="application/zip", headers=_attachment(zip_name))


@router.post("/upload")
async def upload(parent: str = Form(...), overwrite: bool = Form(False), files: list[UploadFile] = File(...),
                 me: Identity = Depends(require_user)) -> dict:
    """Store uploaded files in `parent` (inside the writable roots) as the logged-in user;
    existing names are skipped unless overwrite. Per-file results in saved / skipped."""
    if len(files) > 200:
        raise HTTPException(422, "at most 200 files per upload")
    saved, skipped = [], []
    for f in files:
        fname = PurePosixPath(f.filename or "").name
        try:
            r = fsops.put_as(me.user, parent, fname, f.file, overwrite)
            saved.append({"name": fname, "bytes": r["bytes"]})
        except HTTPException as e:
            skipped.append({"name": fname, "reason": str(e.detail)})
        finally:
            await f.close()
    _du_cache.clear()
    return {"parent": parent, "saved": saved, "skipped": skipped}
