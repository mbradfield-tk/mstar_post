#!/usr/bin/python3
"""M-Star Post file helper: file-system operations performed as the calling user.

Installed root-owned as /usr/local/libexec/mstar_post/fs and run by the service
account through `sudo -n -u <user> fs` (see deploy/sudoers.d/mstar_post), so every
operation is checked by the kernel against that user's own permissions. The same
module is imported in-process by the backend when no helpers are installed
(single-user / development mode).

Protocol: one JSON request on stdin {"op": ..., ...}; one JSON reply on stdout
{"ok": true, "result": ...} or {"ok": false, "status": <http code>, "error": ...}.
Self-contained on purpose: no imports from the app tree.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import signal
import stat
import sys
import time
from pathlib import Path

CONF = Path("/etc/mstar_post/helper.conf")
DEFAULT_ROOTS = ["/data", "/data2"]
MAX_ENTRIES = 5000
DU_SECONDS = 30.0
READ_MAX = 4 << 20
IMAGE_MAX = 32 << 20
MAX_TEXT = 1 << 20
IMAGES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
          ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml"}
MARKER = "mstar_post_case.json"
MESH_MAX = 200 << 20       # largest STL returned (bytes)
STEP_EXT = {".step", ".stp", ".iges", ".igs", ".brep", ".brp"}
FREECAD = ["/usr/bin/freecadcmd", "/usr/bin/FreeCADCmd", "freecadcmd"]


class Fail(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def _under(path: Path, base: Path) -> bool:
    return path == base or base in path.parents


class Ctx:
    """Allowed roots. Under sudo they come from the root-owned conf (the caller
    must not widen them); in-process the backend passes its own."""

    def __init__(self, req: dict):
        conf = {}
        if CONF.is_file():
            try:
                conf = json.loads(CONF.read_text())
            except ValueError:
                conf = {}
        trusted = os.environ.get("SUDO_USER") is None
        roots = (req.get("roots") if trusted else None) or conf.get("roots") or DEFAULT_ROOTS
        wroots = (req.get("write_roots") if trusted else None) or conf.get("write_roots") or roots
        self.roots = [Path(r).resolve() for r in roots]
        self.write_roots = [Path(r).resolve() for r in wroots]
        # extra never-delete paths (the app, its data folder); only ever narrows, so always accepted
        self.protected = [Path(p).resolve() for p in (req.get("protected") or [])]

    def safe(self, p: str, must_exist: bool = True) -> Path:
        if not str(p).strip():
            raise Fail(422, "empty path")
        try:
            path = Path(p).expanduser().resolve(strict=must_exist)
        except (OSError, RuntimeError):
            raise Fail(404, f"not found: {p}")
        if not any(_under(path, r) for r in self.roots):
            raise Fail(403, f"outside the allowed roots: {p}")
        return path

    def writable_dir(self, p: str) -> Path:
        d = self.safe(p)
        if not d.is_dir():
            raise Fail(422, f"not a directory: {p}")
        if not any(_under(d, r) for r in self.write_roots):
            raise Fail(403, "not writable here; writable roots: " + ", ".join(map(str, self.write_roots)))
        return d

    def modifiable(self, path: str, verb: str) -> Path:
        raw = Path(path)
        if not raw.is_absolute() or ".." in raw.parts:
            raise Fail(422, "absolute path without '..' required")
        target = self.writable_dir(str(raw.parent)) / raw.name
        if not target.exists() and not target.is_symlink():
            raise Fail(404, f"not found: {path}")
        protected = [*self.roots, *self.write_roots, *self.protected]
        if not target.is_symlink() and any(_under(p, target.resolve()) for p in protected):
            raise Fail(403, f"refusing to {verb} a root, the app or its data folder")
        return target


def is_case_dir(d: Path) -> bool:
    try:
        return (d / "input.xml").is_file() or (d / "out" / "Stats").is_dir() \
            or (d / "Stats").is_dir() or any(d.glob("*.msb"))
    except OSError:
        return False


def check_name(name: str) -> str:
    n = name.strip()
    if not n or n in (".", "..") or "/" in n or "\0" in n or len(n.encode()) > 255:
        raise Fail(422, f"invalid name: {name!r}")
    return n


def _parent_in_roots(ctx: Ctx, d: Path) -> Path | None:
    return d.parent if any(d != r and r in d.parents for r in ctx.roots) else None


# ------------------------------------------------------------------ operations

def op_list(ctx: Ctx, req: dict) -> dict:
    d = ctx.safe(req["path"])
    if not d.is_dir():
        raise Fail(422, f"not a directory: {req['path']}")
    try:
        it = sorted(os.scandir(d), key=lambda e: e.name.lower())
    except PermissionError:
        raise Fail(403, f"permission denied: {req['path']}")
    entries = []
    for e in it:
        if e.name.startswith(".") and not req.get("show_hidden"):
            continue
        try:
            if not e.is_dir():
                continue
        except OSError:
            continue
        entries.append({"name": e.name, "path": e.path, "is_case": is_case_dir(Path(e.path))})
    parent = _parent_in_roots(ctx, d)
    return {"path": str(d), "parent": str(parent) if parent else None,
            "is_case": is_case_dir(d), "entries": entries}


def op_browse(ctx: Ctx, req: dict) -> dict:
    d = ctx.safe(req["path"])
    if not d.is_dir():
        raise Fail(422, f"not a directory: {req['path']}")
    try:
        it = list(os.scandir(d))
    except PermissionError:
        raise Fail(403, f"permission denied: {req['path']}")
    entries = []
    for e in sorted(it, key=lambda e: e.name.lower()):
        if e.name.startswith(".") and not req.get("show_hidden"):
            continue
        try:
            st = e.stat(follow_symlinks=False)
            is_dir = e.is_dir(follow_symlinks=False)
        except OSError:
            continue
        entries.append({"name": e.name, "path": e.path, "dir": is_dir, "link": e.is_symlink(),
                        "size": None if is_dir else st.st_size, "mtime": st.st_mtime,
                        "is_case": is_dir and is_case_dir(Path(e.path))})
        if len(entries) >= MAX_ENTRIES:
            break
    du = shutil.disk_usage(d)
    parent = _parent_in_roots(ctx, d)
    return {"path": str(d), "parent": str(parent) if parent else None, "is_case": is_case_dir(d),
            "entries": entries, "truncated": len(entries) >= MAX_ENTRIES,
            "writable": any(_under(d, r) for r in ctx.write_roots) and os.access(d, os.W_OK),
            "disk": {"total": du.total, "used": du.used, "free": du.free}}


def op_du(ctx: Ctx, req: dict) -> dict:
    d = ctx.safe(req["path"])
    if not d.is_dir():
        raise Fail(422, f"not a directory: {req['path']}")
    t0 = time.monotonic()
    dev = d.stat().st_dev
    alloc = apparent = n_files = n_dirs = 0
    truncated = False
    stack = [str(d)]
    while stack:
        if time.monotonic() - t0 > DU_SECONDS:
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
    return {"path": str(d), "bytes": alloc, "apparent": apparent, "files": n_files, "dirs": n_dirs,
            "truncated": truncated, "seconds": round(time.monotonic() - t0, 2)}


def _regular_file(ctx: Ctx, path: str) -> Path:
    p = ctx.safe(path)
    if not p.is_file():
        raise Fail(422, f"not a file: {path}")
    return p


def op_read(ctx: Ctx, req: dict) -> dict:
    p = _regular_file(ctx, req["path"])
    limit = max(1, min(int(req.get("limit") or 256 << 10), READ_MAX))
    size = p.stat().st_size
    start = max(0, size - limit) if req.get("tail") else max(0, min(int(req.get("offset") or 0), size))
    try:
        with open(p, "rb") as fh:
            head = fh.read(8192)
            fh.seek(start)
            data = fh.read(limit)
    except PermissionError:
        raise Fail(403, f"permission denied: {req['path']}")
    binary = b"\0" in head
    if binary:
        data = data[:4096]
        text = "\n".join(f"{start + i:08x}  {data[i:i + 16].hex(' '):<47}  "
                         + "".join(chr(b) if 32 <= b < 127 else "." for b in data[i:i + 16])
                         for i in range(0, len(data), 16))
    else:
        text = data.decode("utf-8", errors="replace")
    return {"path": str(p), "size": size, "mtime": p.stat().st_mtime, "offset": start,
            "end": start + len(data), "binary": binary, "text": text,
            "image": p.suffix.lower() in IMAGES}


def op_image(ctx: Ctx, req: dict) -> dict:
    p = _regular_file(ctx, req["path"])
    kind = IMAGES.get(p.suffix.lower())
    if not kind:
        raise Fail(422, "not an image")
    if p.stat().st_size > IMAGE_MAX:
        raise Fail(413, "image larger than 32 MB")
    try:
        data = p.read_bytes()
    except PermissionError:
        raise Fail(403, f"permission denied: {req['path']}")
    return {"media_type": kind, "b64": base64.b64encode(data).decode()}


def op_mkdirs(ctx: Ctx, req: dict) -> dict:
    d = ctx.writable_dir(req["parent"])
    names = req.get("names") or []
    if len(names) > 1000:
        raise Fail(422, "at most 1000 folders at once")
    created, skipped = [], []
    for raw in names:
        try:
            n = check_name(raw)
            (d / n).mkdir()
            created.append(n)
        except FileExistsError:
            skipped.append({"name": raw, "reason": "exists"})
        except Fail as e:
            skipped.append({"name": raw, "reason": str(e)})
        except OSError as e:
            skipped.append({"name": raw, "reason": str(e)})
    return {"parent": str(d), "created": created, "skipped": skipped}


def op_newfile(ctx: Ctx, req: dict) -> dict:
    d = ctx.writable_dir(req["parent"])
    content = req.get("content") or ""
    if len(content.encode()) > MAX_TEXT:
        raise Fail(422, "content larger than 1 MB")
    p = d / check_name(req["name"])
    try:
        with open(p, "x") as fh:
            fh.write(content)
    except FileExistsError:
        raise Fail(409, f"already exists: {req['name']}")
    except OSError as e:
        raise Fail(403 if isinstance(e, PermissionError) else 500, str(e))
    return {"path": str(p)}


def op_delete(ctx: Ctx, req: dict) -> dict:
    target = ctx.modifiable(req["path"], "delete")
    recursive = bool(req.get("recursive"))
    try:
        if target.is_symlink() or not target.is_dir():
            target.unlink()
        elif recursive:
            shutil.rmtree(target)
        else:
            target.rmdir()
    except OSError as e:
        if not recursive and target.is_dir() and any(target.iterdir()):
            raise Fail(409, "folder is not empty")
        raise Fail(403 if isinstance(e, PermissionError) else 500, str(e))
    return {"deleted": str(target)}


def op_rename(ctx: Ctx, req: dict) -> dict:
    target = ctx.modifiable(req["path"], "rename")
    dest = target.parent / check_name(req["name"])
    if dest == target:
        return {"path": str(dest)}
    if dest.exists() or dest.is_symlink():
        raise Fail(409, f"already exists: {dest.name}")
    try:
        target.rename(dest)
    except OSError as e:
        raise Fail(403 if isinstance(e, PermissionError) else 500, str(e))
    return {"path": str(dest)}


def op_move(ctx: Ctx, req: dict) -> dict:
    """Move files/folders/symlinks into an existing folder (same guards as rename;
    never overwrites, a folder cannot be moved into itself). Per-item skips are reported."""
    dest_dir = ctx.writable_dir(req["dest"])
    paths = req.get("paths") or []
    if len(paths) > 1000:
        raise Fail(422, "at most 1000 items at once")
    moved, skipped = [], []
    for raw in paths:
        try:
            target = ctx.modifiable(raw, "move")
            dest = dest_dir / target.name
            if dest == target:
                skipped.append({"path": raw, "reason": "already there"})
                continue
            if not target.is_symlink() and target.is_dir() and _under(dest_dir, target.resolve()):
                raise Fail(422, "cannot move a folder into itself")
            if dest.exists() or dest.is_symlink():
                raise Fail(409, f"already exists in the destination: {dest.name}")
            shutil.move(str(target), str(dest))
            moved.append(str(dest))
        except Fail as e:
            skipped.append({"path": raw, "reason": str(e)})
        except OSError as e:
            skipped.append({"path": raw, "reason": str(e)})
    return {"dest": str(dest_dir), "moved": moved, "skipped": skipped}


def op_write_marker(ctx: Ctx, req: dict) -> dict:
    """Write the case-id marker into a case folder (idempotent); ok=False when not writable."""
    case = ctx.safe(req["path"])
    if not case.is_dir():
        raise Fail(422, "not a directory")
    uid = str(req["uid"])
    try:
        old = json.loads((case / MARKER).read_text())
        if not isinstance(old, dict):
            old = {}
    except (OSError, ValueError):
        old = {}
    if old.get("uid") == uid:
        return {"written": True}
    d = {**old, "uid": uid, "app": "mstar_post", "created": old.get("created") or time.time(),
         "created_by": old.get("created_by") or req.get("created_by") or "", "case_folder": case.name}
    try:
        tmp = case / (MARKER + ".tmp")
        tmp.write_text(json.dumps(d, indent=2))
        tmp.replace(case / MARKER)
    except OSError:
        return {"written": False}
    return {"written": True}


def op_kill(ctx: Ctx, req: dict) -> dict:
    """Signal a process group of the calling user (jobs started on their behalf)."""
    pgid, sig = int(req["pgid"]), int(req.get("sig") or signal.SIGTERM)
    if pgid <= 1:
        raise Fail(422, "invalid process group")
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        return {"signalled": False}
    except PermissionError:
        raise Fail(403, "not your process group")
    return {"signalled": True}


def op_mesh(ctx: Ctx, req: dict) -> dict:
    """A CAD file as binary STL (base64): STL files as they are; STEP/IGES/BREP are
    tessellated with FreeCAD (freecadcmd) into a cache file next to the request's
    cache_dir (keyed by path, size and mtime) so the conversion runs once."""
    p = _regular_file(ctx, req["path"])
    ext = p.suffix.lower()
    st = p.stat()
    if ext == ".stl":
        if st.st_size > MESH_MAX:
            raise Fail(413, "STL larger than 200 MB")
        try:
            data = p.read_bytes()
        except PermissionError:
            raise Fail(403, f"permission denied: {req['path']}")
        return {"b64": base64.b64encode(data).decode(), "source": "stl", "bytes": len(data)}
    if ext not in STEP_EXT:
        raise Fail(422, "not a CAD file (stl, step, stp, iges, igs, brep)")
    import hashlib
    import shutil as _sh
    import subprocess
    cache_dir = Path(req.get("cache_dir") or (Path.home() / ".cache" / "mstar_post"))
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(cache_dir, 0o2775)  # shared between the service account and the users (group mstar)
    except OSError:
        pass
    if not os.access(cache_dir, os.W_OK):  # not shared: fall back to a private cache
        cache_dir = Path.home() / ".cache" / "mstar_post"
        cache_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(f"{p}|{st.st_size}|{st.st_mtime_ns}|{req.get('deflection', 0.5)}".encode()).hexdigest()[:20]
    out = cache_dir / f"cad_{key}.stl"
    if not out.is_file():
        exe = next((e for e in FREECAD if _sh.which(e) or Path(e).is_file()), None)
        if exe is None:
            raise Fail(501, "STEP preview needs FreeCAD (freecadcmd) on the server")
        # LinearDeflection is absolute (model units, usually mm): 0.5 mm keeps parts crisp and small
        script = ("import FreeCAD, Part, MeshPart\n"
                  f"s = Part.Shape(); s.read({str(p)!r})\n"
                  f"m = MeshPart.meshFromShape(Shape=s, LinearDeflection={float(req.get('deflection', 0.5))}, AngularDeflection=0.35, Relative=False)\n"
                  f"m.write({str(out) + '.tmp.stl'!r})\n")
        try:
            r = subprocess.run([exe, "-c", script], capture_output=True, text=True, timeout=float(req.get("timeout", 240)),
                               env={"HOME": str(cache_dir), "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "QT_QPA_PLATFORM": "offscreen"})
        except subprocess.TimeoutExpired:
            raise Fail(504, "STEP conversion timed out")
        tmp = Path(str(out) + ".tmp.stl")
        if r.returncode != 0 or not tmp.is_file():
            raise Fail(500, f"STEP conversion failed: {(r.stderr or r.stdout).strip()[-600:]}")
        tmp.replace(out)
    data = out.read_bytes()
    if len(data) > MESH_MAX:
        raise Fail(413, "tessellated mesh larger than 200 MB; the part is too detailed to preview")
    return {"b64": base64.b64encode(data).decode(), "source": "freecad", "bytes": len(data)}


def op_whoami(ctx: Ctx, req: dict) -> dict:
    import pwd
    return {"uid": os.getuid(), "user": pwd.getpwuid(os.getuid()).pw_name}


OPS = {"list": op_list, "browse": op_browse, "du": op_du, "read": op_read, "image": op_image,
       "mkdirs": op_mkdirs, "newfile": op_newfile, "delete": op_delete, "rename": op_rename,
       "move": op_move,
       "write_marker": op_write_marker, "kill": op_kill, "whoami": op_whoami, "mesh": op_mesh}


def handle(req: dict) -> dict:
    """Run one request; the reply dict is what main() prints."""
    try:
        op = OPS.get(req.get("op"))
        if op is None:
            raise Fail(422, f"unknown op {req.get('op')!r}")
        return {"ok": True, "result": op(Ctx(req), req)}
    except Fail as e:
        return {"ok": False, "status": e.status, "error": str(e)}
    except KeyError as e:
        return {"ok": False, "status": 422, "error": f"missing field {e}"}
    except Exception as e:  # never leak a traceback to the caller
        return {"ok": False, "status": 500, "error": f"{type(e).__name__}: {e}"}


def main() -> int:
    if os.geteuid() == 0:
        print(json.dumps({"ok": False, "status": 500, "error": "refusing to run as root"}))
        return 2
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        print(json.dumps({"ok": False, "status": 422, "error": "invalid JSON request"}))
        return 2
    os.umask(0o002)  # files made on the user's behalf stay deletable by the service group
    print(json.dumps(handle(req)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
