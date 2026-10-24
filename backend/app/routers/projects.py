"""Projects: a source folder of cases, the included subset and all run outputs."""
from __future__ import annotations

import csv
import json
import os
import re
import shutil
import subprocess
import time
import zipfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
import numpy as np

from app import cases, config, jobs, tasks
from app import caseid
from app import cases as cases_mod
from app.paths import safe_child, safe_path

router = APIRouter(prefix="/api/projects", tags=["projects"])
catalog = APIRouter(prefix="/api/cases", tags=["cases"])
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@catalog.get("")
def all_cases(details: bool = True, x_user: str | None = Header(None)) -> list[dict]:
    """Every case of every project, one row per case uid (a folder used by several
    projects appears once with all of them), with its marker status and case info."""
    rows: dict[str, dict] = {}
    taken = caseid.known_uids()
    for f in sorted(config.PROJECTS_DIR.glob("*/project.json")):
        try:
            p = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if caseid.ensure_uids(p, x_user, taken):
            save(p)
        for c in p["cases"]:
            r = rows.setdefault(c["uid"], {
                "uid": c["uid"], "path": c["path"], "stats_dir": c["stats_dir"],
                "name": Path(c["path"]).name, "id_written": c.get("id_written", False),
                "missing": not Path(c["path"]).is_dir(), "projects": []})
            r["projects"].append({"id": p["id"], "name": p["name"], "case_id": c["id"],
                                  "included": c["included"], "owner": p.get("owner", ""),
                                  "program": p.get("program", ""), "purpose": p.get("purpose", "")})
    out = list(rows.values())
    if details:
        for r in out:
            r["info"] = None if r["missing"] else _safe_info(
                {"id": r["name"], "path": r["path"], "stats_dir": r["stats_dir"]})
    return sorted(out, key=lambda r: r["path"])


def _dir(pid: str) -> Path:
    if not _ID.match(pid):
        raise HTTPException(422, "invalid project id")
    d = config.PROJECTS_DIR / pid
    if not (d / "project.json").is_file():
        raise HTTPException(404, f"no project '{pid}'")
    return d


def load(pid: str) -> dict:
    return json.loads((_dir(pid) / "project.json").read_text())


def save(p: dict) -> None:
    d = config.PROJECTS_DIR / p["id"]
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "project.json.tmp"
    tmp.write_text(json.dumps(p, indent=2))
    tmp.replace(d / "project.json")


def _discover(root: Path, old: dict | None = None) -> tuple[bool, list[dict]]:
    single, found = cases.discover(root)
    prev = {c["id"]: c for c in (old or {}).get("cases", [])}
    return single, [{"id": cid, "path": str(c), "stats_dir": str(s),
                     "included": prev.get(cid, {}).get("included", True),
                     **({"uid": prev[cid]["uid"]} if prev.get(cid, {}).get("uid") else {})}
                    for cid, c, s in found]


class NewProject(BaseModel):
    name: str
    root: str
    owner: str | None = None
    program: str | None = None   # associated project / programme name, e.g. TAK-360
    purpose: str | None = None   # e.g. pipeline, development, reactor characterization


class ProjectPatch(BaseModel):
    name: str | None = None
    included: dict[str, bool] | None = None
    ref_case: str | None = None
    notes: str | None = None
    aliases: dict[str, str] | None = None
    owner: str | None = None
    program: str | None = None
    purpose: str | None = None


META_KEYS = ("owner", "program", "purpose")
_META_MAX = 80


def _meta(v: str | None) -> str:
    return re.sub(r"\s+", " ", (v or "").strip())[:_META_MAX]


@router.get("")
def list_projects() -> list[dict]:
    out = []
    for f in sorted(config.PROJECTS_DIR.glob("*/project.json")):
        try:
            p = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        out.append({k: p.get(k) for k in ("id", "name", "root", "single", "created", *META_KEYS)}
                   | {"n_cases": len(p["cases"]),
                      "n_included": sum(c["included"] for c in p["cases"])})
    return sorted(out, key=lambda p: -(p["created"] or 0))


@router.post("")
def create_project(body: NewProject, x_user: str | None = Header(None)) -> dict:
    root = safe_path(body.root)
    if not root.is_dir():
        raise HTTPException(422, "root must be a directory")
    single, found = _discover(root)
    if not found:
        raise HTTPException(422, f"no M-Star cases (Stats folders) found under {root}")
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", body.name.strip()).strip("-")[:48] or "project"
    pid, i = slug, 2
    while (config.PROJECTS_DIR / pid).exists():
        pid, i = f"{slug}-{i}", i + 1
    p = {"id": pid, "name": body.name.strip() or pid, "root": str(root),
         "single": single, "created": time.time(), "cases": found,
         "ref_case": found[0]["id"], "notes": "",
         "owner": _meta(body.owner) or jobs.clean_user(x_user),
         "program": _meta(body.program), "purpose": _meta(body.purpose)}
    caseid.ensure_uids(p, x_user)
    save(p)
    return p


@router.get("/{pid}")
def get_project(pid: str, details: bool = True, refresh: bool = False,
                x_user: str | None = Header(None)) -> dict:
    p = load(pid)
    if caseid.ensure_uids(p, x_user):  # projects created before case ids existed
        save(p)
    if refresh:
        for c in p["cases"]:
            cases.forget(Path(c["path"]), Path(c["stats_dir"]))
    if details:
        p["cases"] = [{**c, "info": _safe_info(c)} for c in p["cases"]]
    return _status(p)


def _status(p: dict) -> dict:
    """Copy of p flagging a missing project root and missing case folders (e.g. renamed)."""
    return {**p, "root_missing": not Path(p["root"]).is_dir(),
            "cases": [{**c, "missing": not Path(c["path"]).is_dir()} for c in p["cases"]]}


def _safe_info(c: dict) -> dict | None:
    try:
        return cases.case_info(c["id"], Path(c["path"]), Path(c["stats_dir"]))
    except Exception as e:
        return {"error": str(e)}


@router.patch("/{pid}")
def patch_project(pid: str, body: ProjectPatch) -> dict:
    p = load(pid)
    if body.name is not None:
        p["name"] = body.name
    if body.notes is not None:
        p["notes"] = body.notes
    for k in META_KEYS:
        v = getattr(body, k)
        if v is not None:
            p[k] = _meta(v)
    if body.ref_case is not None:
        if body.ref_case not in {c["id"] for c in p["cases"]}:
            raise HTTPException(422, "unknown reference case")
        p["ref_case"] = body.ref_case
    if body.aliases is not None:
        ids = {c["id"] for c in p["cases"]}
        p["aliases"] = {k: v.strip()[:80] for k, v in body.aliases.items()
                        if k in ids and v.strip() and v.strip() != k}
        names = [p["aliases"].get(i, i) for i in ids]
        if len(set(names)) < len(names):
            raise HTTPException(422, "case display names must be unique")
    for c in p["cases"]:
        if body.included and c["id"] in body.included:
            c["included"] = bool(body.included[c["id"]])
    save(p)
    return _status(p)


class Relocate(BaseModel):
    root: str | None = None
    cases: dict[str, str] = {}


@router.post("/{pid}/relocate")
def relocate(pid: str, body: Relocate) -> dict:
    """Point a project at moved/renamed data: a new root moves every case that was
    under the old root along with it; cases maps case ids to new case folders. Case
    ids are kept, so runs, aliases and the reference case stay valid."""
    p = load(pid)
    old_root = Path(p["root"])
    if body.root:
        new_root = safe_path(body.root)
        if not new_root.is_dir():
            raise HTTPException(422, f"not a directory: {body.root}")
        for c in p["cases"]:
            for k in ("path", "stats_dir"):
                old = Path(c[k])
                if old == old_root or old_root in old.parents:
                    c[k] = str(new_root / old.relative_to(old_root))
        p["root"] = str(new_root)
    by_id = {c["id"]: c for c in p["cases"]}
    for cid, path in body.cases.items():
        if cid not in by_id:
            raise HTTPException(422, f"unknown case: {cid}")
        d = safe_path(path)
        stats = cases.mss.locate_stats_dir(d) if d.is_dir() and cases.is_case_dir(d) else None
        if stats is None:
            raise HTTPException(422, f"{path}: no M-Star case (Stats folder) found")
        by_id[cid]["path"], by_id[cid]["stats_dir"] = str(d), str(Path(stats).resolve())
    caseid.ensure_uids(p)
    save(p)
    for c in p["cases"]:
        cases.forget(Path(c["path"]), Path(c["stats_dir"]))
    return get_project(pid)


@router.post("/{pid}/rediscover")
def rediscover(pid: str, x_user: str | None = Header(None)) -> dict:
    p = load(pid)
    p["single"], p["cases"] = _discover(safe_path(p["root"]), p)
    caseid.ensure_uids(p, x_user)
    save(p)
    return _status(p)


@router.delete("/{pid}")
def delete_project(pid: str) -> dict:
    d = _dir(pid)
    if any(j["status"] in ("queued", "running") for j in jobs.list_jobs(pid)):
        raise HTTPException(409, "project has active jobs")
    shutil.rmtree(d)
    return {"deleted": pid}


# ------------------------------------------------------------------ runs

class RunRequest(BaseModel):
    task: str
    params: dict = {}
    cases: list[str] | None = None
    label: str | None = None


@router.post("/{pid}/run")
async def run_task(pid: str, body: RunRequest, x_user: str | None = Header(None)) -> dict:
    p = load(pid)
    task = tasks.TASKS.get(body.task)
    if task is None:
        raise HTTPException(404, f"unknown task '{body.task}'")
    wanted = set(body.cases) if body.cases is not None else None
    sel = [c for c in p["cases"]
           if (c["id"] in wanted if wanted is not None else c["included"])]
    if not sel:
        raise HTTPException(422, "no cases selected")
    prm = tasks.coerce(task, body.params)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    run = config.PROJECTS_DIR / pid / "runs" / f"{stamp}_{task.id}"
    i = 2
    while run.exists():
        run, i = run.with_name(f"{stamp}_{task.id}_{i}"), i + 1
    run.mkdir(parents=True)
    try:
        cmds = task.build(p, sel, prm, run)
    except Exception:
        shutil.rmtree(run, ignore_errors=True)
        raise
    label = (body.label or "").strip() or tasks.default_label(task, prm, len(sel))
    label = jobs.unique_label(pid, label)
    return await jobs.manager.submit(pid, task.id, label, cmds, run,
                                     {"params": prm, "cases": [c["id"] for c in sel]}, x_user)


@router.get("/{pid}/runs")
def list_runs(pid: str) -> list[dict]:
    d = _dir(pid) / "runs"
    by_dir = {j["run_dir"]: j for j in jobs.list_jobs(pid)}
    out = []
    for r in sorted(d.glob("*"), reverse=True) if d.is_dir() else []:
        if not r.is_dir():
            continue
        meta = {}
        try:
            meta = json.loads((r / "job.json").read_text())
        except (OSError, ValueError):
            pass
        j = by_dir.get(str(r), {})
        found: dict[str, list[str]] = {".csv": [], ".html": [], ".png": []}
        for root, _dirs, files in os.walk(r):
            rel = Path(root).relative_to(r)
            for f in files:
                ext = os.path.splitext(f)[1].lower()
                if ext in found:
                    found[ext].append((rel / f).as_posix())
        out.append({"name": r.name, "path": f"runs/{r.name}", "task": meta.get("task"),
                    "label": j.get("label") or meta.get("label"),
                    "user": j.get("user") or meta.get("user"),
                    "job_id": meta.get("id"), "status": j.get("status", "unknown"),
                    "params": meta.get("params", {}),
                    "created_at": j.get("created_at"), "finished_at": j.get("finished_at"),
                    "csvs": sorted(found[".csv"]), "htmls": sorted(found[".html"]),
                    "images": sorted(found[".png"])})
    return out


@router.delete("/{pid}/runs/{name}")
def delete_run(pid: str, name: str) -> dict:
    r = safe_child(_dir(pid) / "runs", name)
    j = next((j for j in jobs.list_jobs(pid) if j["run_dir"] == str(r)), None)
    if j and j["status"] in ("queued", "running"):
        raise HTTPException(409, "run is still active")
    shutil.rmtree(r)
    return {"deleted": name}


# ------------------------------------------------------------------ run time series

# time_s-first CSVs with several rows per time (profiles, per-drop lists)
_NOT_SERIES = {"holdup_profile.csv", "vof_dsd.csv"}
_TIME_COLS = ("time [s]", "time_s")  # current and pre-unit-label headers, compared lower-case


def _is_time(col: str) -> bool:
    return col.strip().lower() in _TIME_COLS


def _case_dirs(p: dict, run: Path) -> dict[str, Path]:
    """Per-case output folder of a run. Single-case projects: <run>/<case id> when the
    task wrote per-case folders (e.g. calc_ua), else the run folder itself (stats_summary)."""
    if p["single"]:
        if not p["cases"]:
            return {}
        cid = p["cases"][0]["id"]
        return {cid: run / cid if (run / cid).is_dir() else run}
    return {c["id"]: run / c["id"] for c in p["cases"] if (run / c["id"]).is_dir()}


def _header(f: Path) -> list[str]:
    with open(f, newline="") as fh:
        return next(csv.reader(fh), [])


@router.get("/{pid}/runs/{name}/timeseries")
def run_timeseries(pid: str, name: str) -> list[dict]:
    """Per-case CSVs of a run whose first column is time_s, with their columns
    and the cases that have them."""
    p = load(pid)
    run = safe_child(_dir(pid) / "runs", name)
    files: dict[str, dict] = {}
    for cid, d in _case_dirs(p, run).items():
        for f in sorted(d.glob("*.csv")):
            hdr = _header(f) if f.name not in _NOT_SERIES else []
            if not hdr or not _is_time(hdr[0]):
                continue
            e = files.setdefault(f.name, {"file": f.name, "columns": [], "cases": []})
            e["cases"].append(cid)
            e["columns"] += [c for c in hdr[1:] if c not in e["columns"]]
    return sorted(files.values(), key=lambda e: e["file"])


@router.get("/{pid}/runs/{name}/series")
def run_series(pid: str, name: str, file: str, columns: list[str] = Query(...),
               cases: list[str] | None = Query(None), max_points: int = 4000) -> dict:
    """{case: {t, columns}} from <run>/<case>/<file>, subsampled to max_points."""
    if Path(file).name != file or not file.endswith(".csv"):
        raise HTTPException(422, "file must be a CSV name")
    p = load(pid)
    run = safe_child(_dir(pid) / "runs", name)
    max_points = max(1, min(max_points, 50000))
    out = {}
    for cid, d in _case_dirs(p, run).items():
        if cases and cid not in cases or not (d / file).is_file():
            continue
        f = safe_child(run, (d / file).relative_to(run).as_posix())
        with open(f, newline="") as fh:
            reader = csv.reader(fh)
            hdr = next(reader, [])
            rows = list(reader)
        if not hdr or not _is_time(hdr[0]):
            raise HTTPException(422, f"{file} has no time_s column")
        idx = {c: hdr.index(c) for c in columns if c in hdr}
        num = [[_num(v) for v in r] for r in rows]
        if len(num) > max_points and idx:
            vals = np.array([[r[j] if j < len(r) and isinstance(r[j], float) else np.nan
                              for j in idx.values()] for r in num], float)
            num = [num[i] for i in cases_mod.decimate_idx(vals, max_points)]
        out[cid] = {"t": [r[0] for r in num],
                    "columns": {c: [r[j] if j < len(r) and not isinstance(r[j], str)
                                    else None for r in num] for c, j in idx.items()}}
    return out


# ------------------------------------------------------------------ files

@router.post("/{pid}/rename-body")
def rename_body(pid: str, run: str | None = Query(None)) -> dict:
    """Rename the impeller body ('Moving Body', 'agitator') to 'Agitator' in the
    result files of one run or of every finished run of the project (CSV headers
    and cells with merged columns, HTML, file names; case folders untouched)."""
    p = load(pid)
    base = _dir(pid) / "runs"
    runs = [safe_child(base, run)] if run else sorted(d for d in base.glob("*") if d.is_dir()) if base.is_dir() else []
    active = {j["run_dir"] for j in jobs.list_jobs(pid) if j["status"] in ("queued", "running")}
    out, log = [], []
    for r in runs:
        if str(r) in active:
            out.append({"run": r.name, "skipped": "job still active"})
            continue
        try:
            res = subprocess.run(tasks.rename_body_argv(r, p.get("ref_case")), capture_output=True,
                                 text=True, timeout=600)
        except subprocess.TimeoutExpired:
            out.append({"run": r.name, "error": "timed out"})
            continue
        text = (res.stdout + res.stderr).strip()
        m = re.search(r"(\d+) file\(s\) updated", text)
        out.append({"run": r.name, "changed": int(m.group(1)) if m else None,
                    **({"error": text[-2000:]} if res.returncode else {})})
        log.append(text)
    return {"runs": out, "changed": sum(x.get("changed") or 0 for x in out), "log": "\n".join(log)[-20000:]}

@router.get("/{pid}/file")
def get_file(pid: str, path: str, download: bool = False):
    f = safe_child(_dir(pid), path)
    if not f.is_file():
        raise HTTPException(422, "not a file")
    return FileResponse(f, filename=f.name if download else None,
                        content_disposition_type="attachment" if download else "inline")


@router.get("/{pid}/csv")
def get_csv(pid: str, path: str, max_rows: int = 50000) -> dict:
    f = safe_child(_dir(pid), path)
    with open(f, newline="") as fh:
        reader = csv.reader(fh)
        try:
            columns = next(reader)
        except StopIteration:
            return {"columns": [], "rows": [], "truncated": False}
        rows = []
        for i, r in enumerate(reader):
            if i >= max_rows:
                return {"columns": columns, "rows": rows, "truncated": True}
            rows.append([_num(v) for v in r])
    return {"columns": columns, "rows": rows, "truncated": False}


def _num(v: str):
    try:
        x = float(v)
        return x if x == x and abs(x) != float("inf") else None
    except ValueError:
        return v


@router.get("/{pid}/zip")
def get_zip(pid: str, background: BackgroundTasks, path: str = "runs"):
    base = safe_child(_dir(pid), path)
    out = config.CACHE_DIR / f"export_{pid}_{time.time_ns()}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        files = [base] if base.is_file() else sorted(base.rglob("*"))
        for f in files:
            if f.is_file():
                z.write(f, f.relative_to(base.parent))
    background.add_task(out.unlink, missing_ok=True)
    return FileResponse(out, filename=f"{pid}_{base.name}.zip",
                        media_type="application/zip")
