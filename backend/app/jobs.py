"""Background job queue: SQLite records, detached subprocesses, log files.

A job runs a list of commands sequentially in its own process group, with
stdout/stderr appended to <run dir>/job.log. Status changes are broadcast to
WebSocket subscribers.
"""
from __future__ import annotations

import asyncio
import getpass
import json
import os
import re
import shutil
import signal
import sqlite3
import time
import uuid
from pathlib import Path

from app import config
from app.paths import under

_COLS = ("id", "project", "task", "label", "status", "commands", "run_dir",
         "created_at", "started_at", "finished_at", "returncode", "pid", "step",
         "params", "error", "user")
_KILL_GRACE_S = 10.0


def clean_user(name: str | None) -> str:
    """Display name of the person who started a job: the browser's X-User header
    (printable, <= 64 chars) or, without one, the account running the server."""
    n = re.sub(r"[^\w .@'\-]", "", (name or "").strip())[:64].strip()
    if n:
        return n
    try:
        return getpass.getuser()
    except Exception:
        return "unknown"


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(config.DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    return c


def init_db() -> None:
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, project TEXT, task TEXT, label TEXT, status TEXT,
            commands TEXT, run_dir TEXT, created_at REAL, started_at REAL,
            finished_at REAL, returncode INTEGER, pid INTEGER, step INTEGER,
            params TEXT, error TEXT, user TEXT)""")
        if "user" not in {r[1] for r in c.execute("PRAGMA table_info(jobs)")}:  # older databases
            c.execute("ALTER TABLE jobs ADD COLUMN user TEXT")


def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    d["commands"] = json.loads(d["commands"] or "[]")
    d["params"] = json.loads(d["params"] or "{}")
    return d


def get_job(job_id: str) -> dict | None:
    with _conn() as c:
        return _row(c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())


def list_jobs(project: str | None = None) -> list[dict]:
    with _conn() as c:
        q = "SELECT * FROM jobs" + (" WHERE project=?" if project else "") \
            + " ORDER BY created_at DESC"
        return [_row(r) for r in c.execute(q, (project,) if project else ())]


def unique_label(project: str, label: str) -> str:
    """label, or label #2, #3, ... if another job of the project already has it."""
    taken = {j["label"] for j in list_jobs(project)}
    out, i = label, 2
    while out in taken:
        out, i = f"{label} #{i}", i + 1
    return out


def _update(job_id: str, **kw) -> None:
    with _conn() as c:
        c.execute(f"UPDATE jobs SET {', '.join(f'{k}=?' for k in kw)} WHERE id=?",
                  (*kw.values(), job_id))


def _pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    return stat.rsplit(")", 1)[-1].split()[0] != "Z"


def _clear_run_dir(j: dict, recreate: bool) -> Path:
    """Delete a job's run folder (only inside the projects folder); with
    recreate, make it and the commands' working folders again."""
    run = Path(j["run_dir"]).resolve()
    base = config.PROJECTS_DIR.resolve()
    if run == base or not under(run, base):
        raise ValueError(f"run folder {run} is not inside {base}")
    shutil.rmtree(run, ignore_errors=True)
    if recreate:
        run.mkdir(parents=True)
        for cmd in j["commands"]:
            cwd = cmd.get("cwd")
            if cwd and under(Path(cwd).resolve(), run):
                Path(cwd).mkdir(parents=True, exist_ok=True)
    return run


class JobManager:
    def __init__(self) -> None:
        self._sockets: set = set()
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._cancel: set[str] = set()
        self._tasks: set[asyncio.Task] = set()
        self._started = False

    async def startup(self) -> None:
        init_db()
        for j in list_jobs():
            if j["status"] == "running":
                if _pid_alive(j["pid"]):  # orphaned by a backend restart
                    try:
                        os.killpg(j["pid"], signal.SIGTERM)
                    except OSError:
                        pass
                _update(j["id"], status="failed", finished_at=time.time(),
                        error="interrupted by a backend restart")
        self._started = True
        await self._dispatch()

    async def shutdown(self) -> None:
        self._started = False
        for jid in list(self._procs):
            self._kill(jid, signal.SIGTERM)
        for t in list(self._tasks):
            t.cancel()

    async def submit(self, project: str, task: str, label: str,
                     commands: list[dict], run_dir: Path, params: dict,
                     user: str | None = None) -> dict:
        jid = uuid.uuid4().hex[:12]
        user = clean_user(user)
        run_dir.mkdir(parents=True, exist_ok=True)
        with _conn() as c:
            c.execute(f"INSERT INTO jobs ({', '.join(_COLS)}) VALUES "
                      f"({', '.join('?' * len(_COLS))})",
                      (jid, project, task, label, "queued", json.dumps(commands),
                       str(run_dir), time.time(), None, None, None, None, 0,
                       json.dumps(params), None, user))
        (run_dir / "job.json").write_text(json.dumps(
            {"id": jid, "task": task, "label": label, "user": user, "params": params,
             "commands": commands}, indent=2))
        await self._broadcast(jid)
        await self._dispatch()
        return get_job(jid)

    async def cancel(self, jid: str) -> dict | None:
        j = get_job(jid)
        if j is None:
            return None
        if j["status"] == "queued":
            _update(jid, status="cancelled", finished_at=time.time())
            await self._broadcast(jid)
        elif j["status"] == "running":
            self._cancel.add(jid)
            self._kill(jid, signal.SIGTERM)
            t = asyncio.create_task(self._kill_later(jid))
            self._tasks.add(t)
            t.add_done_callback(self._tasks.discard)
        return get_job(jid)

    def ws_add(self, ws) -> None:
        self._sockets.add(ws)

    def ws_remove(self, ws) -> None:
        self._sockets.discard(ws)

    async def delete(self, jid: str) -> None:
        """Remove a finished job and its run folder."""
        j = self._idle(jid)
        _clear_run_dir(j, recreate=False)
        with _conn() as c:
            c.execute("DELETE FROM jobs WHERE id=?", (jid,))
        for ws in list(self._sockets):
            try:
                await ws.send_json({"type": "job_deleted", "id": jid, "project": j["project"]})
            except Exception:
                self._sockets.discard(ws)

    async def rerun(self, jid: str, user: str | None = None) -> dict:
        """Delete a finished job's outputs and queue its commands again; the job
        is then attributed to the user re-running it."""
        j = self._idle(jid)
        user = clean_user(user)
        run = _clear_run_dir(j, recreate=True)
        (run / "job.json").write_text(json.dumps(
            {"id": jid, "task": j["task"], "label": j["label"], "user": user,
             "params": j["params"], "commands": j["commands"]}, indent=2))
        _update(jid, status="queued", created_at=time.time(), started_at=None,
                finished_at=None, returncode=None, pid=None, step=0, error=None, user=user)
        await self._broadcast(jid)
        await self._dispatch()
        return get_job(jid)

    async def rename(self, jid: str, label: str) -> dict:
        """Set a job's label (unique within its project)."""
        j = get_job(jid)
        if j is None:
            raise KeyError(jid)
        label = label.strip()
        if not label:
            raise ValueError("name must not be empty")
        if any(o["label"] == label and o["id"] != jid for o in list_jobs(j["project"])):
            raise RuntimeError(f"another job is already named '{label}'")
        _update(jid, label=label)
        meta = Path(j["run_dir"]) / "job.json"
        try:
            d = json.loads(meta.read_text())
            d["label"] = label
            meta.write_text(json.dumps(d, indent=2))
        except (OSError, ValueError):
            pass
        await self._broadcast(jid)
        return get_job(jid)

    @staticmethod
    def _idle(jid: str) -> dict:
        j = get_job(jid)
        if j is None:
            raise KeyError(jid)
        if j["status"] in ("queued", "running"):
            raise RuntimeError("job is still active; cancel it first")
        return j

    # -- internals ---------------------------------------------------------

    async def _broadcast(self, jid: str) -> None:
        j = get_job(jid)
        if j is None:
            return
        for ws in list(self._sockets):
            try:
                await ws.send_json({"type": "job", "job": j})
            except Exception:
                self._sockets.discard(ws)

    async def _dispatch(self) -> None:
        if not self._started:
            return
        running = sum(1 for j in list_jobs() if j["status"] == "running")
        queued = [j for j in list_jobs() if j["status"] == "queued"]
        for j in sorted(queued, key=lambda j: j["created_at"])[:max(0, config.MAX_JOBS - running)]:
            _update(j["id"], status="running", started_at=time.time())
            t = asyncio.create_task(self._run(j["id"]))
            self._tasks.add(t)
            t.add_done_callback(self._tasks.discard)

    def _kill(self, jid: str, sig: int) -> None:
        p = self._procs.get(jid)
        if p is not None and p.returncode is None:
            try:
                os.killpg(p.pid, sig)
            except OSError:
                pass

    async def _kill_later(self, jid: str) -> None:
        await asyncio.sleep(_KILL_GRACE_S)
        self._kill(jid, signal.SIGKILL)

    async def _run(self, jid: str) -> None:
        j = get_job(jid)
        await self._broadcast(jid)
        log = Path(j["run_dir"]) / "job.log"
        status, rc, err = "done", 0, None
        failed_steps = 0
        try:
            for i, cmd in enumerate(j["commands"]):
                if jid in self._cancel:
                    break
                _update(jid, step=i)
                with open(log, "ab") as fh:
                    fh.write(f"\n$ {' '.join(cmd['argv'])}\n".encode())
                    fh.flush()
                    p = await asyncio.create_subprocess_exec(
                        *cmd["argv"], cwd=cmd.get("cwd") or j["run_dir"],
                        stdout=fh, stderr=asyncio.subprocess.STDOUT,
                        stdin=asyncio.subprocess.DEVNULL, start_new_session=True,
                        env={**os.environ, "PYTHONUNBUFFERED": "1",
                             "MPLBACKEND": "Agg", **cmd.get("env", {})})
                self._procs[jid] = p
                _update(jid, pid=p.pid)
                await self._broadcast(jid)
                rc = await p.wait()
                self._procs.pop(jid, None)
                if rc != 0:
                    failed_steps += 1
                    with open(log, "ab") as fh:
                        fh.write(f"[mstar_post] step {i + 1} exited with code {rc}\n".encode())
                    if not cmd.get("continue_on_error"):
                        break
            if jid in self._cancel:
                status, err = "cancelled", None
            elif failed_steps:
                status = "failed" if rc != 0 or failed_steps == len(j["commands"]) \
                    else "done"
                err = f"{failed_steps} of {len(j['commands'])} step(s) failed"
        except Exception as e:  # e.g. executable not found
            status, err, rc = "failed", str(e), -1
            with open(log, "ab") as fh:
                fh.write(f"[mstar_post] {e}\n".encode())
        finally:
            self._cancel.discard(jid)
            _update(jid, status=status, returncode=rc, error=err,
                    finished_at=time.time())
            await self._broadcast(jid)
            await self._dispatch()


manager = JobManager()
