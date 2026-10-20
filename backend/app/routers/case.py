"""Case data: inventory, Stats series, planes, surfaces, isosurfaces, profiles."""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse

from app import cases, vtkio
from app.paths import safe_child, safe_path

router = APIRouter(prefix="/api/case", tags=["case"])
_CMAPS = ("viridis", "plasma", "inferno", "magma", "turbo", "coolwarm", "RdBu_r",
          "Greys_r", "jet", "cividis")


def _case(path: str) -> Path:
    d = safe_path(path)
    if not d.is_dir():
        raise HTTPException(422, "case must be a directory")
    return d


def _vtk_file(case: Path, file: str) -> Path:
    f = safe_child(case, file)
    if f.suffix.lower() not in (".vti", ".vtp", ".vtk", ".vtu", ".stl"):
        raise HTTPException(422, "not a VTK/STL file")
    return f


@router.get("/inventory")
def inventory(path: str) -> dict:
    return cases.inventory(_case(path))


@router.get("/stats")
def stats(path: str) -> list[dict]:
    s = cases.mss.locate_stats_dir(_case(path))
    return cases.stats_files(s) if s else []


@router.get("/series")
def series(path: str, file: str, columns: list[str] = Query(...),
           max_points: int = 4000) -> dict:
    s = cases.mss.locate_stats_dir(_case(path))
    if s is None:
        raise HTTPException(404, "no Stats folder")
    try:
        return cases.series(safe_child(s, file), columns, min(max_points, 50000))
    except KeyError as e:
        raise HTTPException(404, f"no column {e} in {file}")
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("/plane")
def plane(path: str, file: str, array: str, comp: str = "mag",
          axis: int | None = None, pos: float | None = None, mask: bool = True):
    """Scalar plane as little-endian float32 (rows = v, columns = u), metadata in headers."""
    f = _vtk_file(_case(path), file)
    try:
        p = vtkio.extract_plane(f, array, comp, axis, pos, mask)
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")
    except ValueError as e:
        raise HTTPException(422, str(e))
    d = p["data"]
    hdr = {"X-Height": str(d.shape[0]), "X-Width": str(d.shape[1]),
           "X-Axis": str(p["axis"]), "X-Index": str(p["index"]),
           "X-Count": str(p["count"]), "X-Pos": repr(p["pos"]),
           "X-U-Axis": str(p["u_axis"]), "X-V-Axis": str(p["v_axis"]),
           "X-U0": repr(p["u0"]), "X-V0": repr(p["v0"]),
           "X-Du": repr(p["du"]), "X-Dv": repr(p["dv"]),
           "X-Vmin": repr(p["vmin"]), "X-Vmax": repr(p["vmax"]),
           "X-P01": repr(p["p01"]), "X-P99": repr(p["p99"]),
           "X-Unit": p["unit"].encode("ascii", "replace").decode(),
           "X-Time": repr(p["time"]) if p["time"] is not None else "",
           "Access-Control-Expose-Headers": "*"}
    return Response(np.ascontiguousarray(d, "<f4").tobytes(),
                    media_type="application/octet-stream", headers=hdr)


@router.get("/line")
def line(path: str, file: str, array: str, p0: str, p1: str, comp: str = "mag",
         n: int = 200) -> dict:
    f = _vtk_file(_case(path), file)
    try:
        a, b = [float(x) for x in p0.split(",")], [float(x) for x in p1.split(",")]
        assert len(a) == 3 and len(b) == 3
    except (ValueError, AssertionError):
        raise HTTPException(422, "p0/p1 must be 'x,y,z'")
    try:
        return vtkio.line_profile(f, array, comp, a, b, max(2, min(n, 5000)))
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")


@router.get("/surface")
def surface(path: str, file: str, max_tris: int = 400_000):
    """A surface (.vtp/.stl/.vtk) as binary STL, simplified above max_tris."""
    f = _vtk_file(_case(path), file)
    if f.suffix.lower() == ".stl" and f.stat().st_size < 50 * max_tris:
        return FileResponse(f, media_type="model/stl")
    return FileResponse(vtkio.surface_stl(f, max(1000, max_tris)), media_type="model/stl")


@router.get("/iso")
def iso(path: str, file: str, array: str, level: float, comp: str = "mag",
        stride: int = 1, max_tris: int = 600_000):
    f = _vtk_file(_case(path), file)
    try:
        out = vtkio.isosurface_stl(f, array, comp, level, max(1, min(stride, 8)),
                                   max(1000, max_tris))
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")
    return FileResponse(out, media_type="model/stl")


@router.get("/cmap/{name}")
def cmap(name: str):
    """256x1 colormap strip."""
    if name not in _CMAPS:
        raise HTTPException(422, f"cmap must be one of {', '.join(_CMAPS)}")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.image

    strip = matplotlib.colormaps[name](np.linspace(0, 1, 256))[None, :, :]
    buf = io.BytesIO()
    matplotlib.image.imsave(buf, (strip * 255).astype(np.uint8), format="png")
    return Response(buf.getvalue(), media_type="image/png",
                    headers={"Cache-Control": "max-age=86400"})


@router.get("/cmaps")
def cmaps() -> list[str]:
    return list(_CMAPS)
