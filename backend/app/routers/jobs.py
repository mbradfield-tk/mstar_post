"""Job listing, logs, cancel and live status over WebSocket."""
from pathlib import Path

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from app import jobs, tasks

router = APIRouter(prefix="/api", tags=["jobs"])


@router.get("/tasks")
def list_tasks() -> list[dict]:
    return [t.public() for t in tasks.TASKS.values()]


@router.get("/jobs")
def list_jobs(project: str | None = None) -> list[dict]:
    return jobs.list_jobs(project)


def _job(jid: str) -> dict:
    j = jobs.get_job(jid)
    if j is None:
        raise HTTPException(404, f"no job '{jid}'")
    return j


@router.get("/jobs/{jid}")
def get_job(jid: str) -> dict:
    return _job(jid)


@router.post("/jobs/{jid}/cancel")
async def cancel(jid: str) -> dict:
    _job(jid)
    return await jobs.manager.cancel(jid)


@router.get("/jobs/{jid}/log")
def log(jid: str, offset: int = 0, limit: int = 256 * 1024) -> dict:
    p = Path(_job(jid)["run_dir"]) / "job.log"
    if not p.is_file():
        return {"offset": 0, "size": 0, "text": ""}
    size = p.stat().st_size
    start = max(0, size - limit) if offset < 0 else min(offset, size)
    with open(p, "rb") as fh:
        fh.seek(start)
        text = fh.read(limit).decode(errors="replace")
    return {"offset": start + len(text.encode()), "size": size, "text": text}


@router.websocket("/jobs/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    jobs.manager.ws_add(sock)
    try:
        while True:
            await sock.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        jobs.manager.ws_remove(sock)
