"""Path guards: every client-supplied path must resolve inside an allowed root."""
from pathlib import Path

from fastapi import HTTPException

from app import config


def under(path: Path, base: Path) -> bool:
    return path == base or base in path.parents


def safe_path(p: str | Path, must_exist: bool = True) -> Path:
    """Resolve p (symlinks included) and require it inside config.ROOTS."""
    if not str(p).strip():
        raise HTTPException(422, "empty path")
    try:
        path = Path(p).expanduser().resolve(strict=must_exist)
    except (OSError, RuntimeError):
        raise HTTPException(404, f"not found: {p}")
    if not any(under(path, r) for r in config.ROOTS):
        raise HTTPException(403, f"outside the allowed roots: {p}")
    return path


def safe_child(base: Path, rel: str) -> Path:
    """Resolve rel inside base (e.g. a project folder); rejects '..' escapes."""
    path = (base / rel).resolve()
    if not under(path, base.resolve()):
        raise HTTPException(403, "path escapes its folder")
    if not path.exists():
        raise HTTPException(404, f"not found: {rel}")
    return path
