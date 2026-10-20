"""Directory browsing within the allowed roots."""
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app import cases, config
from app.paths import safe_path

router = APIRouter(prefix="/api/fs", tags=["fs"])


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
