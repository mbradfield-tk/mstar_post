"""GPU status: every GPU of the server with its load, memory and the processes on
it (nvidia-smi; the owner and command line of each process come from /proc).
Readable by guests: nothing here is secret and it helps everyone pick a free GPU."""
from __future__ import annotations

import os
import pwd
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["gpus"])

_GPU_FIELDS = ("index", "uuid", "name", "memory.total", "memory.used", "utilization.gpu",
               "temperature.gpu", "power.draw", "power.limit", "clocks.sm")
_APP_FIELDS = ("gpu_uuid", "pid", "used_memory", "process_name")
_cache: tuple[float, dict] | None = None
_TTL = 2.0


def _smi(args: list[str]) -> list[list[str]]:
    out = subprocess.run(["nvidia-smi", *args, "--format=csv,noheader,nounits"],
                         capture_output=True, text=True, timeout=10, check=True).stdout
    return [[c.strip() for c in ln.split(",")] for ln in out.strip().splitlines() if ln.strip()]


def _num(v: str) -> float | None:
    try:
        return float(v)
    except ValueError:  # "[N/A]", "[Not Supported]"
        return None


def _proc(pid: int) -> dict:
    """Owner, start time, cwd and command line of a process (what /proc lets us read)."""
    d: dict = {"user": None, "cmdline": None, "cwd": None, "started": None}
    base = Path(f"/proc/{pid}")
    try:
        st = base.stat()
        d["user"] = pwd.getpwuid(st.st_uid).pw_name
    except (OSError, KeyError):
        return d
    try:
        d["cmdline"] = " ".join(x for x in (base / "cmdline").read_bytes().decode(errors="replace").split("\0") if x)[:400]
    except OSError:
        pass
    try:
        d["cwd"] = os.readlink(base / "cwd")  # only readable for one's own processes (or as root)
    except OSError:
        pass
    try:
        ticks = int((base / "stat").read_text().rsplit(")", 1)[1].split()[19])
        hz = os.sysconf("SC_CLK_TCK")
        boot = next(float(ln.split()[1]) for ln in Path("/proc/stat").read_text().splitlines() if ln.startswith("btime"))
        d["started"] = boot + ticks / hz
    except (OSError, ValueError, IndexError, StopIteration):
        pass
    return d


def snapshot() -> dict:
    try:
        gpus = _smi([f"--query-gpu={','.join(_GPU_FIELDS)}"])
    except (OSError, subprocess.SubprocessError) as e:
        return {"available": False, "error": f"nvidia-smi: {e}", "gpus": [], "time": time.time()}
    try:
        apps = _smi([f"--query-compute-apps={','.join(_APP_FIELDS)}"])
    except (OSError, subprocess.SubprocessError):
        apps = []
    by_uuid: dict[str, list[dict]] = {}
    for row in apps:
        if len(row) < 4:
            continue
        uuid, pid, mem, name = row[0], int(row[1]), _num(row[2]), ",".join(row[3:])
        by_uuid.setdefault(uuid, []).append({"pid": pid, "memory_used_mib": mem, "name": name, **_proc(pid)})
    out = []
    for row in gpus:
        if len(row) < len(_GPU_FIELDS):
            continue
        idx, uuid, name = int(row[0]), row[1], row[2]
        total, used = _num(row[3]), _num(row[4])
        free_pct = (100.0 * (total - used) / total) if total and used is not None else None
        procs = sorted(by_uuid.get(uuid, []), key=lambda p: -(p["memory_used_mib"] or 0))
        out.append({"index": idx, "uuid": uuid, "name": name,
                    "memory_total_mib": total, "memory_used_mib": used,
                    "memory_free_mib": (total - used) if total and used is not None else None,
                    "memory_free_pct": free_pct, "utilization_pct": _num(row[5]),
                    "temperature_c": _num(row[6]), "power_w": _num(row[7]), "power_limit_w": _num(row[8]),
                    "clock_mhz": _num(row[9]), "processes": procs,
                    "users": sorted({p["user"] for p in procs if p["user"]})})
    return {"available": True, "gpus": out, "time": time.time(), "host": os.uname().nodename}


@router.get("/gpus")
def gpus() -> dict:
    global _cache
    now = time.monotonic()
    if _cache and now - _cache[0] < _TTL:
        return _cache[1]
    snap = snapshot()
    _cache = (now, snap)
    return snap
