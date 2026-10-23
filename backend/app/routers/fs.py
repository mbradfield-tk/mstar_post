"""Directory browsing within the allowed roots."""
import os
import shutil
import stat
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import cases, config
from app.paths import safe_path, under

router = APIRouter(prefix="/api/fs", tags=["fs"])

_MAX_ENTRIES = 5000
_DU_SECONDS = 30.0
_DU_TTL = 600.0
_du_cache: dict[str, tuple[float, dict]] = {}


@router.get("/roots")
def roots() -> list[dict]:
    return [{"path": str(r), "exists": r.is_dir()} for r in config.ROOTS]


@router.get("/list")
def list_dir(path: str, show_hidden: bool = False) -> dict:
    d = safe_path(path)
    if not d.is_dir():
        raise HTTPException(422, f"not a directory: {path}")
    entries = []
    try:
        it = sorted(os.scandir(d), key=lambda e: e.name.lower())
    except PermissionError:
        raise HTTPException(403, f"permission denied: {path}")
    for e in it:
        if e.name.startswith(".") and not show_hidden:
            continue
        try:
            is_dir = e.is_dir()
        except OSError:
            continue
        if not is_dir:
            continue
        p = Path(e.path)
        entries.append({"name": e.name, "path": str(p), "is_case": cases.is_case_dir(p)})
    parent = d.parent if any(d != r and r in d.parents for r in config.ROOTS) else None
    return {"path": str(d), "parent": str(parent) if parent else None,
            "is_case": cases.is_case_dir(d), "entries": entries}


def _parent_in_roots(d: Path) -> Path | None:
    return d.parent if any(d != r and r in d.parents for r in config.ROOTS) else None


@router.get("/browse")
def browse(path: str, show_hidden: bool = False) -> dict:
    """Folders and files of one directory (read-only) with sizes, modification
    times and the usage of the file system holding it."""
    d = safe_path(path)
    if not d.is_dir():
        raise HTTPException(422, f"not a directory: {path}")
    try:
        it = list(os.scandir(d))
    except PermissionError:
        raise HTTPException(403, f"permission denied: {path}")
    entries = []
    for e in sorted(it, key=lambda e: e.name.lower()):
        if e.name.startswith(".") and not show_hidden:
            continue
        try:
            st = e.stat(follow_symlinks=False)
            is_dir = e.is_dir(follow_symlinks=False)
        except OSError:
            continue
        entries.append({"name": e.name, "path": e.path, "dir": is_dir, "link": e.is_symlink(),
                        "size": None if is_dir else st.st_size, "mtime": st.st_mtime,
                        "is_case": is_dir and cases.is_case_dir(Path(e.path))})
        if len(entries) >= _MAX_ENTRIES:
            break
    du = shutil.disk_usage(d)
    parent = _parent_in_roots(d)
    return {"path": str(d), "parent": str(parent) if parent else None, "is_case": cases.is_case_dir(d),
            "entries": entries, "truncated": len(entries) >= _MAX_ENTRIES,
            "writable": any(under(d, r) for r in config.WRITE_ROOTS) and os.access(d, os.W_OK),
            "disk": {"total": du.total, "used": du.used, "free": du.free}}


@router.get("/du")
def dir_usage(path: str, refresh: bool = False) -> dict:
    """Recursive size of a directory (like du -x: allocated bytes, symlinks not
    followed, stays on one file system); stops after a time limit (truncated)."""
    d = safe_path(path)
    if not d.is_dir():
        raise HTTPException(422, f"not a directory: {path}")
    hit = _du_cache.get(str(d))
    if hit and not refresh and time.monotonic() - hit[0] < _DU_TTL:
        return {**hit[1], "cached": True}
    t0 = time.monotonic()
    dev = d.stat().st_dev
    alloc = apparent = n_files = n_dirs = 0
    truncated = False
    stack = [str(d)]
    while stack:
        if time.monotonic() - t0 > _DU_SECONDS:
            truncated = True
            break
        try:
            it = os.scandir(stack.pop())
        except OSError:
            continue
        with it:
            for e in it:
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISDIR(st.st_mode):
                    if st.st_dev == dev:
                        n_dirs += 1
                        stack.append(e.path)
                    continue
                n_files += 1
                apparent += st.st_size
                alloc += getattr(st, "st_blocks", 0) * 512
    out = {"path": str(d), "bytes": alloc, "apparent": apparent, "files": n_files, "dirs": n_dirs,
           "truncated": truncated, "seconds": round(time.monotonic() - t0, 2)}
    if not truncated:
        _du_cache[str(d)] = (time.monotonic(), out)
    return {**out, "cached": False}


# ------------------------------------------------------------------ view (read-only)

_READ_MAX = 4 << 20
_IMAGES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
           ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml"}


def _regular_file(path: str) -> Path:
    p = safe_path(path)
    if not p.is_file():
        raise HTTPException(422, f"not a file: {path}")
    return p


@router.get("/read")
def read_file(path: str, offset: int = 0, limit: int = 256 << 10, tail: bool = False) -> dict:
    """A chunk of a file: text (UTF-8, invalid bytes replaced) or, for binary
    files, a hex dump of the first bytes. tail = the last `limit` bytes."""
    p = _regular_file(path)
    limit = max(1, min(limit, _READ_MAX))
    size = p.stat().st_size
    start = max(0, size - limit) if tail else max(0, min(offset, size))
    try:
        with open(p, "rb") as fh:
            head = fh.read(8192)
            fh.seek(start)
            data = fh.read(limit)
    except PermissionError:
        raise HTTPException(403, f"permission denied: {path}")
    binary = b"\0" in head
    if binary:
        data = data[:4096]
        lines = [f"{start + i:08x}  {data[i:i + 16].hex(' '):<47}  "
                 + "".join(chr(b) if 32 <= b < 127 else "." for b in data[i:i + 16])
                 for i in range(0, len(data), 16)]
        text = "\n".join(lines)
    else:
        text = data.decode("utf-8", errors="replace")
    return {"path": str(p), "size": size, "mtime": p.stat().st_mtime, "offset": start,
            "end": start + len(data), "binary": binary, "text": text,
            "image": p.suffix.lower() in _IMAGES}


@router.get("/image")
def image(path: str) -> FileResponse:
    p = _regular_file(path)
    kind = _IMAGES.get(p.suffix.lower())
    if not kind:
        raise HTTPException(422, "not an image")
    return FileResponse(p, media_type=kind, headers={
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; script-src 'none'"})


# ------------------------------------------------------------------ create / delete

_MAX_TEXT = 1 << 20
_APP_DIR = Path(__file__).resolve().parents[3]


def _writable_dir(p: str) -> Path:
    d = safe_path(p)
    if not d.is_dir():
        raise HTTPException(422, f"not a directory: {p}")
    if not any(under(d, r) for r in config.WRITE_ROOTS):
        raise HTTPException(403, "not writable here; writable roots: "
                            + ", ".join(map(str, config.WRITE_ROOTS)))
    return d


def _check_name(name: str) -> str:
    n = name.strip()
    if not n or n in (".", "..") or "/" in n or "\0" in n or len(n.encode()) > 255:
        raise ValueError(f"invalid name: {name!r}")
    return n


class MkdirsRequest(BaseModel):
    parent: str
    names: list[str]


@router.post("/mkdirs")
def mkdirs(body: MkdirsRequest) -> dict:
    """Create sub-folders of parent; existing or invalid names are reported, not raised."""
    d = _writable_dir(body.parent)
    if len(body.names) > 1000:
        raise HTTPException(422, "at most 1000 folders at once")
    created, skipped = [], []
    for raw in body.names:
        try:
            n = _check_name(raw)
            (d / n).mkdir()
            created.append(n)
        except FileExistsError:
            skipped.append({"name": raw, "reason": "exists"})
        except (ValueError, OSError) as e:
            skipped.append({"name": raw, "reason": str(e)})
    return {"parent": str(d), "created": created, "skipped": skipped}


class NewFile(BaseModel):
    parent: str
    name: str
    content: str = ""


@router.post("/file")
def new_file(body: NewFile) -> dict:
    """Create a new text file (never overwrites)."""
    d = _writable_dir(body.parent)
    if len(body.content.encode()) > _MAX_TEXT:
        raise HTTPException(422, "content larger than 1 MB")
    try:
        p = d / _check_name(body.name)
        with open(p, "x") as fh:
            fh.write(body.content)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except FileExistsError:
        raise HTTPException(409, f"already exists: {body.name}")
    return {"path": str(p)}


class DeleteRequest(BaseModel):
    path: str
    recursive: bool = False


def _modifiable(path: str, verb: str) -> Path:
    """An existing entry in a writable folder that is not a root, the app or its
    data folder (or a parent of these); symlinks are returned unresolved."""
    raw = Path(path)
    if not raw.is_absolute() or ".." in raw.parts:
        raise HTTPException(422, "absolute path without '..' required")
    target = _writable_dir(str(raw.parent)) / raw.name
    if not target.exists() and not target.is_symlink():
        raise HTTPException(404, f"not found: {path}")
    protected = [*config.ROOTS, *config.WRITE_ROOTS, config.DATA_DIR, _APP_DIR]
    if not target.is_symlink() and any(under(p.resolve(), target.resolve()) for p in protected):
        raise HTTPException(403, f"refusing to {verb} a root, the app or its data folder")
    return target


@router.post("/delete")
def delete(body: DeleteRequest) -> dict:
    """Delete a file, a symlink (not its target) or a folder (non-empty only with
    recursive). Roots, the app and its data folder and their parents are refused."""
    target = _modifiable(body.path, "delete")
    try:
        if target.is_symlink() or not target.is_dir():
            target.unlink()
        elif body.recursive:
            shutil.rmtree(target)
        else:
            target.rmdir()
    except OSError as e:
        if not body.recursive and target.is_dir() and any(target.iterdir()):
            raise HTTPException(409, "folder is not empty")
        raise HTTPException(500, str(e))
    _du_cache.clear()
    return {"deleted": str(target)}


class RenameRequest(BaseModel):
    path: str
    name: str


@router.post("/rename")
def rename(body: RenameRequest) -> dict:
    """Rename a file, folder or symlink within its folder; never overwrites."""
    target = _modifiable(body.path, "rename")
    try:
        dest = target.parent / _check_name(body.name)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if dest == target:
        return {"path": str(dest)}
    if dest.exists() or dest.is_symlink():
        raise HTTPException(409, f"already exists: {dest.name}")
    try:
        target.rename(dest)
    except OSError as e:
        raise HTTPException(500, str(e))
    _du_cache.clear()
    return {"path": str(dest)}
