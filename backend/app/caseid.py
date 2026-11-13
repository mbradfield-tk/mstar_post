"""Stable unique ids for M-Star cases across all projects.

Every case gets a random 12-hex uid the first time it enters a project. The uid is
written to <case folder>/mstar_post_case.json so it travels with the folder (renames,
moves, re-use in another project all keep the same uid) and is stored in project.json.
"""
from __future__ import annotations

import json
import secrets
import time
from pathlib import Path

from app import config

MARKER = "mstar_post_case.json"
RETRY_S = 600.0  # a marker that could not be written is tried again after this long
_refused: dict[tuple[str, str | None], float] = {}


def read_marker(case: Path) -> str | None:
    try:
        d = json.loads((case / MARKER).read_text())
    except (OSError, ValueError):
        return None
    uid = d.get("uid") if isinstance(d, dict) else None
    return uid if isinstance(uid, str) and uid else None


def write_marker(case: Path, uid: str, user: str | None) -> bool:
    """Write (or refresh) the marker as `user` (fs helper); False if not writable or
    when there is no acting user on a server with helpers (guests never write)."""
    from app import config, fsops
    if config.HELPER_MODE == "sudo" and not user:
        return False
    r = fsops.try_run_as(user, "write_marker", path=str(case), uid=uid, created_by=user or "")
    return bool(r and r.get("written"))


def known_uids() -> set[str]:
    out: set[str] = set()
    for f in config.PROJECTS_DIR.glob("*/project.json"):
        try:
            for c in json.loads(f.read_text()).get("cases", []):
                if c.get("uid"):
                    out.add(c["uid"])
        except (OSError, ValueError):
            continue
    return out


def new_uid(taken: set[str]) -> str:
    while True:
        u = secrets.token_hex(6)
        if u not in taken:
            taken.add(u)
            return u


def ensure_uids(p: dict, user: str | None = None, taken: set[str] | None = None) -> bool:
    """Give every case of p a uid (from its marker file if it has one, else new) and
    write the marker. Returns True if p changed (caller saves)."""
    changed = False
    for c in p.get("cases", []):
        folder = Path(c["path"])
        marker = read_marker(folder) if folder.is_dir() else None
        uid = marker or c.get("uid")
        if not uid:
            if taken is None:  # every project is read only when a new id is really needed
                taken = known_uids()
            uid = new_uid(taken)
        if uid != c.get("uid"):
            c["uid"], changed = uid, True
        if folder.is_dir() and (not c.get("id_written") or marker != uid):
            # a folder this user cannot write is asked again only after a while: every project
            # load would otherwise start a helper process per such case
            key, now = (c["path"], user), time.monotonic()
            if now - _refused.get(key, -RETRY_S) < RETRY_S:
                written = False
            else:
                written = write_marker(folder, uid, user)
                if written:
                    _refused.pop(key, None)
                else:
                    _refused[key] = now
            if written != c.get("id_written"):
                c["id_written"], changed = written, True
    return changed
