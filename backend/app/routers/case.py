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


def _plane_response(p: dict, h: int, w: int) -> Response:
    hdr = {"X-Height": str(h), "X-Width": str(w),
           "X-Axis": str(p["axis"]), "X-Index": str(p["index"]),
           "X-Count": str(p["count"]), "X-Pos": repr(p["pos"]),
           "X-U-Axis": str(p["u_axis"]), "X-V-Axis": str(p["v_axis"]),
           "X-U0": repr(p["u0"]), "X-V0": repr(p["v0"]),
           "X-Du": repr(p["du"]), "X-Dv": repr(p["dv"]),
           "X-Vmin": repr(p["vmin"]), "X-Vmax": repr(p["vmax"]),
           "X-P01": repr(p["p01"]), "X-P99": repr(p["p99"]), "X-Mean": repr(p["mean"]),
           "X-Unit": p["unit"].encode("ascii", "replace").decode(),
           "X-Time": repr(p["time"]) if p["time"] is not None else "",
           "Access-Control-Expose-Headers": "*"}
    return Response(np.ascontiguousarray(p["data"], "<f4").tobytes(),
                    media_type="application/octet-stream", headers=hdr)


@router.get("/plane")
def plane(path: str, file: str, array: str, comp: str = "mag",
          axis: int | None = None, pos: float | None = None, mask: bool = True, smooth: bool = False):
    """Scalar plane as little-endian float32 (rows = v, columns = u), metadata in headers.
    smooth: averaged with the neighbouring layers (1-2-1), like VTK's cell-to-point data."""
    f = _vtk_file(_case(path), file)
    try:
        p = vtkio.extract_plane(f, array, comp, axis, pos, mask, smooth)
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")
    except ValueError as e:
        raise HTTPException(422, str(e))
    return _plane_response(p, *p["data"].shape)


@router.get("/plane_vec")
def plane_vec(path: str, file: str, array: str, axis: int | None = None,
              pos: float | None = None, mask: bool = True):
    """In-plane vector components: float32 u plane then v plane (each rows = v),
    statistics of the in-plane speed in the headers."""
    f = _vtk_file(_case(path), file)
    try:
        p = vtkio.extract_vector_plane(f, array, axis, pos, mask)
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")
    except ValueError as e:
        raise HTTPException(422, str(e))
    return _plane_response(p, *p["data"].shape[1:])


@router.get("/fluid_center")
def fluid_center(path: str, file: str) -> dict:
    """Bounds and center of the fluid-filled cells of a volume .vti."""
    f = _vtk_file(_case(path), file)
    try:
        return vtkio.fluid_bounds(f)
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("/mean")
def mean(path: str, file: str, array: str, comp: str = "mag", mask: bool = True) -> dict:
    """Mean of the array over the fluid cells of the whole file (the 'global mean' shown
    under the Viewer legend); {mean, n_cells, unit, time, masked}."""
    f = _vtk_file(_case(path), file)
    try:
        return vtkio.volume_mean(f, array, comp, mask)
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")


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


_MESH_TYPES = {"stl": "model/stl", "mesh": "application/octet-stream"}


def _fmt(fmt: str) -> str:
    if fmt not in _MESH_TYPES:
        raise HTTPException(422, "fmt must be stl or mesh")
    return fmt


@router.get("/surface")
def surface(path: str, file: str, max_tris: int = 400_000, fmt: str = "stl"):
    """A surface (.vtp/.stl/.vtk) simplified above max_tris, as binary STL or as the
    compact indexed mesh (fmt=mesh: b'MPM1', n_points, n_tris, float32 xyz, uint32 index)."""
    f = _vtk_file(_case(path), file)
    fmt = _fmt(fmt)
    if fmt == "stl" and f.suffix.lower() == ".stl" and f.stat().st_size < 50 * max_tris:
        return FileResponse(f, media_type="model/stl")
    return FileResponse(vtkio.surface_stl(f, max(1000, max_tris), fmt), media_type=_MESH_TYPES[fmt])


@router.get("/surface_warm")
def surface_warm(path: str, file: list[str] = Query(...), max_tris: int = 400_000, fmt: str = "mesh") -> dict:
    """Queue background conversion of several surfaces (e.g. the next time steps of a
    VOF surface) so they are served from the disk cache when the user gets there."""
    case = _case(path)
    files = [_vtk_file(case, x) for x in file[:200]]
    return {"queued": vtkio.warm_surfaces(files, max(1000, max_tris), _fmt(fmt))}


@router.get("/iso")
def iso(path: str, file: str, array: str, level: float, comp: str = "mag",
        stride: int = 1, max_tris: int = 600_000, fmt: str = "stl"):
    f = _vtk_file(_case(path), file)
    fmt = _fmt(fmt)
    try:
        out = vtkio.isosurface_stl(f, array, comp, level, max(1, min(stride, 8)),
                                   max(1000, max_tris), fmt)
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")
    return FileResponse(out, media_type=_MESH_TYPES[fmt])


@router.get("/streamlines")
def streamlines(path: str, file: str, array: str, axis: int | None = None,
                pos: float | None = None, n_seeds: int = 20, max_steps: int = 2000,
                stride: int = 1):
    """3D streamlines seeded on a plane (binary, see vtkio.streamlines)."""
    f = _vtk_file(_case(path), file)
    try:
        out = vtkio.streamlines(f, array, axis, pos, max(2, min(n_seeds, 60)),
                                max(10, min(max_steps, 20000)), max(1, min(stride, 8)))
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")
    except ValueError as e:
        raise HTTPException(422, str(e))
    return FileResponse(out, media_type="application/octet-stream")


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
