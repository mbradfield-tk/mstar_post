"""Case data: inventory, Stats series, planes, surfaces, isosurfaces, profiles."""
from __future__ import annotations

import hashlib
import io
import zlib
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import cases, vtkio
from app.paths import safe_child, safe_path

router = APIRouter(prefix="/api/case", tags=["case"])
_CMAPS = ("viridis", "plasma", "inferno", "magma", "turbo", "coolwarm", "RdBu_r",
          "Greys_r", "jet", "cividis")

# Planes and meshes are megabytes each and the Viewer asks for several per frame: over a slow
# link (VPN) their transfer is what a field change or a time step costs. They are therefore sent
# compressed (in the worker thread of the request, not on the event loop) and with a validator,
# so a browser that still holds one is answered 304 without the data being read again.
_REVALIDATE = {"Cache-Control": "private, no-cache", "Vary": "Accept-Encoding"}
_GZIP_MAX = 64 * 1024 ** 2  # larger files are sent as they are (streamed from disk)
# part of every plane validator: planes computed by older code are not reused
_CODE = "%x" % max(Path(f).stat().st_mtime_ns for f in (__file__, vtkio.__file__))


def _gzip(data) -> bytes:
    """gzip at level 1: on these binary arrays within 2 % of level 6 at a third of the time."""
    c = zlib.compressobj(1, zlib.DEFLATED, 31)
    return c.compress(data) + c.flush()


def _accepts_gzip(request: Request) -> bool:
    return "gzip" in request.headers.get("accept-encoding", "").lower()


def _unchanged(request: Request, etag: str | None) -> Response | None:
    """304 when the client already holds the response with this validator."""
    held = [t.strip().removeprefix("W/") for t in request.headers.get("if-none-match", "").split(",")]
    if etag and etag in held:
        return Response(status_code=304, headers={"ETag": etag, **_REVALIDATE})
    return None


def _source_tag(f: Path, *what) -> str | None:
    """Validator of a response computed from f (and its other blocks): changes with the files
    (time of last change, size), with `what` and with the code; None when a file is missing."""
    try:
        stats = [(str(b), st.st_mtime_ns, st.st_size) for b in (vtkio.block_files(f) or [f]) for st in (b.stat(),)]
    except OSError:
        return None
    return '"%s"' % hashlib.sha1(repr((_CODE, stats, what)).encode()).hexdigest()[:24]


def _file_response(request: Request, f: Path, media_type: str) -> Response:
    """A mesh file (STL, indexed mesh, streamlines): gzip-compressed for clients that accept
    it (an indexed mesh shrinks to about 45 %, an STL to 30 %), 304 when unchanged."""
    st = f.stat()
    gz = _accepts_gzip(request) and 1024 <= st.st_size <= _GZIP_MAX
    etag = '"%x-%x%s"' % (st.st_mtime_ns, st.st_size, "-gz" if gz else "")
    if (r := _unchanged(request, etag)) is not None:
        return r
    if not gz:
        return FileResponse(f, media_type=media_type, headers={"ETag": etag, **_REVALIDATE})
    return Response(_gzip(f.read_bytes()), media_type=media_type,
                    headers={"ETag": etag, "Content-Encoding": "gzip", **_REVALIDATE})


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


@router.get("/series_stats")
def series_stats(path: str, file: str, columns: list[str] = Query(...),
                 t_from: float | None = None, t_to: float | None = None) -> dict:
    """n, mean, std, min, max of each column for t_from <= t <= t_to and its last value,
    from every row of the Stats file (the /series points are decimated)."""
    s = cases.mss.locate_stats_dir(_case(path))
    if s is None:
        raise HTTPException(404, "no Stats folder")
    try:
        return {"stats": cases.series_stats(safe_child(s, file), columns, t_from, t_to)}
    except KeyError as e:
        raise HTTPException(404, f"no column {e} in {file}")
    except ValueError as e:
        raise HTTPException(422, str(e))


def _enc(enc: str) -> str:
    if enc not in ("", "shuf"):
        raise HTTPException(422, "enc must be shuf or empty")
    return enc


def _plane_response(request: Request, p: dict, h: int, w: int, enc: str = "", etag: str | None = None) -> Response:
    """enc 'shuf': the float32 values byte-shuffled (byte 0 of every value, then byte 1, ...;
    header X-Shuffle: 4) and gzip-compressed. Lossless; a plane shrinks to 25 % (fractions,
    density) to 75 % (turbulent fields) of its size, plain gzip of the floats to 30 - 85 %."""
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
    if etag:
        hdr.update(ETag=etag, **_REVALIDATE)
    data = np.ascontiguousarray(p["data"], "<f4")
    if enc == "shuf":
        hdr["X-Shuffle"] = "4"
        data = np.ascontiguousarray(data.reshape(-1).view(np.uint8).reshape(-1, 4).T)
        if _accepts_gzip(request):
            hdr["Content-Encoding"] = "gzip"
            return Response(_gzip(data), media_type="application/octet-stream", headers=hdr)
    return Response(data.tobytes(), media_type="application/octet-stream", headers=hdr)


@router.get("/plane")
def plane(request: Request, path: str, file: str, array: str, comp: str = "mag",
          axis: int | None = None, pos: float | None = None, mask: bool = True, smooth: bool = False,
          enc: str = ""):
    """Scalar plane as little-endian float32 (rows = v, columns = u), metadata in headers.
    smooth: averaged with the neighbouring layers (1-2-1), like VTK's cell-to-point data.
    enc=shuf: packed (see _plane_response)."""
    f = _vtk_file(_case(path), file)
    etag = _source_tag(f, "plane", array, comp, axis, pos, mask, smooth, _enc(enc))
    if (r := _unchanged(request, etag)) is not None:
        return r
    try:
        p = vtkio.extract_plane(f, array, comp, axis, pos, mask, smooth)
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")
    except ValueError as e:
        raise HTTPException(422, str(e))
    return _plane_response(request, p, *p["data"].shape, enc, etag)


@router.get("/plane_vec")
def plane_vec(request: Request, path: str, file: str, array: str, axis: int | None = None,
              pos: float | None = None, mask: bool = True, enc: str = ""):
    """In-plane vector components: float32 u plane then v plane (each rows = v),
    statistics of the in-plane speed in the headers. enc=shuf: packed as /plane."""
    f = _vtk_file(_case(path), file)
    etag = _source_tag(f, "plane_vec", array, axis, pos, mask, _enc(enc))
    if (r := _unchanged(request, etag)) is not None:
        return r
    try:
        p = vtkio.extract_vector_plane(f, array, axis, pos, mask)
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")
    except ValueError as e:
        raise HTTPException(422, str(e))
    return _plane_response(request, p, *p["data"].shape[1:], enc, etag)


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


class RegionReq(BaseModel):
    path: str
    files: list[str]
    array: str
    poly: list[list[float]]
    comp: str = "mag"
    axis: int | None = None
    pos: float | None = None
    mask: bool = True
    smooth: bool = False


@router.post("/region_series")
def region_series(body: RegionReq) -> dict:
    """Region statistics on a plane (polygon in the plane's u, v axes) for each file:
    the region mean over time."""
    case = _case(body.path)
    if len(body.poly) < 3 or any(len(q) != 2 for q in body.poly):
        raise HTTPException(422, "poly must be at least 3 [u, v] points")
    if not body.files or len(body.files) > 5000:
        raise HTTPException(422, "1 to 5000 files")
    try:
        rows = vtkio.region_series([_vtk_file(case, f) for f in body.files], body.array, body.comp,
                                   body.axis, body.pos, body.poly, body.mask, body.smooth)
    except KeyError:
        raise HTTPException(404, f"no array '{body.array}'")
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"frames": [{"file": f, **r} for f, r in zip(body.files, rows)]}


class PointReq(BaseModel):
    path: str
    files: list[str]
    array: str
    p: list[float]
    comp: str = "mag"
    mask: bool = True


@router.post("/point")
def point(body: PointReq) -> dict:
    """Value of the cell nearest to point p in each of the given .vti files (one file =
    the current frame, many = a time series at the point)."""
    case = _case(body.path)
    if len(body.p) != 3:
        raise HTTPException(422, "p must be [x, y, z]")
    if not body.files or len(body.files) > 5000:
        raise HTTPException(422, "1 to 5000 files")
    rows = []
    for f in body.files:
        try:
            rows.append({"file": f, **vtkio.point_value(_vtk_file(case, f), body.array, body.comp, body.p, body.mask)})
        except KeyError:
            raise HTTPException(404, f"no array '{body.array}' in {f}")
        except ValueError as e:
            raise HTTPException(422, f"{f}: {e}")
    return {"points": rows}


def _fmt(fmt: str) -> str:
    if fmt not in _MESH_TYPES:
        raise HTTPException(422, "fmt must be stl or mesh")
    return fmt


@router.get("/surface")
def surface(request: Request, path: str, file: str, max_tris: int = 400_000, fmt: str = "stl"):
    """A surface (.vtp/.stl/.vtk) simplified above max_tris, as binary STL or as the
    compact indexed mesh (fmt=mesh: b'MPM1', n_points, n_tris, float32 xyz, uint32 index)."""
    f = _vtk_file(_case(path), file)
    fmt = _fmt(fmt)
    if fmt == "stl" and f.suffix.lower() == ".stl" and f.stat().st_size < 50 * max_tris:
        return _file_response(request, f, "model/stl")
    return _file_response(request, vtkio.surface_stl(f, max(1000, max_tris), fmt), _MESH_TYPES[fmt])


@router.get("/surface_warm")
def surface_warm(path: str, file: list[str] = Query(...), max_tris: int = 400_000, fmt: str = "mesh") -> dict:
    """Queue background conversion of several surfaces (e.g. the next time steps of a
    VOF surface) so they are served from the disk cache when the user gets there."""
    case = _case(path)
    files = [_vtk_file(case, x) for x in file[:200]]
    return {"queued": vtkio.warm_surfaces(files, max(1000, max_tris), _fmt(fmt))}


@router.get("/iso")
def iso(request: Request, path: str, file: str, array: str, level: float, comp: str = "mag",
        stride: int = 1, max_tris: int = 600_000, fmt: str = "stl"):
    f = _vtk_file(_case(path), file)
    fmt = _fmt(fmt)
    try:
        out = vtkio.isosurface_stl(f, array, comp, level, max(1, min(stride, 8)),
                                   max(1000, max_tris), fmt)
    except KeyError:
        raise HTTPException(404, f"no array '{array}' in {f.name}")
    return _file_response(request, out, _MESH_TYPES[fmt])


@router.get("/streamlines")
def streamlines(request: Request, path: str, file: str, array: str, axis: int | None = None,
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
    return _file_response(request, out, "application/octet-stream")


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
