"""M-Star Post: FastAPI backend (serves the built frontend too)."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import config, jobs
from app.routers import auth, case, fs, gpus, projects
from app.routers import jobs as jobs_router

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


def _raise_fd_limit() -> None:
    """The default soft limit of 1024 open files is too low for a 500-file download in
    hosted mode (two pipes per file read through the helper)."""
    import resource
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    want = 65536 if hard == resource.RLIM_INFINITY else min(hard, 65536)
    if soft < want:
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
        except (ValueError, OSError):
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_dirs()
    _raise_fd_limit()
    await jobs.manager.startup()
    yield
    await jobs.manager.shutdown()


app = FastAPI(title="M-Star Post", lifespan=lifespan)

# Viewer planes, meshes and streamlines, images and downloads are binary and barely shrink,
# while gzip runs on the event loop (level 9 took 1.2 s for a 6 MB surface): sent as they are.
_NO_GZIP = ("/api/case/plane", "/api/case/surface", "/api/case/iso", "/api/case/streamlines",
            "/api/fs/download", "/api/fs/mesh", "/api/fs/image")


class _Compress:
    def __init__(self, app, **kw) -> None:
        self.app, self.gzip = app, GZipMiddleware(app, **kw)

    async def __call__(self, scope, receive, send) -> None:
        path = scope.get("path", "")
        plain = scope["type"] != "http" or path.startswith(_NO_GZIP) or path.endswith("/zip")
        await (self.app if plain else self.gzip)(scope, receive, send)


app.add_middleware(_Compress, minimum_size=4096, compresslevel=6)
for r in (auth.router, fs.router, projects.router, projects.catalog, case.router, jobs_router.router, gpus.router):
    app.include_router(r)


@app.get("/api/health")
def health() -> dict:
    from app import fsops
    return {"ok": True, "roots": [str(r) for r in config.ROOTS],
            "data_dir": str(config.DATA_DIR), "helper_mode": config.HELPER_MODE,
            "helpers_stale": fsops.helper_stale()}


class _Assets(StaticFiles):
    """The built assets carry a content hash in their name: browsers may keep them for good."""

    async def get_response(self, path: str, scope):
        r = await super().get_response(path, scope)
        if r.status_code == 200:
            r.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return r


if DIST.is_dir():
    app.mount("/assets", _Assets(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/"):  # an unknown API path must not answer with the page
            raise HTTPException(404, f"no such endpoint: /{full_path}")
        f = (DIST / full_path).resolve()
        if full_path and DIST in f.parents and f.is_file():
            return FileResponse(f)
        # always revalidated: a page cached from before a deploy would ask for assets that are gone
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})
