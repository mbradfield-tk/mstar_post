"""Solver status of a case from M-Star's own run log (<case>/mstar-run-YYYY_MM_DD_HHMM.txt).

The newest log is parsed: the head gives the solver PID, version and GPU, the tail the
last progress block (time, completion %, runtime, wall time, ETA, iterations) and the end
marker ("Simulation Complete", "Simulation Stopped", "Killing process"). A log without an
end marker belongs to a running solve when its PID is alive and is an M-Star process,
otherwise the solve died (crashed or killed)."""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

HEAD = 6 * 1024
TAIL = 12 * 1024
STALL_S = 30 * 60  # a running solve whose log was not written for this long is flagged

_NUM = r"([-+0-9.eE]+)"
_PROGRESS = {
    "time_s": r"^Time \(s\) = " + _NUM, "completion_pct": r"^Completion \(%\) = " + _NUM,
    "runtime_s": r"^Runtime \(s\) = " + _NUM, "wall_h": r"^Elapsed Wall Time \(hr\) = " + _NUM,
    "eta_h": r"^Estimated Time Remaining \(hr\) = " + _NUM, "iterations": r"^Iterations = " + _NUM,
    "mups": r"^Lattice \(MUPS\) = " + _NUM,
}


def _read(path: Path, head: int, tail: int) -> tuple[str, str, int]:
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        fh.seek(0)
        h = fh.read(min(head, size))
        fh.seek(max(0, size - tail))
        t = fh.read()
    return h.decode(errors="replace"), t.decode(errors="replace"), size


def pid_alive(pid: int | None) -> bool:
    """True when the PID exists and is an M-Star solver process."""
    if not pid:
        return False
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return False
    # the executable itself (mstar, mstar-cfd-mgpu), not a path argument containing "mstar"
    exe = cmd.split(b"\0", 1)[0].rsplit(b"/", 1)[-1].lower()
    return exe.startswith(b"mstar")


def logs_of(case: Path) -> list[Path]:
    """Solver logs, oldest first: the name carries the start time (YYYY_MM_DD_HHMM), so
    lexical order is chronological; mtime breaks ties."""
    try:
        return sorted(case.glob("mstar-run-*.txt"), key=lambda p: (p.name, p.stat().st_mtime))
    except OSError:
        return []


def solve_status(case: Path, now: float | None = None) -> dict:
    """Status of the newest solver log of a case; {"state": "no log"} without one.
    state: running | stalled | complete | stopped | failed."""
    logs = logs_of(case)
    if not logs:
        return {"state": "no log", "n_logs": 0}
    log = logs[-1]
    now = now or time.time()
    try:
        head, tail, size = _read(log, HEAD, TAIL)
        mtime = log.stat().st_mtime
    except OSError as e:
        return {"state": "no log", "n_logs": len(logs), "log": log.name, "error": str(e)}
    out: dict = {"log": log.name, "log_mtime": mtime, "log_age_s": max(0.0, now - mtime), "log_size": size,
                 "n_logs": len(logs)}
    m = re.search(r"Started process with PID = (\d+)", head)
    pid = int(m.group(1)) if m else None
    out["pid"] = pid
    m = re.search(r"M-Star CFD \(([^)]+)\)", head)
    if m:
        out["version"] = m.group(1)
    m = re.search(r'Running on GPU "([^"]+)" with UUID ([0-9a-fA-F-]+)', head)
    if m:
        out["gpu"], out["gpu_uuid"] = m.group(1), m.group(2)
    m = re.search(r"mstar-run-(\d{4})_(\d{2})_(\d{2})_(\d{2})(\d{2})", log.name)
    if m:
        y, mo, d, hh, mm = map(int, m.groups())
        try:
            out["started"] = time.mktime((y, mo, d, hh, mm, 0, 0, 0, -1))
        except (OverflowError, ValueError):
            pass
    # the last progress block: values after the final "Progress:" header, iterations from the block head
    for key, pat in _PROGRESS.items():
        hits = re.findall(pat, tail, re.M)
        if hits:
            try:
                out[key] = float(hits[-1])
            except ValueError:
                pass
    lines = [ln.strip() for ln in tail.splitlines() if ln.strip()]
    out["last_lines"] = lines[-3:]
    alive = pid_alive(pid)
    out["alive"] = alive
    if "Simulation Complete" in tail:
        out["state"] = "complete"
    elif "Simulation Stopped" in tail or "Forcing process termination" in tail or "Killing process" in tail:
        out["state"] = "stopped"
    elif alive:
        out["state"] = "stalled" if now - mtime > STALL_S else "running"
    else:
        out["state"] = "failed"
        out["note"] = "log ends without a completion marker and the solver process is gone (crashed or killed)"
    return out
