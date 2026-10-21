"""Case discovery, output inventory and Stats access (wraps mstar_stats_summary)."""
from __future__ import annotations

import importlib.util
import os
import re
import time
from functools import lru_cache
from pathlib import Path

import numpy as np

from app import config, vtkio


def _load_mss():
    spec = importlib.util.spec_from_file_location("mstar_stats_summary", config.STATS_SUMMARY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mss = _load_mss()

TIME_IN_NAME = re.compile(r"\.([-+]?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?)\.vt[ipk]$")
_BLOCK = re.compile(r"^block\d+$", re.I)
_SKIP = {"checkpoint", "stats", "input", "zoner_output", "zoner_comparison", "stats_plots"}
_VTK_EXT = (".vti", ".vtp", ".vtk", ".vtu")


def is_case_dir(d: Path) -> bool:
    try:
        return (d / "input.xml").is_file() or (d / "out" / "Stats").is_dir() \
            or (d / "Stats").is_dir() or any(d.glob("*.msb"))
    except OSError:
        return False


def discover(root: Path) -> tuple[bool, list[tuple[str, Path, Path]]]:
    """(single, [(case id, case dir, stats dir)]); ids are paths relative to root."""
    if is_case_dir(root):
        stats = mss.locate_stats_dir(root)
        return True, [(root.name, root, stats)] if stats else []
    return False, [(c.relative_to(root).as_posix(), c, s)
                   for c, s in mss.find_batch_cases(root)]


def _last_time(path: Path) -> float | None:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - 4096))
            lines = fh.read().decode(errors="replace").strip().splitlines()
        return float(lines[-1].split("\t")[0]) if lines else None
    except (OSError, ValueError):
        return None


_info_cache: dict = {}


def case_info(cid: str, case: Path, stats: Path) -> dict:
    """Summary of one case for the case table (cached for 60 s)."""
    key = (str(case), str(stats))
    hit = _info_cache.get(key)
    if hit and time.monotonic() - hit[0] < 60:
        return {**hit[1], "id": cid}
    files = mss.find_stats_files(stats)
    fluid = next((f for f in files if f.name.lower() == "fluid.txt"), None)
    try:
        settings = mss.case_settings(case, stats, cid)
    except Exception as e:  # malformed input.xml etc.
        settings = {"error": str(e)}
    out = output_root(case)
    info = {
        "id": cid, "path": str(case), "name": case.name,
        "parent": str(Path(cid).parent) if "/" in cid else "",
        "stats_dir": str(stats), "n_stats_files": len(files),
        "end_time_s": _last_time(fluid) if fluid else None,
        "has_output": out is not None,
        "output_kinds": sorted(p.name for p in out.iterdir() if p.is_dir())
        if out else [],
        "settings": {k: v for k, v in settings.items() if k not in ("case", "input_xml")},
    }
    _info_cache[key] = (time.monotonic(), info)
    return info


def output_root(case: Path) -> Path | None:
    for d in (case / "out" / "Output", case / "Output"):
        if d.is_dir():
            return d
    return None


def _scan(top: Path) -> list[Path]:
    hits = []
    for dirpath, dirnames, filenames in os.walk(top):
        dirnames[:] = [d for d in dirnames
                       if not d.startswith(".") and d.lower() not in _SKIP]
        hits.extend(Path(dirpath) / f for f in filenames
                    if f.lower().endswith(_VTK_EXT + (".stl",)))
    return hits


_inv_cache: dict = {}


def inventory(case: Path) -> dict:
    """Output series of a case grouped by kind (output folder), cached for 30 s.

    Each kind: {kind, type: volume|slice|surface, ext, times, files, arrays,
    slice_axis, slice_pos}; plus geometry STLs.
    """
    hit = _inv_cache.get(str(case))
    if hit and time.monotonic() - hit[0] < 30:
        return hit[1]
    top = output_root(case) or case
    groups: dict[str, list[tuple[float | None, Path]]] = {}
    stls: dict[str, Path] = {}
    for p in _scan(top):
        if p.suffix.lower() == ".stl":
            stls.setdefault(p.stem, p)
            continue
        parent = p.parent.parent if _BLOCK.match(p.parent.name) else p.parent
        kind = parent.relative_to(top).as_posix() if parent != top else p.stem.split(".")[0]
        m = TIME_IN_NAME.search(p.name)
        groups.setdefault(kind, []).append((float(m.group(1)) if m else None, p))
    for p in case.glob("*.stl"):  # M-Star exports the model STLs next to input.xml
        stls.setdefault(p.stem, p)

    kinds = []
    for kind, items in sorted(groups.items()):
        items.sort(key=lambda x: (x[0] is None, x[0] or 0.0, str(x[1])))
        by_time: dict = {}
        for i, (t, p) in enumerate(items):
            by_time.setdefault(t if t is not None else float(i), []).append(p)
        times = list(by_time)
        first = by_time[times[0]][0]
        try:
            h = vtkio.header(first)
        except Exception as e:
            kinds.append({"kind": kind, "type": "unknown", "error": str(e)})
            continue
        typ, axis, pos = "surface", None, None
        if "NumberOfPolys" in h or "NumberOfPoints" in h:
            # .vtp without polygons: point clouds / slice outlines, not shown in 3D
            typ = "surface" if h.get("NumberOfPolys", 0) > 0 else "points"
        if "extent" in h:
            e = h["extent"]
            thin = [a for a in range(3) if e[2 * a + 1] == e[2 * a]]
            typ = "slice" if thin else "volume"
            if thin:
                axis = thin[0]
                pos = h["origin"][axis] + e[2 * axis] * h["spacing"][axis]
        kinds.append({
            "kind": kind, "type": typ, "ext": first.suffix.lower(), "times": times,
            "files": [[q.relative_to(case).as_posix() for q in by_time[t]] for t in times],
            "arrays": [{k: a[k] for k in ("name", "assoc", "ncomp", "unit")}
                       for a in h["arrays"]],
            "extent": h.get("extent"), "origin": h.get("origin"),
            "spacing": h.get("spacing"), "slice_axis": axis, "slice_pos": pos,
            "file_size": h["size"],
        })
    inv = {"case": str(case), "kinds": kinds,
           "geometry": [{"name": n, "file": p.relative_to(case).as_posix()}
                        for n, p in sorted(stls.items())]}
    _inv_cache[str(case)] = (time.monotonic(), inv)
    return inv


def stats_files(stats: Path) -> list[dict]:
    out = []
    for f in mss.find_stats_files(stats):
        try:
            with open(f) as fh:
                header = fh.readline().rstrip("\n").split("\t")
        except OSError:
            continue
        if len(header) >= 2 and header[0].lower().startswith("time"):
            out.append({"file": f.relative_to(stats).as_posix(),
                        "columns": [mss.fix_unit(h.strip()) for h in header[1:]]})
    return out


@lru_cache(maxsize=64)
def _table(path: str, mtime_ns: int):
    return mss.load_stats_table(Path(path))


def series(stats_file: Path, columns: list[str], max_points: int = 4000) -> dict:
    """Time series of the given columns, uniformly subsampled to max_points."""
    table = _table(str(stats_file), stats_file.stat().st_mtime_ns)
    if table is None:
        raise ValueError(f"{stats_file.name} is not a stats table")
    header, data = table
    raw = [h.strip() for h in header]
    names = [mss.fix_unit(h) for h in raw]  # M-Star's [-] made explicit
    step = max(1, int(np.ceil(len(data) / max_points)))
    rows = data[::step]
    out = {"t": [float(x) for x in rows[:, 0]], "columns": {}}
    for c in columns:
        if c in names:
            j = names.index(c)
        elif c in raw:
            j = raw.index(c)
        else:
            raise KeyError(c)
        v = rows[:, j]
        out["columns"][c] = [float(x) if np.isfinite(x) else None for x in v]
    return out
