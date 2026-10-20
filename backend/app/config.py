"""Server configuration from environment variables."""
import os
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parents[3]  # /data/mstar/python_tools


def _paths(var: str, default: str) -> list[Path]:
    return [Path(p).resolve() for p in os.environ.get(var, default).split(":") if p]


def _tool_python(tool: str) -> str:
    venv = TOOLS_DIR / tool / ".venv" / "bin" / "python"
    return str(venv) if venv.is_file() else sys.executable


# browsing and case access are restricted to these trees
ROOTS = _paths("MSTAR_POST_ROOTS", "/data:/data2")
DATA_DIR = Path(os.environ.get("MSTAR_POST_DATA", TOOLS_DIR.parent / "mstar_post_data")).resolve()
PROJECTS_DIR = DATA_DIR / "projects"
CACHE_DIR = DATA_DIR / "cache"
DB_PATH = DATA_DIR / "jobs.db"
MAX_JOBS = int(os.environ.get("MSTAR_POST_MAX_JOBS", "1"))

STATS_SUMMARY = Path(os.environ.get(
    "MSTAR_STATS_SUMMARY", TOOLS_DIR / "mstar_stats_summary" / "mstar_stats_summary.py"))
STATS_SUMMARY_PY = os.environ.get("MSTAR_STATS_SUMMARY_PY", sys.executable)
ZONER = Path(os.environ.get("MSTAR_ZONER", TOOLS_DIR / "cfd_zoner" / "cfd_zoner.py"))
ZONER_PY = os.environ.get("MSTAR_ZONER_PY", _tool_python("cfd_zoner"))
CALC_UA = Path(os.environ.get("MSTAR_CALC_UA", TOOLS_DIR / "heat_transfer" / "calc_ua.py"))
CALC_UA_PY = os.environ.get("MSTAR_CALC_UA_PY", _tool_python("heat_transfer"))


def ensure_dirs() -> None:
    for d in (PROJECTS_DIR, CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)
