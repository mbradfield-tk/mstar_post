"""Post-processing task registry: parameter schemas and command builders.

A task turns (project, included cases, params, run dir) into commands for the
job queue. Every output goes to the run dir; case folders are only read.
"""
from __future__ import annotations

import shlex
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from fastapi import HTTPException

from app import config
from app.paths import safe_path, under


@dataclass
class Task:
    id: str
    label: str
    description: str
    params: list[dict]
    build: Callable[[dict, list[dict], dict, Path], list[dict]]
    per_case: bool = False
    presets: list[dict] = field(default_factory=list)

    def public(self) -> dict:
        return {"id": self.id, "label": self.label, "description": self.description,
                "params": self.params, "presets": self.presets, "per_case": self.per_case}


def P(name, label, type="number", default=None, help="", group="", **kw) -> dict:
    return {"name": name, "label": label, "type": type, "default": default,
            "help": help, "group": group, **kw}


def _opt(argv: list[str], flag: str, value) -> None:
    if value is None or value == "" or value == []:
        return
    if isinstance(value, bool):
        if value:
            argv.append(flag)
    elif isinstance(value, list):
        argv += [flag, *map(str, value)]
    else:
        argv += [flag, str(value)]


def coerce(task: Task, raw: dict) -> dict:
    """Validated params with defaults filled in."""
    out = {}
    for p in task.params:
        v = raw.get(p["name"], p["default"])
        if v is None or v == "":
            out[p["name"]] = None
            continue
        try:
            if p["type"] == "number":
                v = float(v)
            elif p["type"] == "integer":
                v = int(v)
            elif p["type"] == "bool":
                v = bool(v)
            elif p["type"] == "list":
                v = shlex.split(v) if isinstance(v, str) else [str(x) for x in v]
            elif p["type"] == "select":
                if v not in [o["value"] for o in p["options"]]:
                    raise ValueError(f"must be one of {[o['value'] for o in p['options']]}")
            else:
                v = str(v)
        except (TypeError, ValueError) as e:
            raise HTTPException(422, f"{p['label']}: {e}")
        out[p["name"]] = v
    return out


def default_label(task: Task, prm: dict, n_cases: int) -> str:
    """Task name, switched-on options and case count, e.g.
    'M-Star Stats summary + dispersion + uniformity, 5 cases'."""
    on = [p["name"] for p in task.params
          if p["type"] == "bool" and prm.get(p["name"]) and not p["default"]]
    return "".join([task.label, *(f" + {n}" for n in on),
                    f", {n_cases} case{'s' * (n_cases != 1)}"])


# ------------------------------------------------------------------ tasks

def _stats_build(project: dict, cases: list[dict], prm: dict, run: Path) -> list[dict]:
    argv = [config.STATS_SUMMARY_PY, str(config.STATS_SUMMARY)]
    if project["single"]:
        argv += [project["root"], "--output-root", str(run)]
    else:
        argv += [project["root"], "--batch", "--output-root", str(run),
                 "--cases", *[c["id"] for c in cases]]
        _opt(argv, "--ref-case", project.get("ref_case"))
    for name, flag in (("time", "--time"), ("window", "--window"), ("tol", "--tol"),
                       ("mix_rsd", "--mix-rsd"), ("means_vars", "--means-vars"),
                       ("dispersion", "--dispersion"), ("uniformity", "--uniformity"),
                       ("disp_time", "--disp-time"), ("sigma", "--sigma"),
                       ("rho_continuous", "--rho-continuous"),
                       ("dispersed_fraction", "--dispersed-fraction"),
                       ("vessel_diameter", "--vessel-diameter"),
                       ("min_d_dx", "--min-d-dx"), ("min_voxels", "--min-voxels"),
                       ("eps_ratio", "--eps-ratio"), ("k_phi", "--k-phi"),
                       ("zone_scales", "--zone-scales"),
                       ("vertical_axis", "--vertical-axis")):
        _opt(argv, flag, prm.get(name))
    if prm.get("plot"):
        argv += ["--plot", *(prm.get("plot_vars") or [])]
    cmds = [{"argv": argv}]
    if prm.get("canon_body", True):
        cmds.append({"argv": rename_body_argv(run, project.get("ref_case"))})
    return cmds


def rename_body_argv(run: Path, ref_case: str | None = None) -> list[str]:
    """Command normalising the impeller body name ('Moving Body', 'agitator' ->
    'Agitator') in every result file under run (mstar_stats_summary --rename-body)."""
    argv = [config.STATS_SUMMARY_PY, str(config.STATS_SUMMARY), str(run), "--rename-body"]
    _opt(argv, "--ref-case", ref_case)
    return argv


STATS = Task(
    id="stats_summary", label="M-Star Stats summary",
    description="Steady-state mean/std of every Stats variable, mixing times, "
                "optional phase dispersion and uniformity metrics "
                "(mstar_stats_summary.py). Writes batch_summary*.csv, per-case "
                "stats_summary*.csv and HTML plots.",
    params=[
        P("time", "Steady-state start [s]", help="blank = auto-detect from mean velocity",
          group="Steady state"),
        P("window", "Detection window [s]", default=1.0, group="Steady state"),
        P("tol", "Drift tolerance [-]", default=0.02, group="Steady state"),
        P("mix_rsd", "Mixing RSD threshold [%]", default=5.0, group="Steady state"),
        P("plot", "HTML plots per Stats file", "bool", True, group="Outputs"),
        P("canon_body", "Impeller body name = Agitator", "bool", True,
          help="M-Star's 'Moving Body' and 'agitator' are the same impeller: rename both to "
               "'Agitator' in every output so cases share columns", group="Outputs"),
        P("plot_vars", "Variables to plot", "list", help="blank = all", group="Outputs"),
        P("means_vars", "Means-table variables", "list",
          help="blank = default list (dissipation, velocity, power number, ...)",
          group="Outputs"),
        P("dispersion", "Phase dispersion metrics", "bool", False,
          help="interfacial area, a(t) kinetics, drop statistics (two-fluid)",
          group="Dispersion"),
        P("disp_time", "Dispersion start time [s]", help="blank = a(t) plateau",
          group="Dispersion"),
        P("sigma", "Interfacial tension [N/m]", help="for the Hinze check",
          group="Dispersion"),
        P("rho_continuous", "Continuous-phase density [kg/m3]", group="Dispersion"),
        P("dispersed_fraction", "Dispersed fraction [-]", group="Dispersion"),
        P("vessel_diameter", "Vessel diameter [m]", group="Dispersion"),
        P("min_d_dx", "Min drop size [dx]", default=4.0, group="Dispersion"),
        P("min_voxels", "Min drop volume [voxels]", default=8.0, group="Dispersion"),
        P("eps_ratio", "Local/mean eps ratio", default=1.0, group="Dispersion"),
        P("k_phi", "Holdup correction k_phi", default=0.0, group="Dispersion"),
        P("uniformity", "Phase uniformity metrics", "bool", False,
          help="zonal CoV, segregation index, holdup profile (.vti)", group="Uniformity"),
        P("zone_scales", "Zone scales NZxNR", "list", "10x3", group="Uniformity"),
        P("vertical_axis", "Vertical axis", "select", "y", group="Uniformity",
          options=[{"value": a, "label": a} for a in "xyz"]),
    ],
    build=_stats_build,
    presets=[
        {"label": "All Stats means", "params": {}},
        {"label": "Means + dispersion", "params": {"dispersion": True}},
        {"label": "Means + dispersion + uniformity",
         "params": {"dispersion": True, "uniformity": True}},
    ],
)


def _per_case_dirs(cases: list[dict], run: Path) -> list[Path]:
    dirs = []
    for c in cases:
        d = run / c["id"]
        d.mkdir(parents=True, exist_ok=True)
        dirs.append(d)
    return dirs


def _zoner_build(project: dict, cases: list[dict], prm: dict, run: Path) -> list[dict]:
    cmds = []
    for c, d in zip(cases, _per_case_dirs(cases, run)):
        argv = [config.ZONER_PY, str(config.ZONER), c["path"], "--output-dir", str(d)]
        for name, flag in (("variable", "--variable"), ("n_zones", "--n-zones"),
                           ("time", "--time"), ("steady_on", "--steady-on"),
                           ("tol", "--tol"), ("window", "--window"),
                           ("linear", "--linear"), ("log_bins", "--log-bins"),
                           ("instantaneous", "--instantaneous"),
                           ("min_zone_frac", "--min-zone-frac"),
                           ("no_impeller_zone", "--no-impeller-zone"),
                           ("no_render", "--no-render"), ("html", "--html")):
            _opt(argv, flag, prm.get(name))
        cmds.append({"argv": argv, "cwd": str(d), "continue_on_error": True})
    return cmds


ZONER = Task(
    id="cfd_zoner", label="CFD zoner", per_case=True,
    description="Value-based zoning of a Volume .vti field (k-means), per-zone "
                "statistics and heterogeneity metrics (cfd_zoner.py), run per case.",
    params=[
        P("variable", "Variables", "list", "edr",
          help="aliases: edr, tke, velocity, shear, tracer, kolmogorov, micromixing"),
        P("n_zones", "Number of zones", "integer", help="blank = auto (silhouette)"),
        P("time", "Analysis time [s]", help="blank = steady-state detection"),
        P("steady_on", "Steady state on", "select", "variable",
          options=[{"value": "variable", "label": "variable"},
                   {"value": "power", "label": "power"}]),
        P("tol", "Drift tolerance", default=0.02),
        P("window", "Window [s]", default=1.0),
        P("linear", "Cluster linear values", "bool", False),
        P("log_bins", "Fixed log bins", "bool", False),
        P("instantaneous", "Instantaneous field", "bool", False),
        P("min_zone_frac", "Min sub-zone fraction", default=0.005),
        P("no_impeller_zone", "No impeller zone", "bool", False),
        P("no_render", "Skip 3D render (headless)", "bool", True),
        P("html", "Interactive 3D HTML", "bool", False),
    ],
    build=_zoner_build,
)


def _ua_build(project: dict, cases: list[dict], prm: dict, run: Path) -> list[dict]:
    cmds = []
    for c, d in zip(cases, _per_case_dirs(cases, run)):
        argv = [config.CALC_UA_PY, str(config.CALC_UA), c["path"],
                "--csv", str(d / "ua.csv"), "--html", str(d / "ua.html")]
        for name, flag in (("body", "--body"), ("wall_temp", "--wall-temp"),
                           ("t_start", "--t-start"), ("t_end", "--t-end")):
            _opt(argv, flag, prm.get(name))
        cmds.append({"argv": argv, "cwd": str(d), "continue_on_error": True})
    return cmds


UA = Task(
    id="calc_ua", label="Heat transfer U / UA", per_case=True,
    description="Heat transfer coefficient and conductance from Stats "
                "(heat_transfer/calc_ua.py), run per case.",
    params=[P("body", "Body name", "string"), P("wall_temp", "Wall temperature [K]"),
            P("t_start", "Start time [s]", default=0.0), P("t_end", "End time [s]")],
    build=_ua_build,
)


def _custom_build(project: dict, cases: list[dict], prm: dict, run: Path) -> list[dict]:
    script = safe_path(prm["script"]) if prm.get("script") else None
    if script is None or not script.is_file():
        raise HTTPException(422, "script must be an existing file")
    interp = prm.get("interpreter") or sys.executable
    if interp != sys.executable and not any(
            under(Path(interp).resolve(), r) for r in config.ROOTS):
        raise HTTPException(422, "interpreter must be inside the allowed roots")
    tmpl = shlex.split(prm.get("args") or "")

    def fill(ctx: dict) -> list[str]:
        try:
            return [a.format(**ctx) for a in tmpl]
        except (KeyError, IndexError) as e:
            raise HTTPException(422, f"unknown placeholder {e} in arguments")

    base = {"root": project["root"], "run": str(run),
            "cases": " ".join(c["path"] for c in cases)}
    if prm.get("per_case"):
        return [{"argv": [interp, str(script), *fill({**base, "case": c["path"],
                                                      "case_id": c["id"], "out": str(d)})],
                 "cwd": str(d), "continue_on_error": True}
                for c, d in zip(cases, _per_case_dirs(cases, run))]
    return [{"argv": [interp, str(script), *fill({**base, "out": str(run)})]}]


CUSTOM = Task(
    id="custom_script", label="Custom script",
    description="Run any Python script on the selected cases. Argument "
                "placeholders: {case}, {case_id}, {out} (per-case output dir), "
                "{root}, {run}, {cases}.",
    params=[P("script", "Script path", "string"),
            P("interpreter", "Python interpreter", "string", sys.executable),
            P("args", "Arguments", "string", "{case} --output {out}"),
            P("per_case", "Run once per case", "bool", True)],
    build=_custom_build,
)

TASKS: dict[str, Task] = {t.id: t for t in (STATS, ZONER, UA, CUSTOM)}
