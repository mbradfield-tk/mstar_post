"""M-Star Post: FastAPI backend (serves the built frontend too)."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import config, jobs
from app.routers import auth, case, fs, gpus, projects
from app.routers import jobs as jobs_router

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_dirs()
    await jobs.manager.startup()
    yield
    await jobs.manager.shutdown()


app = FastAPI(title="M-Star Post", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=4096)
for r in (auth.router, fs.router, projects.router, projects.catalog, case.router, jobs_router.router, gpus.router):
    app.include_router(r)


@app.get("/api/health")
def health() -> dict:
    from app import fsops
    return {"ok": True, "roots": [str(r) for r in config.ROOTS],
            "data_dir": str(config.DATA_DIR), "helper_mode": config.HELPER_MODE,
            "helpers_stale": fsops.helper_stale()}


if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        f = (DIST / full_path).resolve()
        if full_path and DIST in f.parents and f.is_file():
            return FileResponse(f)
        return FileResponse(DIST / "index.html")
