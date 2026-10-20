"""VTK XML (.vti/.vtp) header parsing, plane extraction and mesh export.

Uncompressed raw-appended .vti arrays (M-Star's format) are memory-mapped so a
plane is read without loading the whole file; anything else falls back to a
full VTK read (cached).
"""
from __future__ import annotations

import hashlib
import re
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path

import numpy as np

from app import config

_DTYPES = {"Float32": "<f4", "Float64": "<f8", "Int8": "i1", "UInt8": "u1",
           "Int16": "<i2", "UInt16": "<u2", "Int32": "<i4", "UInt32": "<u4",
           "Int64": "<i8", "UInt64": "<u8"}
_UNIT = re.compile(r"[\(\[]([^\)\]]*)[\)\]]\s*$")


def unit_of(name: str) -> str:
    m = _UNIT.search(name)
    return m.group(1) if m else ""


def _attrs(tag: str) -> dict:
    return dict(re.findall(r'(\w+)="([^"]*)"', tag))


@lru_cache(maxsize=4096)
def _header(path: str, mtime_ns: int, size: int) -> dict:
    with open(path, "rb") as fh:
        head = fh.read(512 * 1024)
    if not head.lstrip().startswith(b"<"):
        return _header_vtk(path)
    i = head.find(b"<AppendedData")
    txt = (head[:i] if i >= 0 else head).decode(errors="replace")
    root = _attrs(re.search(r"<VTKFile[^>]*>", txt).group(0))
    h = {"path": path, "type": root.get("type", ""),
         "compressed": "compressor" in root,
         "header_bytes": 8 if root.get("header_type") == "UInt64" else 4,
         "raw": i >= 0 and b'encoding="raw"' in head[i:i + 100],
         "data_start": head.index(b"_", i) + 1 if i >= 0 else None,
         "time": None, "arrays": [], "size": size}
    m = re.search(r'Name="TIME"[^>]*>\s*([-+0-9.eE]+)', txt)
    if m:
        h["time"] = float(m.group(1))
    m = re.search(r"<ImageData([^>]*)>", txt)
    if m:
        a = _attrs(m.group(1))
        e = [int(v) for v in a["WholeExtent"].split()]
        h["extent"] = e
        h["origin"] = [float(v) for v in a.get("Origin", "0 0 0").split()]
        h["spacing"] = [float(v) for v in a.get("Spacing", "1 1 1").split()]
    m = re.search(r"<Piece([^>]*)>", txt)
    if m:
        a = _attrs(m.group(1))
        for k in ("NumberOfPoints", "NumberOfPolys"):
            if k in a:
                h[k] = int(a[k])
    for assoc in ("PointData", "CellData"):
        sec = re.search(rf"<{assoc}[^>]*>(.*?)</{assoc}>", txt, re.S)
        if not sec:
            continue
        for tag in re.findall(r"<DataArray[^>]*>", sec.group(1)):
            a = _attrs(tag)
            h["arrays"].append({
                "name": a.get("Name", ""), "assoc": assoc[:-4].lower(),
                "type": a.get("type", ""), "ncomp": int(a.get("NumberOfComponents", 1)),
                "format": a.get("format", ""), "offset": int(a.get("offset", -1)),
                "unit": unit_of(a.get("Name", ""))})
    return h


def _header_vtk(path: str) -> dict:
    """Header of a non-XML (legacy .vtk) file via a full read."""
    import pyvista as pv
    mesh = pv.read(path)
    h = {"path": path, "type": type(mesh).__name__, "compressed": False, "raw": False,
         "time": None, "arrays": [], "size": Path(path).stat().st_size}
    if isinstance(mesh, pv.ImageData):
        h["type"] = "ImageData"
        d = mesh.dimensions
        h["extent"] = [0, d[0] - 1, 0, d[1] - 1, 0, d[2] - 1]
        h["origin"], h["spacing"] = list(mesh.origin), list(mesh.spacing)
    for assoc, data in (("point", mesh.point_data), ("cell", mesh.cell_data)):
        for n in data.keys():
            arr = np.asarray(data[n])
            h["arrays"].append({"name": n, "assoc": assoc, "type": str(arr.dtype),
                                "ncomp": 1 if arr.ndim == 1 else arr.shape[1],
                                "format": "", "offset": -1, "unit": unit_of(n)})
    return h


def header(path: Path) -> dict:
    st = path.stat()
    return _header(str(path), st.st_mtime_ns, st.st_size)


def grid_dims(h: dict, assoc: str) -> tuple[int, int, int]:
    """(nx, ny, nz) sample counts; a zero-thickness axis of a slice counts as 1."""
    e = h["extent"]
    n = [e[2 * a + 1] - e[2 * a] for a in range(3)]
    return tuple(max(v, 1) if assoc == "cell" else v + 1 for v in n)


def sample_origin(h: dict, assoc: str) -> list[float]:
    """World coordinate of sample (0, 0, 0): cell centres for cell data."""
    e, o, s = h["extent"], h["origin"], h["spacing"]
    return [o[a] + (e[2 * a] + (0.5 if assoc == "cell" and e[2 * a + 1] > e[2 * a] else 0))
            * s[a] for a in range(3)]


def find_array(h: dict, name: str) -> dict:
    for a in h["arrays"]:
        if a["name"] == name:
            return a
    raise KeyError(name)


# ------------------------------------------------------------------ arrays

_full_cache: OrderedDict = OrderedDict()
_FULL_CACHE_BYTES = 3 * 1024 ** 3


def _read_full(path: str, name: str, assoc: str) -> np.ndarray:
    key = (path, Path(path).stat().st_mtime_ns, name)
    hit = _full_cache.get(key)
    if hit is not None:
        _full_cache.move_to_end(key)
        return hit
    import pyvista as pv
    reader = pv.get_reader(path)
    if hasattr(reader, "disable_all_cell_arrays"):
        reader.disable_all_cell_arrays()
        reader.disable_all_point_arrays()
        (reader.enable_cell_array if assoc == "cell" else reader.enable_point_array)(name)
    mesh = reader.read()
    arr = np.asarray((mesh.cell_data if assoc == "cell" else mesh.point_data)[name])
    _full_cache[key] = arr
    while sum(a.nbytes for a in _full_cache.values()) > _FULL_CACHE_BYTES \
            and len(_full_cache) > 1:
        _full_cache.popitem(last=False)
    return arr


def volume_array(path: Path, name: str) -> np.ndarray:
    """Array as (nz, ny, nx[, ncomp]) - memory-mapped when possible."""
    h = header(path)
    a = find_array(h, name)
    nx, ny, nz = grid_dims(h, a["assoc"])
    shape = (nz, ny, nx) + ((a["ncomp"],) if a["ncomp"] > 1 else ())
    if h["raw"] and not h["compressed"] and a["format"] == "appended" \
            and a["type"] in _DTYPES:
        dt = np.dtype(_DTYPES[a["type"]])
        off = h["data_start"] + a["offset"] + h["header_bytes"]
        if off + int(np.prod(shape)) * dt.itemsize <= h["size"]:
            return np.memmap(path, dtype=dt, mode="r", offset=off, shape=shape)
    return _read_full(str(path), name, a["assoc"]).reshape(shape)


def reduce_comp(arr: np.ndarray, comp: str, ncomp: int) -> np.ndarray:
    """Scalar view of a (possibly vector) array: 'mag' or a component index."""
    if ncomp == 1:
        return np.asarray(arr, np.float32)
    if comp in ("", "mag"):
        return np.sqrt(np.sum(np.asarray(arr, np.float32) ** 2, axis=-1))
    return np.asarray(arr[..., int(comp)], np.float32)


# plane axes (u = width, v = height) for each normal axis; M-Star is y-up
PLANE_AXES = {0: (2, 1), 1: (0, 2), 2: (0, 1)}


def _take(arr: np.ndarray, axis: int, idx: int) -> np.ndarray:
    """Plane of an (nz, ny, nx[, c]) array normal to world axis, as (v, u[, c])."""
    if axis == 2:
        return arr[idx]
    if axis == 1:
        return arr[:, idx]
    return np.swapaxes(arr[:, :, idx], 0, 1)  # (nz, ny) -> rows y, cols z


def _fraction_names(h: dict, assoc: str) -> list[str]:
    return [a["name"] for a in h["arrays"] if a["assoc"] == assoc
            and re.search(r"volume fraction", a["name"], re.I)]


def extract_plane(path: Path, name: str, comp: str, axis: int | None,
                  pos: float | None, mask: bool = True) -> dict:
    """Scalar plane of a .vti normal to axis at world position pos.

    For a 2D slice file axis/pos are taken from the file. Solid cells (all
    'Volume Fraction' arrays ~0, M-Star two-fluid) are NaN when mask is set.
    """
    h = header(path)
    if "extent" not in h:
        raise ValueError(f"{path.name} is not image data")
    a = find_array(h, name)
    dims = grid_dims(h, a["assoc"])
    e = h["extent"]
    thin = [ax for ax in range(3) if e[2 * ax + 1] == e[2 * ax]]
    if thin:
        axis = thin[0]
    if axis is None:
        raise ValueError("axis required for volume data")
    so, sp = sample_origin(h, a["assoc"]), h["spacing"]
    if thin:
        idx = 0
    else:
        p = so[axis] + (dims[axis] - 1) * sp[axis] / 2 if pos is None else pos
        idx = int(np.clip(round((p - so[axis]) / sp[axis]), 0, dims[axis] - 1))
    plane = reduce_comp(_take(volume_array(path, name), axis, idx), comp, a["ncomp"])
    plane = np.array(plane, np.float32)
    if mask:
        fr = _fraction_names(h, a["assoc"])
        if len(fr) >= 2:
            total = sum(np.asarray(_take(volume_array(path, n), axis, idx), np.float32)
                        for n in fr)
            plane[total < 0.5] = np.nan
    u, v = PLANE_AXES[axis]
    finite = plane[np.isfinite(plane)]
    return {
        "data": plane, "axis": axis, "index": idx, "count": dims[axis],
        "pos": so[axis] + idx * sp[axis],
        "u_axis": u, "v_axis": v, "u0": so[u], "v0": so[v], "du": sp[u], "dv": sp[v],
        "vmin": float(finite.min()) if finite.size else 0.0,
        "vmax": float(finite.max()) if finite.size else 0.0,
        "p01": float(np.percentile(finite, 1)) if finite.size else 0.0,
        "p99": float(np.percentile(finite, 99)) if finite.size else 0.0,
        "unit": a["unit"], "time": h["time"],
    }


def line_profile(path: Path, name: str, comp: str, p0: list[float], p1: list[float],
                 n: int = 200) -> dict:
    """Nearest-sample values along the segment p0 -> p1 of a .vti volume."""
    h = header(path)
    a = find_array(h, name)
    dims = grid_dims(h, a["assoc"])
    so, sp = np.array(sample_origin(h, a["assoc"])), np.array(h["spacing"])
    arr = volume_array(path, name)
    s = np.linspace(0.0, 1.0, n)
    pts = np.array(p0)[None, :] + s[:, None] * (np.array(p1) - np.array(p0))[None, :]
    ijk = np.rint((pts - so) / sp).astype(int)
    ok = np.all((ijk >= 0) & (ijk < np.array(dims)), axis=1)
    vals = np.full(n, np.nan, np.float32)
    if ok.any():
        raw = np.asarray(arr[ijk[ok, 2], ijk[ok, 1], ijk[ok, 0]], np.float32)
        if raw.ndim == 2:
            raw = np.linalg.norm(raw, axis=1) if comp in ("", "mag") else raw[:, int(comp)]
        vals[ok] = raw
    dist = s * float(np.linalg.norm(np.array(p1) - np.array(p0)))
    return {"distance": dist.tolist(),
            "value": [None if not np.isfinite(v) else float(v) for v in vals],
            "unit": a["unit"]}


# ------------------------------------------------------------------ meshes

def _cache_path(kind: str, *key) -> Path:
    digest = hashlib.sha1(repr(key).encode()).hexdigest()[:20]
    d = config.CACHE_DIR / kind
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{digest}.stl"


def _write_stl(poly, out: Path) -> None:
    """Binary STL of the triangles of poly (degenerate ones dropped)."""
    import vtk
    from vtk.util import numpy_support
    tri = vtk.vtkTriangleFilter()
    tri.SetInputData(poly)
    tri.PassVertsOff()
    tri.PassLinesOff()
    tri.Update()
    t = tri.GetOutput()
    if t.GetNumberOfPolys():
        pts = numpy_support.vtk_to_numpy(t.GetPoints().GetData()).astype(np.float32)
        f = numpy_support.vtk_to_numpy(t.GetPolys().GetConnectivityArray()).reshape(-1, 3)
        v = pts[f]
        nrm = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
        ln = np.linalg.norm(nrm, axis=1)
        keep = ln > 0
        v, nrm = v[keep], nrm[keep] / ln[keep, None]
    else:
        v, nrm = np.zeros((0, 3, 3), np.float32), np.zeros((0, 3), np.float32)
    rec = np.zeros(len(v), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    rec["n"], rec["v"] = nrm, v
    tmp = out.with_suffix(".tmp")
    with open(tmp, "wb") as fh:
        fh.write(b"mstar_post".ljust(80, b" "))
        fh.write(np.uint32(len(v)).tobytes())
        fh.write(rec.tobytes())
    tmp.replace(out)


def _simplify(poly, max_tris: int):
    """Fast grid-based (quadric clustering) reduction to about max_tris triangles."""
    import vtk
    from vtk.util import numpy_support
    n = poly.GetNumberOfCells()
    if n <= max_tris:
        return poly
    b = poly.GetBounds()
    pts = numpy_support.vtk_to_numpy(poly.GetPoints().GetData())
    conn = numpy_support.vtk_to_numpy(poly.GetPolys().GetConnectivityArray())
    sample = conn[:3 * min(n, 20000)].reshape(-1, 3)
    edge = float(np.mean(np.linalg.norm(pts[sample[:, 0]] - pts[sample[:, 1]], axis=1)))
    # triangle count scales with (grid resolution)^2
    cell = max(edge, 1e-12) * np.sqrt(n / max_tris) * 1.2
    qc = vtk.vtkQuadricClustering()
    qc.SetInputData(poly)
    qc.SetNumberOfDivisions(*(int(min(2048, max(2, (b[2 * a + 1] - b[2 * a]) / cell)))
                              for a in range(3)))
    qc.AutoAdjustNumberOfDivisionsOff()
    qc.Update()
    return qc.GetOutput()


def surface_stl(path: Path, max_tris: int = 400_000) -> Path:
    """A .vtp/.stl/.vtk surface as a (simplified) binary STL, cached on disk."""
    st = path.stat()
    out = _cache_path("surf", str(path), st.st_mtime_ns, max_tris)
    if out.is_file():
        return out
    import pyvista as pv
    mesh = pv.read(str(path))
    if not isinstance(mesh, pv.PolyData):
        mesh = mesh.extract_surface()
    _write_stl(_simplify(mesh, max_tris), out)
    return out


def isosurface_stl(path: Path, name: str, comp: str, level: float,
                   stride: int = 1, max_tris: int = 600_000) -> Path:
    """Isosurface of a .vti array at level (flying edges), cached as STL."""
    st = path.stat()
    out = _cache_path("iso", str(path), st.st_mtime_ns, name, comp, level, stride, max_tris)
    if out.is_file():
        return out
    import vtk
    from vtk.util import numpy_support
    h = header(path)
    a = find_array(h, name)
    arr = volume_array(path, name)
    sl = (slice(None, None, stride),) * 3
    vol = np.ascontiguousarray(reduce_comp(np.asarray(arr[sl]), comp, a["ncomp"]),
                               np.float32)
    img = vtk.vtkImageData()
    img.SetDimensions(vol.shape[2], vol.shape[1], vol.shape[0])
    img.SetOrigin(*sample_origin(h, a["assoc"]))
    img.SetSpacing(*(s * stride for s in h["spacing"]))
    img.GetPointData().SetScalars(numpy_support.numpy_to_vtk(vol.ravel(), deep=True))
    fe = vtk.vtkFlyingEdges3D()
    fe.SetInputData(img)
    fe.SetValue(0, level)
    fe.ComputeNormalsOff()
    fe.Update()
    _write_stl(_simplify(fe.GetOutput(), max_tris), out)
    return out
