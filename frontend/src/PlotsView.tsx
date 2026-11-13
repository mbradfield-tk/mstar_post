import { memo, useEffect, useMemo, useRef, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, caseName, copyText, download, fmt, toCsv, type CsvTable, type Project, type Run, type RunSeriesFile,
         type SeriesStat, type StatsFile, type TaskDef } from "./api";
import CaseNames from "./CaseNames";
import CaseSelect from "./CaseSelect";
import { useDialog } from "./Dialog";
import ErrorBoundary from "./ErrorBoundary";
import Plot from "./Plot";
import { caseColor, PlotStyleEditor, usePlotStyle, type PlotStyle } from "./PlotStyle";
import StatsSeries, { useDebounced } from "./StatsSeries";
import VariableSearch from "./VariableSearch";
import ZonesPlot from "./ZonesPlot";
import { loadRunResults, newestFirst, pct, PCT_HELP, runHasCases, runSeriesFiles, runStamp, selectedCaseIds, shortName, unitOf,
         type Cell } from "./results";

type Mode = "find" | "series" | "single" | "bars" | "scatter" | "detail" | "zones";
type MeansView = "bars" | "scatter" | "detail";
const MODES: Mode[] = ["find", "series", "single", "bars", "scatter", "detail", "zones"];
const isMeans = (m: Mode): m is MeansView => m === "bars" || m === "scatter" || m === "detail";
// the three means modes are views of one pane (they share sources, cases and variables)
const paneOf = (m: Mode) => (isMeans(m) ? "means" : m);
const MODE_LABEL: Record<Mode, string> = { find: "Find variable", series: "Time series", single: "Case time series",
  bars: "Compare means", scatter: "Trend (x-y)", detail: "Case detail", zones: "Zones" };
const MODE_HELP: Record<Mode, string> = {
  find: "search a variable in every result of the selected cases (M-Star Stats files, job tables and time series) and plot it",
  series: "M-Star Stats variables (or run metrics) over time for several cases in stacked panels",
  single: "one case: pick a Stats file or a job's time-series CSV (e.g. ua.csv) and its variables to plot over time",
  bars: "steady-state means per case as bars",
  scatter: "one mean against another across cases, with a power-law fit",
  detail: "every mean of one case against the reference case",
  zones: "CFD zoner results compared across cases: zone maps side by side, zone and heterogeneity bars, exposure curves",
};

export default function PlotsView({ project, onProjectChange, active, onReset }: {
  project: Project;
  onProjectChange: (p: Project) => void;
  active: boolean;
  onReset: () => void;
}) {
  const [mode, setMode] = useState<Mode>(() => {
    const m = localStorage.getItem(`mstar_post.plotmode.${project.id}`) as Mode | null;
    return m && MODES.includes(m) ? m : "series";
  });
  useEffect(() => localStorage.setItem(`mstar_post.plotmode.${project.id}`, mode), [project.id, mode]);
  // A mode stays mounted (hidden) once it was opened, like the tabs of the app: its data, choices
  // and zoom survive a switch and nothing is requested again. Plots drawn while hidden get their
  // size from the resize event fired on every switch.
  const [visited, setVisited] = useState<Set<string>>(() => new Set([paneOf(mode)]));
  const [meansView, setMeansView] = useState<MeansView>(isMeans(mode) ? mode : "bars");
  const go = (m: Mode) => {
    setVisited((v) => (v.has(paneOf(m)) ? v : new Set(v).add(paneOf(m))));
    if (isMeans(m)) setMeansView(m);
    setMode(m);
  };
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, [mode]);
  const [style, setStyle] = usePlotStyle(project.id);
  const ui = useDialog();
  const refKey = `mstar_post.plotref.${project.id}`;
  // Plots-only reference for % differences. Only a choice made here is saved: without one (or when
  // the saved case is no longer in the project) Plots follows the project reference case.
  const [refPick, setRefPick] = useState<string | null>(() => {
    const s = localStorage.getItem(refKey);
    return s && s !== project.ref_case ? s : null;
  });
  const ref = refPick && project.cases.some((c) => c.id === refPick) ? refPick : project.ref_case ?? project.cases[0]?.id ?? "";
  const pickRef = (id: string) => {
    const own = id !== project.ref_case;  // choosing the project reference means "follow the project" again
    setRefPick(own ? id : null);
    if (own) localStorage.setItem(refKey, id); else localStorage.removeItem(refKey);
  };
  const selIds = selectedCaseIds(project);
  // a variable found by the search becomes a new Time series panel (panelsRev tells an open Time series mode)
  const [panelsRev, setPanelsRev] = useState(0);
  const plotSeries = (src: string, file: string, col: string) => {
    const ps = loadPanels(project.id);
    const key = Math.max(0, ...ps.map((p) => p.key)) + 1;
    localStorage.setItem(`mstar_post.plots.${project.id}`, JSON.stringify([...ps, { key, src, file, cols: [col], win: 0, logY: false }]));
    setPanelsRev((n) => n + 1);
    go("series");
  };
  // one pane per opened mode; a render error in one of them leaves the others and the mode buttons usable
  const pane = (p: string, label: string, el: JSX.Element) => visited.has(p) && (
    <div key={p} style={{ display: paneOf(mode) === p ? "contents" : "none" }}>
      <ErrorBoundary label={`Plots > ${label}`}>{el}</ErrorBoundary>
    </div>);
  const on = (p: string) => active && paneOf(mode) === p;
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow">Plots</h2>
        {MODES.map((m) => (
          <button key={m} className={mode === m ? "primary" : ""} title={MODE_HELP[m]} onClick={() => go(m)}>{MODE_LABEL[m]}</button>
        ))}
        <label title={`baseline for '% vs ref' in all plot modes; the project reference case (Cases tab) unless another one is chosen here.\n${PCT_HELP}`}>Reference case{" "}
          <select value={ref} onChange={(e) => pickRef(e.target.value)}>
            {project.cases.filter((c) => selIds.has(c.id) || c.id === ref).map((c) => <option key={c.id} value={c.id}>{caseName(project, c.id)}
              {c.id === project.ref_case ? " (project ref)" : ""}{selIds.has(c.id) ? "" : " (not selected)"}</option>)}
          </select></label>
        <button onClick={async () => await ui.confirm({ title: "Reset Plots?", ok: "Reset",
          body: <p>All panels, sources, case selections and the reference case go back to the defaults. Plot style and case names are kept.</p> }) && onReset()}>Reset</button>
        {ui.dialog}
      </div>
      <CaseSelect project={project} onChange={onProjectChange} />
      <CaseNames project={project} onChange={onProjectChange} />
      <PlotStyleEditor style={style} setStyle={setStyle} project={project}
                       caseIds={project.cases.map((c) => c.id)} />
      <div className="small muted">{MODE_LABEL[mode]}: {MODE_HELP[mode]}.</div>
      {pane("find", MODE_LABEL.find, <VariableSearch project={project} style={style} refCase={ref} onPlotSeries={plotSeries} active={on("find")} />)}
      {pane("series", MODE_LABEL.series, <SeriesPlot project={project} style={style} active={on("series")} refCase={ref} panelsRev={panelsRev} />)}
      {pane("single", MODE_LABEL.single, <StatsSeries project={project} style={style} active={on("single")} />)}
      {pane("zones", MODE_LABEL.zones, <ZonesPlot project={project} style={style} active={on("zones")} refCase={ref} />)}
      {pane("means", MODE_LABEL[meansView], <MeansPlots project={project} view={meansView} style={style} active={on("means")} refCase={ref} />)}
    </div>
  );
}

const caseIndex = (p: Project, id: string) => p.cases.findIndex((c) => c.id === id);
const sameRuns = (a: Run[], b: Run[]) => JSON.stringify(a) === JSON.stringify(b);
const pctDiff = pct;  // the app's one "% vs ref": (value - ref) / ref x 100, see results.ts

// linear interpolation of v(t) at x (t ascending); null outside the range or at gaps
function interpAt(t: number[], v: (number | null)[], x: number): number | null {
  const n = t.length;
  if (!n || x < t[0] || x > t[n - 1]) return null;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m; else hi = m; }
  const a = v[lo], b = v[hi];
  if (a === null || b === null) return null;
  return t[hi] === t[lo] ? a : a + (b - a) * (x - t[lo]) / (t[hi] - t[lo]);
}

const movingAvg = (t: number[], v: (number | null)[], win: number) => {
  if (!(win > 0)) return v;
  const out: (number | null)[] = [];
  let j = 0, s = 0, n = 0;
  for (let i = 0; i < t.length; i++) {
    const x = v[i];
    if (x !== null) { s += x; n++; }
    while (t[i] - t[j] > win) { const y = v[j]; if (y !== null) { s -= y; n--; } j++; }
    out.push(n ? s / n : null);
  }
  return out;
};

// One stacked subplot per panel, all sharing the time axis. src is "stats"
// (case Stats .txt) or "run:<run name>" (per-case time_s CSVs of a run).
type Panel = { key: number; src: string; file: string; cols: string[]; win: number; logY: boolean;
               rel?: "none" | "diff" | "pct" };
type SeriesMap = Record<string, { t: number[]; v: (number | null)[] }>;

const DASHES = ["solid", "dash", "dot", "dashdot", "longdash"] as const;
const DEFAULT_PANEL: Panel = { key: 1, src: "stats", file: "Fluid.txt",
                               cols: ["Mean Velocity [m/s]"], win: 0, logY: false };
const dataKey = (p: Panel, col: string) => `${p.src}|${p.file}|${col}`;
const statKey = (k: string, caseId: string) => `${k}\n${caseId}`;
// m without the entries whose key matches (the same object when nothing matches: no re-render)
const dropKeys = (m: Record<string, string>, gone: (k: string) => boolean) =>
  (Object.keys(m).some(gone) ? Object.fromEntries(Object.entries(m).filter(([k]) => !gone(k))) : m);

function loadPanels(pid: string): Panel[] {
  try {
    const v = JSON.parse(localStorage.getItem(`mstar_post.plots.${pid}`) ?? "");
    if (Array.isArray(v) && v.length && v.every((p) => typeof p.src === "string" && Array.isArray(p.cols)))
      return v as Panel[];
  } catch { /* none saved */ }
  return [DEFAULT_PANEL];
}

function SeriesPlot({ project, style, active, refCase, panelsRev }: {
  project: Project; style: PlotStyle; active: boolean; refCase: string; panelsRev: number;
}) {
  // the cases worked on: the selected ones, or all when none is selected
  const selIds = selectedCaseIds(project);
  const cases = project.cases.filter((c) => selIds.has(c.id));
  const hideKey = `mstar_post.plots.hidden.${project.id}`;
  // cases hidden from the plot (data of all selected cases is still loaded)
  const [hidden, setHidden] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(hideKey) ?? "[]"); } catch { return []; }
  });
  useEffect(() => localStorage.setItem(hideKey, JSON.stringify(hidden)), [hideKey, hidden]);
  const shownCases = cases.filter((c) => !hidden.includes(c.id));
  const [panels, setPanels] = useState<Panel[]>(() => loadPanels(project.id));
  const [caseFiles, setCaseFiles] = useState<Record<string, StatsFile[]>>({});
  const [runs, setRuns] = useState<Run[]>([]);
  const [runFiles, setRunFiles] = useState<Record<string, RunSeriesFile[]>>({});
  const [tss, setTss] = useState<number | "">("");
  const [cache, setCache] = useState<Record<string, SeriesMap>>({});
  // failed requests by what was asked ("runs", "files|<case>", "series|<data key>[\n<case>]"): only those
  // still relevant are shown, and a request that is made again clears its entry
  const [errors, setErrors] = useState<Record<string, string>>({});
  const runFilesSel = (name: string) => (runFiles[name] ?? []).filter((f) => f.cases.some((id) => selIds.has(id)));
  const caseKey = cases.map((c) => c.id).join("|");
  // requests already made: case ids (Stats file lists) and "<data key>\n<case id>" / "<data key>" (series)
  const asked = useRef({ files: new Set<string>(), series: new Set<string>() });
  const [again, setAgain] = useState(0);  // series dropped (a run made again): ask for them again

  const forProject = useRef(project.id);
  useEffect(() => {
    if (forProject.current === project.id) return;  // the initial state already belongs to this project
    forProject.current = project.id;
    setPanels(loadPanels(project.id));
    setCache({});
    setCaseFiles({});
    asked.current = { files: new Set(), series: new Set() };
  }, [project.id]);
  // a panel added by "Find variable" while this mode is open
  useEffect(() => { if (panelsRev) setPanels(loadPanels(project.id)); }, [panelsRev]); // eslint-disable-line react-hooks/exhaustive-deps

  // The run list and the time-series files of every run: on the first show and whenever the mode or
  // the tab is shown again. The file lists come from the shared per-run cache in one update; the
  // series of a run that was made again meanwhile (new stamp) are dropped and read again.
  const stamps = useRef<Map<string, string> | null>(null);
  const runsBusy = useRef(false);
  useEffect(() => {
    if ((!active && stamps.current) || runsBusy.current) return;
    runsBusy.current = true;
    api.runs(project.id).then((rs) => {
      setRuns((old) => (sameRuns(old, rs) ? old : rs));
      const redone = rs.filter((r) => stamps.current?.has(r.name) && stamps.current.get(r.name) !== runStamp(r)).map((r) => `run:${r.name}|`);
      stamps.current = new Map(rs.map((r) => [r.name, runStamp(r)]));
      if (redone.length) {
        const old = (k: string) => redone.some((p) => k.startsWith(p));
        for (const k of [...asked.current.series]) if (old(k)) asked.current.series.delete(k);
        setCache((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !old(k))));
        setAgain((n) => n + 1);
      }
      setErrors((m) => dropKeys(m, (k) => k === "runs"));
      Promise.all(rs.map((r) => runSeriesFiles(project.id, r).catch(() => [] as RunSeriesFile[]).then((fs) => [r.name, fs] as const)))
        .then((got) => setRunFiles((m) => {
          const next = Object.fromEntries(got);
          return JSON.stringify(next) === JSON.stringify(m) ? m : next;
        }));
    }).catch((e) => setErrors((m) => ({ ...m, runs: e.message }))).finally(() => { runsBusy.current = false; });
  }, [project.id, active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stats file lists of the selected cases, also of cases selected later, in one update per batch; a
  // case whose request fails gets an empty list, so it is skipped instead of blocking the other cases
  useEffect(() => {
    const todo = cases.filter((c) => !asked.current.files.has(c.id));
    if (!todo.length) return;
    todo.forEach((c) => asked.current.files.add(c.id));
    Promise.all(todo.map((c) => api.stats(c.path).then((fs) => [c.id, fs, ""] as const, (e: Error) => [c.id, [] as StatsFile[], e.message] as const)))
      .then((got) => {
        setCaseFiles((m) => ({ ...m, ...Object.fromEntries(got.map(([id, fs]) => [id, fs])) }));
        const bad = got.filter(([, , e]) => e).map(([id, , e]) => [`files|${id}`, `${id}: ${e}`]);
        if (bad.length) setErrors((m) => ({ ...m, ...Object.fromEntries(bad) }));
      });
  }, [project.id, caseKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // union of the Stats files/columns of all selected cases, reference case first
  const statsFiles = useMemo(() => {
    const order = [...cases].sort((a, b) => Number(b.id === project.ref_case) - Number(a.id === project.ref_case));
    const out: StatsFile[] = [];
    for (const c of order) for (const f of caseFiles[c.id] ?? []) {
      const e = out.find((x) => x.file === f.file);
      if (!e) out.push({ file: f.file, columns: [...f.columns] });
      else f.columns.forEach((col) => { if (!e.columns.includes(col)) e.columns.push(col); });
    }
    return out;
  }, [caseFiles, project.ref_case, caseKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const filesReady = cases.every((c) => caseFiles[c.id]);
  // the case's file holding col: the same name, else one of the same kind
  // (e.g. MovingBody_agitator.txt for MovingBody_Moving Body.txt)
  const statsFileFor = (caseId: string, file: string, col: string): string | null => {
    const fs = caseFiles[caseId] ?? [];
    if (fs.some((f) => f.file === file && f.columns.includes(col))) return file;
    const kind = file.split(/[_./]/)[0];
    return fs.find((f) => f.file.split(/[_./]/)[0] === kind && f.columns.includes(col))?.file ?? null;
  };

  useEffect(() => {
    localStorage.setItem(`mstar_post.plots.${project.id}`, JSON.stringify(panels));
  }, [panels, project.id]);

  const filesOf = (src: string): { file: string; columns: string[] }[] =>
    src === "stats" ? statsFiles : runFilesSel(src.slice(4));

  // saved panels may name columns from before unit labels: "E" -> "E = a/a0 [...]"
  useEffect(() => {
    let changed = false;
    const next = panels.map((p) => {
      const cols = filesOf(p.src).find((f) => f.file === p.file)?.columns;
      if (!cols || (p.src === "stats" && !filesReady)) return p;
      const fixed = p.cols.map((c) => cols.includes(c) ? c
        : cols.find((x) => x.startsWith(`${c} `) || x.startsWith(`${c.replace(/_(m|m2|m3|s|dx)(?=_|$)/, "")} `)
                     || x.replace(/ \[-\]$/, "") === c.replace(/ \[[^\]]*\]$/, "")) ?? "")
        .filter((c) => c);
      if (fixed.join("|") === p.cols.join("|")) return p;
      changed = true;
      return { ...p, cols: fixed };
    });
    if (changed) setPanels(next);
  }, [statsFiles, runFiles, filesReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Series of every panel column: Stats files per selected case as soon as the case's file list is
  // known (cases selected later are fetched when they appear), script outputs once per run file.
  // All answers of one pass arrive in one update; a failed request is noted and may be made again.
  useEffect(() => {
    const done = asked.current.series;
    type Got = { k: string; rows: [string, { t: number[]; v: (number | null)[] }][]; key: string; err?: string };
    const jobs: Promise<Got>[] = [];
    for (const p of panels) for (const col of p.cols) {
      const k = dataKey(p, col);
      if (p.src === "stats") {
        for (const c of cases) {
          const key = `${k}\n${c.id}`;
          if (!caseFiles[c.id] || done.has(key)) continue;
          done.add(key);
          const file = statsFileFor(c.id, p.file, col);
          if (file) jobs.push(api.series(c.path, file, [col]).then((s): Got => ({ k, key, rows: [[c.id, { t: s.t, v: s.columns[col] }]] }),
            (e: Error): Got => ({ k, key, rows: [], err: `${c.id}: ${e.message}` })));
        }
      } else if (!done.has(k)) {
        done.add(k);
        jobs.push(api.runSeries(project.id, p.src.slice(4), p.file, [col]).then(
          (res): Got => ({ k, key: k, rows: Object.entries(res).filter(([, s]) => s.columns[col]).map(([id, s]) => [id, { t: s.t, v: s.columns[col] }]) }),
          (e: Error): Got => ({ k, key: k, rows: [], err: `${p.file}: ${e.message}` })));
      }
    }
    if (!jobs.length) return;
    Promise.all(jobs).then((parts) => {
      setCache((m) => {
        const next = { ...m };
        for (const { k, rows } of parts) if (rows.length) next[k] = { ...next[k], ...Object.fromEntries(rows) };
        return next;
      });
      const bad = parts.filter((p) => p.err);
      bad.forEach((p) => done.delete(p.key));
      setErrors((m) => ({ ...dropKeys(m, (key) => parts.some((p) => key === `series|${p.key}`)),
                          ...Object.fromEntries(bad.map((p) => [`series|${p.key}`, p.err!])) }));
    });
  }, [panels, caseFiles, caseKey, again]); // eslint-disable-line react-hooks/exhaustive-deps

  // the failures that still concern what is shown: selected cases and the columns of the panels
  const liveKeys = new Set(panels.flatMap((p) => p.cols.map((col) => dataKey(p, col))));
  const error = [...new Set(Object.entries(errors).filter(([key]) => {
    const [kind, rest] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
    if (key === "runs") return true;
    if (kind === "files") return selIds.has(rest);
    const [k, id] = rest.split("\n");
    return liveKeys.has(k) && (!id || selIds.has(id));
  }).map(([, msg]) => msg))].join("\n");

  const update = (key: number, patch: Partial<Panel>) =>
    setPanels((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const move = (i: number, d: number) => setPanels((ps) => {
    const q = [...ps];
    [q[i], q[i + d]] = [q[i + d], q[i]];
    return q;
  });
  const addPanel = () => setPanels((ps) => [...ps, { ...(ps[ps.length - 1] ?? DEFAULT_PANEL),
    key: Math.max(0, ...ps.map((p) => p.key)) + 1 }]);

  const n = panels.length;
  const yName = (i: number) => (i ? `y${i + 1}` : "y");
  // The figure is rebuilt only when its inputs change: renders for other state of this view (the
  // statistics requests below, file lists) must not make Plot redraw every trace.
  const { traces, layout } = useMemo(() => {
  const colorOf = (id: string) => caseColor(style, id, caseIndex(project, id));
  const gap = n > 1 ? 0.06 / Math.max(1, n - 1) + 0.02 : 0;
  const traces: Plotly.Data[] = [];
  const layout: Record<string, unknown> = {};
  const seen = new Set<string>();
  panels.forEach((p, i) => {
    const top = 1 - i / n, bottom = 1 - (i + 1) / n;
    const rel = p.rel ?? "none";
    const pre = rel === "diff" ? "\u0394 " : rel === "pct" ? "% vs ref: " : "";
    layout[i ? `yaxis${i + 1}` : "yaxis"] = {
      domain: [bottom + (i < n - 1 ? gap / 2 : 0), top - (i ? gap / 2 : 0)],
      type: p.logY && rel === "none" ? "log" : "linear",
      title: { text: p.cols.length === 1 ? pre + p.cols[0]
        : p.cols.map((c, j) => `${pre}${c} (${DASHES[j % DASHES.length]})`).join("<br>"), font: { size: 11 } },
    };
    p.cols.forEach((col, j) => {
      const d = cache[dataKey(p, col)] ?? {};
      const r = d[refCase];
      const rs = r && rel !== "none" ? movingAvg(r.t, r.v, p.win) : null;
      if (rel !== "none" && !rs) return;
      cases.filter((c) => d[c.id] && !hidden.includes(c.id)).forEach((c) => {
        let y = movingAvg(d[c.id].t, d[c.id].v, p.win);
        if (rs) y = y.map((v, k) => {
          const b = interpAt(r!.t, rs, d[c.id].t[k]);
          return v === null || b === null ? null : rel === "diff" ? v - b : pctDiff(v, b);
        });
        traces.push({
          type: "scattergl", mode: "lines", name: caseName(project, c.id), legendgroup: c.id,
          showlegend: !seen.has(c.id), yaxis: yName(i),
          x: d[c.id].t, y,
          hovertemplate: `${caseName(project, c.id)}<br>${pre}${col}: %{y:.5g}<br>t = %{x:.4g} s<extra></extra>`,
          line: { width: c.id === refCase ? style.lineWidth * 1.9 : style.lineWidth, color: colorOf(c.id),
                  dash: DASHES[j % DASHES.length] },
        });
        seen.add(c.id);
      });
    });
  });
  return { traces, layout };
  }, [panels, cache, hidden, refCase, style, project]); // eslint-disable-line react-hooks/exhaustive-deps
  const plotLayout = useMemo(() => ({
    ...layout, xaxis: { title: { text: "Time [s]" }, anchor: yName(n - 1) as Plotly.AxisName },
    shapes: (tss === "" ? [] : [{ type: "line", x0: tss, x1: tss, yref: "paper", y0: 0, y1: 1, line: { dash: "dash", color: "green" } }]) as Partial<Plotly.Shape>[],
    legend: { orientation: "h" as const, y: 1.0, yanchor: "bottom" as const }, margin: { t: 50, r: 20, b: 50, l: 80 },
  }), [layout, n, tss]); // eslint-disable-line react-hooks/exhaustive-deps

  // Steady-state statistics come from the server, computed on every sample of the full series (the
  // plotted series only hold the min and max of each time bucket above 4000 rows). Without a steady
  // start they are only requested to tell whether a moving average runs on decimated points.
  const tssQ = useDebounced(tss);
  const anyAvg = panels.some((p) => p.win > 0);
  const [steady, setSteady] = useState<{ tss: number | ""; rows: Map<string, SeriesStat> } | null>(null);
  const [steadyBusy, setSteadyBusy] = useState(false);
  const [steadyError, setSteadyError] = useState<string | null>(null);
  const shownIds = shownCases.map((c) => c.id);
  const needFiles = panels.some((p) => p.src === "stats") && !filesReady;
  useEffect(() => {
    setSteadyError(null);
    if ((tssQ === "" && !anyAvg) || !shownIds.length) { setSteady(null); setSteadyBusy(false); return; }
    setSteadyBusy(true);
    if (needFiles) return;
    let live = true;
    const from = tssQ === "" ? undefined : tssQ;
    // one request per case and Stats file, or per run file: the columns of all panels using it together
    type Load = (cols: string[]) => Promise<Record<string, Record<string, SeriesStat>>>;
    const groups = new Map<string, { load: Load; keys: Map<string, Set<string>> }>();
    const want = (g: string, col: string, k: string, load: Load) => {
      const e = groups.get(g) ?? { load, keys: new Map<string, Set<string>>() };
      e.keys.set(col, (e.keys.get(col) ?? new Set<string>()).add(k));
      groups.set(g, e);
    };
    for (const p of panels) for (const col of p.cols) {
      const k = dataKey(p, col);
      if (p.src !== "stats") want(`${p.src}|${p.file}`, col, k, (cols) => api.runSeriesStats(project.id, p.src.slice(4), p.file, cols, shownIds, from));
      else for (const c of shownCases) {
        const file = statsFileFor(c.id, p.file, col);
        if (file) want(`stats|${c.id}|${file}`, col, k, (cols) => api.seriesStats(c.path, file, cols, from).then((r) => ({ [c.id]: r.stats })));
      }
    }
    Promise.all([...groups.values()].map((g) => g.load([...g.keys.keys()])
      .then((res) => Object.entries(res).flatMap(([id, cs]) => Object.entries(cs).flatMap(([col, s]) =>
        [...(g.keys.get(col) ?? [])].map((k) => [statKey(k, id), s] as [string, SeriesStat]))))
      .catch((e) => { if (live) setSteadyError(`statistics: ${e.message}`); return [] as [string, SeriesStat][]; })))
      .then((parts) => { if (live) { setSteady({ tss: tssQ, rows: new Map(parts.flat()) }); setSteadyBusy(false); } });
    return () => { live = false; };
  }, [tssQ, anyAvg, needFiles, shownIds.join("|"), JSON.stringify(panels.map((p) => [p.src, p.file, p.cols]))]); // eslint-disable-line react-hooks/exhaustive-deps

  // table rows: selected cases that are not hidden; numbers of another steady start are shown greyed
  const steadyRows = tss === "" || !steady || steady.tss === "" ? [] : panels.flatMap((p) => p.cols.flatMap((col) =>
    shownCases.flatMap((c) => {
      const k = dataKey(p, col), s = steady.rows.get(statKey(k, c.id));
      return s ? [{ key: `${p.key}|${col}|${c.id}`, k, file: p.file, col, id: c.id, s }] : [];
    })));
  const steadyStale = steadyBusy || steady?.tss !== tss;
  const steadyWait = steadyStale && !steadyError && shownIds.length > 0;
  const refMean = (k: string) => steady?.rows.get(statKey(k, refCase))?.mean;
  const cov = (s: SeriesStat) => (s.std !== null && s.mean ? s.std / Math.abs(s.mean) : null);
  // a moving average runs over the plotted points: say so when the server counted more samples than were plotted
  const avgDecimated = useMemo(() => !!steady && panels.some((p) => p.win > 0 && p.cols.some((col) => {
    const k = dataKey(p, col);
    return Object.entries(cache[k] ?? {}).some(([id, d]) => {
      const s = steady.rows.get(statKey(k, id));
      if (!s) return false;
      let got = 0;
      for (let i = 0; i < d.t.length; i++) if (d.v[i] !== null && (steady.tss === "" || d.t[i] >= steady.tss)) got++;
      return s.n > got;
    });
  })), [steady, cache, panels]);

  const selected = new Set(cases.map((c) => c.id));
  const exportCsv = () => download("time_series.csv",
    toCsv(["case", "file", "column", "time_s", "value"], panels.flatMap((p) => p.cols.flatMap((col) =>
      Object.entries(cache[dataKey(p, col)] ?? {}).filter(([id]) => selected.has(id)).flatMap(([id, s]) =>
        s.t.map((t, i) => [id, p.file, col, t, s.v[i]]))))));
  const exportSteady = () => download("time_series_steady.csv", toCsv(
    ["variable", "file", "case", "from [s]", "mean", "std", "CoV", `% vs ${caseName(project, refCase)}`, "n"],
    steadyRows.map((r) => [r.col, r.file, r.id, steady?.tss ?? "", r.s.mean, r.s.std, cov(r.s), pctDiff(r.s.mean, refMean(r.k)), r.s.n])));

  return (
    <>
      <details className="card">
        <summary className="small">Cases shown: {shownCases.length} of {cases.length} selected
          {shownCases.length === 1 && <> ({caseName(project, shownCases[0].id)})</>}</summary>
        <div className="row small">
          <button onClick={() => setHidden([])}>all</button>
          <button onClick={() => setHidden(cases.map((c) => c.id))}>none</button>
          <span className="muted">tick one case to see its time series alone</span>
        </div>
        <div className="checklist">
          {cases.map((c) => (
            <label key={c.id} className="small" title={c.id}><input type="checkbox" checked={!hidden.includes(c.id)}
              onChange={(e) => setHidden(e.target.checked ? hidden.filter((x) => x !== c.id) : [...hidden, c.id])} />
              {caseName(project, c.id)}</label>))}
        </div>
      </details>
      <div className="panels">
        {panels.map((p, i) => {
          const files = filesOf(p.src);
          const columns = files.find((f) => f.file === p.file)?.columns ?? [];
          return (
            <div key={p.key} className="row panel-row">
              <b>{i + 1}</b>
              <label>Source <select value={p.src === "stats" ? "stats" : "jobs"} onChange={(e) => {
                const r = runs.find((x) => runFilesSel(x.name).length);
                const src = e.target.value === "stats" ? "stats" : r ? `run:${r.name}` : null;
                if (!src) return;
                const f = filesOf(src)[0];
                update(p.key, { src, file: f?.file ?? "", cols: f ? [f.columns[0]] : [] });
              }}>
                <option value="stats">M-Star Stats</option>
                <option value="jobs" disabled={!runs.some((r) => runFilesSel(r.name).length)}>App script outputs</option>
              </select></label>
              {p.src === "stats" ? (
                <label>File <select value={p.file} onChange={(e) => {
                  const f = files.find((x) => x.file === e.target.value);
                  update(p.key, { file: e.target.value, cols: f ? [f.columns[0]] : [] });
                }}>
                  {!files.some((f) => f.file === p.file) && <option value={p.file}>{p.file || "-"}</option>}
                  {files.map((f) => <option key={f.file}>{f.file}</option>)}
                </select></label>
              ) : (
                <label>File <select value={`${p.src.slice(4)}|${p.file}`} onChange={(e) => {
                  const k = e.target.value.indexOf("|");
                  const src = `run:${e.target.value.slice(0, k)}`, file = e.target.value.slice(k + 1);
                  const f = filesOf(src).find((x) => x.file === file);
                  update(p.key, { src, file, cols: f ? [f.columns[0]] : [] });
                }}>
                  {!files.some((f) => f.file === p.file) && <option value={`${p.src.slice(4)}|${p.file}`}>{p.file || "-"}</option>}
                  {runs.filter((r) => runFilesSel(r.name).length).map((r) => (
                    <optgroup key={r.name} label={`${r.label ?? r.name} (${r.name.slice(0, 15)})`}>
                      {runFilesSel(r.name).map((f) => <option key={f.file} value={`${r.name}|${f.file}`}>{f.file}</option>)}
                    </optgroup>))}
                </select></label>
              )}
              <span className="chips">
                {p.cols.map((c) => (
                  <span key={c} className="chip">{c}
                    <button title="remove" onClick={() => update(p.key, { cols: p.cols.filter((x) => x !== c) })}>&times;</button>
                  </span>))}
              </span>
              <select value="" onChange={(e) => e.target.value && update(p.key, { cols: [...p.cols, e.target.value] })}>
                <option value="">+ variable</option>
                {columns.filter((c) => !p.cols.includes(c)).map((c) => <option key={c}>{c}</option>)}
              </select>
              <label>Avg [s] <input type="number" step="any" className="short" value={p.win || ""} placeholder="off"
                                    onChange={(e) => update(p.key, { win: Number(e.target.value) })} /></label>
              <label><input type="checkbox" checked={p.logY} onChange={(e) => update(p.key, { logY: e.target.checked })} /> log y</label>
              <label title={`plot each case relative to the reference case (interpolated onto the case's times).\n${PCT_HELP}`}>vs ref <select
                value={p.rel ?? "none"} onChange={(e) => update(p.key, { rel: e.target.value as Panel["rel"] })}>
                <option value="none">values</option><option value="diff">difference</option><option value="pct">% difference</option>
              </select></label>
              <button disabled={i === 0} onClick={() => move(i, -1)} title="move up">&uarr;</button>
              <button disabled={i === n - 1} onClick={() => move(i, 1)} title="move down">&darr;</button>
              <button disabled={n === 1} onClick={() => setPanels(panels.filter((x) => x.key !== p.key))} title="remove panel">&times;</button>
            </div>
          );
        })}
      </div>
      <div className="row">
        <button onClick={addPanel}>+ Add panel</button>
        <label>Steady from [s] <input type="number" step="any" value={tss}
                                      onChange={(e) => setTss(e.target.value === "" ? "" : Number(e.target.value))} /></label>
        <button onClick={exportCsv}>Export CSV</button>
        {!runs.some((r) => runFilesSel(r.name).length) && <span className="muted">No app script outputs for the selected cases yet: run an add-on (Liquid-liquid dispersion, Heat transfer UA) to plot its time series.</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {panels.some((p) => (p.rel ?? "none") !== "none") && !cases.some((c) => c.id === refCase) &&
        <div className="error">The reference case is not among the selected cases; relative panels are empty.</div>}
      <Plot data={traces} exportName="time_series" style={style} height={Math.round(Math.max(360, 250 * n + 90) * style.heightScale)} layout={plotLayout} />
      {avgDecimated && <div className="small muted">Moving average: computed on the plotted points (long series are drawn with the min and max
        of each time bucket), not on every sample{tss !== "" && "; the statistics below use every sample"}.</div>}
      {tss !== "" && (
        <>
          <div className="row small">
            <span className="muted">Statistics from every sample of the full series, computed by the server{steadyWait ? " (updating...)" : ""}.</span>
            <button disabled={steadyStale || !steadyRows.length} onClick={exportSteady}>Export statistics CSV</button>
          </div>
          {steadyError && <div className="error">{steadyError}</div>}
          <table className="grid narrow">
            <thead><tr><th>variable</th><th>case</th><th>mean (t &ge; {steady && steady.tss !== "" ? steady.tss : tss} s)</th><th>std</th><th>CoV</th><th title={PCT_HELP}>% vs ref</th><th>n</th></tr></thead>
            <tbody style={steadyStale ? { opacity: 0.45 } : undefined}>
              {steadyRows.map((r) => (
                <tr key={r.key} className={r.id === refCase ? "refrow" : ""}><td>{r.col}</td><td className="mono" title={r.id}>{caseName(project, r.id)}</td><td className="num">{fmt(r.s.mean)}</td>
                  <td className="num">{fmt(r.s.std)}</td><td className="num">{fmt(cov(r.s))}</td>
                  <td className="num">{fmt(pctDiff(r.s.mean, refMean(r.k)))}</td>
                  <td className="num">{r.s.n}</td></tr>))}
              {!steadyRows.length && <tr><td colSpan={7} className="muted">{steadyWait ? "..." : "no statistics for the shown cases"}</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

type Merged = { columns: string[]; rows: CsvTable["rows"]; origin: string[] };

// one row per case (column 0); a case in several sources takes the first source's values per column
function mergeTables(tables: { label: string; t: CsvTable }[]): Merged {
  const columns = ["case"];
  const rows = new Map<string, Map<string, string | number | null>>();
  const origin = new Map<string, string[]>();
  for (const { label, t } of tables) {
    t.columns.slice(1).forEach((c) => { if (!columns.includes(c)) columns.push(c); });
    for (const r of t.rows) {
      const cs = String(r[0]);
      if (!rows.has(cs)) { rows.set(cs, new Map()); origin.set(cs, []); }
      const m = rows.get(cs)!;
      t.columns.forEach((c, i) => { if (i > 0 && !m.has(c) && r[i] !== null && r[i] !== "") m.set(c, r[i]); });
      if (!origin.get(cs)!.includes(label)) origin.get(cs)!.push(label);
    }
  }
  const cases = [...rows.keys()];
  return {
    columns,
    rows: cases.map((cs) => [cs, ...columns.slice(1).map((c) => rows.get(cs)!.get(c) ?? null)]),
    origin: cases.map((cs) => origin.get(cs)!.join(", ")),
  };
}

function MeansPlots({ project, view, style, active, refCase }: {
  project: Project; view: "bars" | "scatter" | "detail"; style: PlotStyle; active: boolean; refCase: string;
}) {
  const scatter = view === "scatter";
  const store = `mstar_post.means.${project.id}`;
  const saved = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(store) ?? "{}"); } catch { return {}; }
  }, [store]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [tasks, setTasks] = useState<TaskDef[]>([]);
  // sources: "files" = chosen *_means/_settings CSVs; "task" = all finished runs of one job type merged (newest run per case)
  const [srcMode, setSrcMode] = useState<"task" | "files">(saved.srcMode ?? "task");
  const [taskId, setTaskId] = useState<string>(saved.taskId ?? "");
  const [srcs, setSrcs] = useState<string[]>(saved.srcs ?? []);  // "<run path>/<csv>"
  const [excluded, setExcluded] = useState<string[]>(saved.excluded ?? []);
  const [pctMode, setPctMode] = useState<"value" | "both" | "pct">(saved.pctMode ?? "value");
  const [heat, setHeat] = useState<boolean>(saved.heat ?? false);
  const [focus, setFocus] = useState<string>(saved.focus ?? "");
  const [merged, setMerged] = useState<Merged | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [colFilter, setColFilter] = useState("");
  const [xCol, setXCol] = useState("");
  const [yCol, setYCol] = useState("");
  const [fit, setFit] = useState(true);
  const [logAxes, setLogAxes] = useState(false);
  const [nPlots, setNPlots] = useState(MAX_BAR_PLOTS);  // bar charts drawn: "select shown" can pick hundreds of variables

  useEffect(() => {
    api.tasks().then(setTasks).catch(() => undefined);
  }, []);
  // the run list: on the first show (which also picks the default job type and source) and whenever
  // the mode or tab is shown again
  const gotRuns = useRef(false);
  useEffect(() => {
    if (!active && gotRuns.current) return;
    const first = !gotRuns.current;
    gotRuns.current = true;
    api.runs(project.id).then((rs) => {
      setRuns((old) => (sameRuns(old, rs) ? old : rs));
      if (!first) return;
      if (!taskId || !rs.some((r) => r.task === taskId)) {
        const t = newestFirst(rs).find((r) => r.status === "done" && (r.csvs.some((c) => c.endsWith("_means.csv")) || r.task === "calc_ua")) ?? rs[0];
        if (t?.task) setTaskId(t.task);
      }
      const all = new Set(rs.flatMap((r) => r.csvs.map((c) => `${r.path}/${c}`)));
      const kept = srcs.filter((s) => all.has(s));
      if (kept.length) { if (kept.length !== srcs.length) setSrcs(kept); return; }
      const r = rs.find((x) => x.csvs.some((c) => c.endsWith("_means.csv")));
      setSrcs(r ? [`${r.path}/${r.csvs.find((c) => c === "batch_summary_means.csv") ?? r.csvs.find((c) => c.endsWith("_means.csv"))}`] : []);
    }).catch((e) => setLoadError(`run list: ${e.message}`));
  }, [project.id, active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem(store, JSON.stringify({ srcs, excluded, pctMode, heat, focus, srcMode, taskId }));
  }, [store, srcs, excluded, pctMode, heat, focus, srcMode, taskId]);

  const selIds = selectedCaseIds(project);
  const visRuns = runs.filter((r) => runHasCases(r, selIds));
  const selKey = [...selIds].join("|");
  const byTask = visRuns.reduce((m, r) => m.set(r.task ?? "", [...(m.get(r.task ?? "") ?? []), r]), new Map<string, Run[]>());
  const taskLabel = (id: string) => tasks.find((t) => t.id === id)?.label ?? (id || "unknown job type");
  // finished runs of the job type, newest results first (a run made again counts with its new time)
  const taskRuns = newestFirst((byTask.get(taskId) ?? []).filter((r) => r.status === "done" || r.status === "unknown"));

  const options = visRuns.flatMap((r) => r.csvs.filter((c) => c.endsWith("_means.csv") || c.endsWith("_settings.csv"))
    .map((c) => ({ value: `${r.path}/${c}`, label: `${r.label ?? r.name} (${r.name.slice(0, 15)}): ${c}` })));

  useEffect(() => {
    setLoadError(null);
    // a table arrived: keep the chosen variables that exist in it, else start with the first four
    const show = (t: Merged) => {
      setMerged(t);
      const num = new Set(t.columns.slice(1));
      setSel((s) => (s.some((c) => num.has(c)) ? s.filter((c) => num.has(c)) : t.columns.slice(1, 5)));
    };
    const fail = (e: Error) => { setMerged(null); setLoadError(e.message); };
    if (srcMode === "task") {
      if (!taskRuns.length) { setMerged(null); return; }
      let stale = false;
      // newest run first: a case keeps the first run that has it, like the Results comparison
      Promise.all(taskRuns.map((r) => loadRunResults(project, r).then((res) => ({ r, res })))).then((all) => {
        if (stale) return;
        const columns = ["case"], seen = new Set<string>();
        const rows = new Map<string, Record<string, Cell>>();
        const origin = new Map<string, string>();
        for (const { r, res } of all) {
          res.columns.forEach((c) => { if (!seen.has(c.col)) { seen.add(c.col); columns.push(c.col); } });
          for (const [cid, row] of res.rows) if (!rows.has(cid)) { rows.set(cid, row); origin.set(cid, r.label ?? r.name); }
        }
        const cs = [...rows.keys()];
        show({ columns, rows: cs.map((c) => [c, ...columns.slice(1).map((k) => rows.get(c)![k] ?? null)]),
               origin: cs.map((c) => origin.get(c)!) });
      }).catch((e) => !stale && fail(e));
      return () => { stale = true; };
    }
    // keep the dropdown order so precedence does not depend on click order
    const ordered = options.map((o) => o.value).filter((v) => srcs.includes(v));
    if (!ordered.length) { setMerged(null); return; }  // nothing chosen (or its run is hidden): no table, not the last one
    let stale = false;
    Promise.all(ordered.map((s) => api.csv(project.id, s).then((t) => ({
      label: options.find((o) => o.value === s)!.label, t }))))
      .then((tables) => { if (!stale) show(mergeTables(tables)); })
      .catch((e) => !stale && fail(e));
    return () => { stale = true; };
  }, [srcMode, taskId, srcs.join("|"), runs, selKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // What is shown of the merged table, built once per table and case choice: cases not selected on
  // the Cases tab are left out (none selected = all); cases unknown to the project (e.g. renamed) stay.
  const caseIds = project.cases.map((c) => c.id).join("|");
  const tbl = useMemo(() => {
    if (!merged) return null;
    const known = new Set(project.cases.map((c) => c.id));
    const ids = merged.rows.map((r) => String(r[0]));
    const origin = new Map(ids.map((id, i) => [id, merged.origin[i]]));
    const allCases = ids.filter((c) => selIds.has(c) || !known.has(c));
    const off = new Set(excluded), keep = new Set(allCases.filter((c) => !off.has(c)));
    const rows = merged.rows.filter((r) => keep.has(String(r[0])));
    // column -> values of the shown cases; the reference row comes from all merged cases, so an excluded reference still works
    const cols = new Map(merged.columns.slice(1).map((c, j) => [c, rows.map((r) => r[j + 1])]));
    const refRow = merged.rows.find((r) => String(r[0]) === refCase);
    return { allCases, cases: rows.map((r) => String(r[0])), cols, origin, hasRef: !!refRow, nHidden: ids.length - allCases.length,
             numeric: merged.columns.slice(1).filter((c) => cols.get(c)!.some((v) => typeof v === "number")),
             refVals: new Map(merged.columns.slice(1).map((c, j) => [c, refRow?.[j + 1]])) };
  }, [merged, excluded, selKey, caseIds, refCase]); // eslint-disable-line react-hooks/exhaustive-deps
  const allCases = tbl?.allCases ?? [], cases = tbl?.cases ?? [], numeric = tbl?.numeric ?? [];
  const nHidden = tbl?.nHidden ?? 0;
  const none: Cell[] = useMemo(() => [], []);
  const colVals = (c: string): Cell[] => tbl?.cols.get(c) ?? none;
  const refVal = (c: string) => tbl?.refVals.get(c);
  const aliases = JSON.stringify(project.aliases ?? {});
  const names = useMemo(() => cases.map((c) => caseName(project, c)), [tbl, aliases]); // eslint-disable-line react-hooks/exhaustive-deps
  const colors = useMemo(() => cases.map((id) => caseColor(style, id, caseIndex(project, id))), [tbl, style, caseIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const refName = caseName(project, refCase);
  // x and y of the trend: the saved choice if it is a numeric column, else a sensible numeric default
  // (the first column of a table can be text, e.g. the variable name of the zoner summary)
  const xEff = numeric.includes(xCol) ? xCol : numeric.find((c) => /speed|rpm/i.test(c)) ?? numeric[0] ?? "";
  const yEff = numeric.includes(yCol) ? yCol : numeric.find((c) => c !== xEff && /power number|^UA/i.test(c)) ?? numeric.find((c) => c !== xEff) ?? "";
  const shownVars = numeric.filter((c) => c.toLowerCase().includes(colFilter.toLowerCase()));
  const selSet = new Set(sel);
  const varList = (
    <>
      <input placeholder="filter variables" value={colFilter} onChange={(e) => setColFilter(e.target.value)} />
      <div className="row small">
        <button onClick={() => setSel([...new Set([...sel, ...shownVars])])}>select shown</button>
        <button onClick={() => { const gone = new Set(shownVars); setSel(sel.filter((c) => !gone.has(c))); }}>clear shown</button>
      </div>
      <div className="checklist">
        {shownVars.map((c) => (
          <label key={c} className="small"><input type="checkbox" checked={selSet.has(c)}
            onChange={(e) => setSel(e.target.checked ? [...sel, c] : sel.filter((x) => x !== c))} />{c}</label>
        ))}
      </div>
    </>
  );
  // the % difference heatmap of the chosen variables
  const heatFig = useMemo(() => {
    if (!heat || !sel.length || !tbl) return null;
    const p = sel.map((s) => (tbl.cols.get(s) ?? []).map((v) => pctDiff(v, tbl.refVals.get(s))));
    return {
      data: [{ type: "heatmap", x: names, y: sel, zmid: 0, colorscale: "RdBu", reversescale: true, z: p,
               text: p.map((row) => row.map((v) => (v === null ? "" : `${v.toFixed(1)}%`))),
               texttemplate: "%{text}", hovertemplate: "%{y}<br>%{x}: %{z:.3g}%<extra></extra>",
               colorbar: { title: { text: `% vs ${refName}` } } } as unknown as Plotly.Data],
      layout: { title: { text: `% difference vs ${refName}` }, margin: { l: 20, b: 110 } } as Partial<Plotly.Layout>,
    };
  }, [heat, sel, tbl, names, refName]);

  return (
    <>
      <div className="row">
        {!runs.length && <span className="muted">Run a calculation first (e.g. "M-Star Stats summary").</span>}
      </div>
      {runs.length > 0 && (
        <div className="split">
          <div className="side">
            <div className="row small">
              <b>Sources</b>
              <span className="seg">
                <button className={srcMode === "task" ? "primary" : ""} onClick={() => setSrcMode("task")}
                        title="all finished runs of one job type merged: each case from the newest run that includes it">by job type</button>
                <button className={srcMode === "files" ? "primary" : ""} onClick={() => setSrcMode("files")}
                        title="pick individual result tables">files</button>
              </span>
            </div>
            {srcMode === "task" ? (
              <>
                <div className="checklist">
                  {[...byTask.entries()].map(([tid, rs]) => (
                    <label key={tid} className="small"><input type="radio" checked={taskId === tid} onChange={() => setTaskId(tid)} />
                      <b>{taskLabel(tid)}</b> <span className="muted">{rs.length} run{rs.length === 1 ? "" : "s"}</span></label>))}
                </div>
                <span className="muted small">{taskRuns.length} finished run{taskRuns.length === 1 ? "" : "s"} merged; a case takes its values from the newest run that includes it (hover a case for the run).</span>
              </>
            ) : (
              <>
            <div className="checklist">
              {visRuns.map((r) => {
                const opts = options.filter((o) => o.value.startsWith(`${r.path}/`));
                if (!opts.length) return null;
                const n = opts.filter((o) => srcs.includes(o.value)).length;
                return (
                  <details key={r.name} className="srcgroup" open={n > 0}>
                    <summary className="small" title={r.name}>
                      <b>{r.label ?? r.name}</b> <span className="muted">{r.name.slice(0, 15)}{n ? ` (${n} selected)` : ""}</span>
                    </summary>
                    {opts.map((o) => (
                      <label key={o.value} className="small srcfile"><input type="checkbox" checked={srcs.includes(o.value)}
                        onChange={(e) => setSrcs(e.target.checked ? [...srcs, o.value] : srcs.filter((x) => x !== o.value))} />
                        {o.value.slice(r.path.length + 1)}</label>
                    ))}
                  </details>
                );
              })}
            </div>
            <span className="muted small">A case in several sources uses the first listed one.</span>
              </>
            )}
          </div>
          {tbl && (
            <div className="side">
              <b className="small">Cases ({cases.length}/{allCases.length})</b>{" "}
              <button onClick={() => setExcluded([])}>all</button>
              <button onClick={() => setExcluded(allCases)}>none</button>
              {nHidden > 0 && <span className="small muted"> {nHidden} not selected on the Cases tab</span>}
              <div className="checklist">
                {allCases.map((c) => (
                  <label key={c} className="small" title={`${c}\n${tbl.origin.get(c) ?? ""}`}><input type="checkbox" checked={!excluded.includes(c)}
                    onChange={(e) => setExcluded(e.target.checked ? excluded.filter((x) => x !== c) : [...excluded, c])} />{caseName(project, c)}</label>
                ))}
              </div>
            </div>
          )}
          {tbl && view === "bars" && (
            <div className="side grow">
              <b className="small">Variables ({sel.length}/{numeric.length})</b>
              {varList}
              <button onClick={() => download("means_selection.csv", toCsv(["case", ...sel, ...sel.map((s) => `% vs ${refName}: ${s}`)],
                cases.map((c, i) => [names[i], ...sel.map((s) => colVals(s)[i]), ...sel.map((s) => pctDiff(colVals(s)[i], refVal(s)))])))}>
                Export selection CSV</button>
            </div>
          )}
        </div>
      )}
      {loadError && <div className="error">{loadError}</div>}
      {tbl && view === "bars" && (
        <div>
            <div className="row small">
              <label title={PCT_HELP}>Show <select value={pctMode} onChange={(e) => setPctMode(e.target.value as typeof pctMode)}>
                <option value="value">values</option><option value="both">values + % vs ref</option>
                <option value="pct">% vs ref only</option></select></label>
              <label title={PCT_HELP}><input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} /> % difference heatmap</label>
              <span className="muted">reference: <b>{refName}</b>{!tbl.hasRef && " (not in the selected sources: no % values)"}</span>
            </div>
            {heatFig && <Plot exportName="pct_diff_heatmap" style={style} height={Math.round(Math.max(260, 34 * sel.length + 170) * style.heightScale)}
                              data={heatFig.data} layout={heatFig.layout} />}
            <div className="plotgrid">
              {sel.slice(0, nPlots).map((c) => (
                <MeanBars key={c} col={c} names={names} ys={colVals(c)} refV={refVal(c)} colors={style.barsByCase ? colors : null}
                          refIdx={cases.indexOf(refCase)} pctMode={pctMode} refName={refName} style={style} />))}
            </div>
            {sel.length > nPlots && (
              <div className="row small">
                <span className="muted">{nPlots} of {sel.length} chosen variables are drawn (the tables below hold all of them).</span>
                <button onClick={() => setNPlots(nPlots + MAX_BAR_PLOTS)}>Draw {Math.min(MAX_BAR_PLOTS, sel.length - nPlots)} more</button>
                <button onClick={() => setNPlots(sel.length)}>Draw all {sel.length}</button>
              </div>)}
            {sel.length > 0 && <MeansTable project={project} cases={cases} sel={sel} colVals={colVals} refVal={refVal}
                                           refCase={refCase} refName={refName} origin={(c) => tbl.origin.get(c) ?? ""} />}
        </div>
      )}
      {merged && tbl && view === "detail" && (
        <CaseDetail project={project} merged={merged} cases={cases} allCases={allCases} numeric={numeric} refCase={refCase} style={style}
                    focus={allCases.includes(focus) ? focus : allCases.find((c) => c !== refCase) ?? allCases[0] ?? ""} setFocus={setFocus} />
      )}
      {tbl && scatter && (
        <ScatterFit cases={cases} labels={cases.map((c) => project.aliases?.[c] ?? c.split("/").pop()!)}
                    colors={colors} style={style}
                    x={xEff} y={yEff} xs={colVals(xEff)} ys={colVals(yEff)}
                    numeric={numeric} setX={setXCol} setY={setYCol} fit={fit} setFit={setFit}
                    logAxes={logAxes} setLogAxes={setLogAxes} />
      )}
    </>
  );
}

// bar charts drawn at once in Compare means; more on request
const MAX_BAR_PLOTS = 24;

// One variable as bars per case (values, % vs ref or both). Memoised: it is drawn again only when
// its own inputs change, not when a filter is typed or another variable is ticked.
const MeanBars = memo(function MeanBars({ col, names, ys, refV, colors, refIdx, pctMode, refName, style }: {
  col: string; names: string[]; ys: Cell[]; refV: Cell | undefined; colors: string[] | null; refIdx: number;
  pctMode: "value" | "both" | "pct"; refName: string; style: PlotStyle;
}) {
  const fig = useMemo(() => {
    const y = ys.map((v) => (typeof v === "number" ? v : null));
    // offsetgroup: with the values on y and the % on y2 the two bars of a case stand side by side
    // (bars on different axes are not grouped by Plotly otherwise: they would cover each other)
    const valTrace = { type: "bar", x: names, y, name: "value", offsetgroup: "value", marker: {
      color: colors ?? style.barColor, line: { color: "#000", width: names.map((_, i) => (i === refIdx ? 2 : 0)) } } } as Plotly.Data;
    const pctTrace = { type: "bar", x: names, y: y.map((v) => pctDiff(v, refV)), name: `% vs ${refName}`, offsetgroup: "pct",
      yaxis: pctMode === "both" ? "y2" : "y", marker: { color: style.pctColor } } as Plotly.Data;
    return {
      data: pctMode === "value" ? [valTrace] : pctMode === "pct" ? [pctTrace] : [valTrace, pctTrace],
      layout: {
        title: { text: col, font: { size: 13 } }, barmode: "group",
        ...(pctMode === "pct" && { yaxis: { title: { text: `% vs ${refName}` } } }),
        ...(pctMode === "both" && { yaxis2: { overlaying: "y", side: "right", title: { text: "% vs ref" } } }),
        legend: { orientation: "h", y: 1.12 }, margin: { t: 60, b: 110, l: 70, r: 60 },
      } as Partial<Plotly.Layout>,
    };
  }, [col, names, ys, refV, colors, refIdx, pctMode, refName, style.barColor, style.pctColor]);
  return <Plot exportName={col} style={style} height={Math.round(340 * style.heightScale)} data={fig.data} layout={fig.layout} />;
});

// The plotted means as text: absolute values and % vs ref as two tables, cases as rows (or variables as rows).
function MeansTable({ project, cases, sel, colVals, refVal, refCase, refName, origin }: {
  project: Project; cases: string[]; sel: string[]; colVals: (c: string) => Cell[]; refVal: (c: string) => Cell | undefined;
  refCase: string; refName: string; origin: (c: string) => string;
}) {
  const [transpose, setTranspose] = useState(false);
  const num = (v: Cell | undefined) => (typeof v === "number" ? v : null);
  const val = (s: string, i: number) => num(colVals(s)[i]);
  const pctOf = (s: string, i: number) => pctDiff(val(s, i), refVal(s));
  const names = cases.map((c) => caseName(project, c));
  const build = (cell: (s: string, i: number) => number | null, withUnit: boolean) => transpose
    ? { header: ["variable", ...(withUnit ? ["unit"] : []), ...names],
        rows: sel.map((s) => [shortName(s), ...(withUnit ? [unitOf(s)] : []), ...cases.map((_, i) => cell(s, i))]) }
    : { header: ["case", ...(withUnit ? sel : sel.map(shortName))], rows: cases.map((_, i) => [names[i], ...sel.map((s) => cell(s, i))]) };
  const refIdx = cases.indexOf(refCase);
  return (
    <details className="card">
      <summary><b>Values tables</b> <span className="small muted">{sel.length} variable{sel.length === 1 ? "" : "s"} &times; {cases.length} case{cases.length === 1 ? "" : "s"}, reference {refName}</span></summary>
      <div className="row small">
        <label><input type="checkbox" checked={transpose} onChange={(e) => setTranspose(e.target.checked)} /> variables as rows</label>
      </div>
      <TextTable title="Absolute values" file="means_values.csv" {...build(val, true)} transpose={transpose}
                 refIdx={refIdx} labelOffset={transpose ? 2 : 1} tips={cases.map((c) => `${c}\n${origin(c)}`)} />
      <TextTable title={`% difference vs ${refName}`} file="means_pct_vs_ref.csv" {...build(pctOf, false)} transpose={transpose} help={PCT_HELP}
                 refIdx={refIdx} labelOffset={1} tips={cases.map((c) => `${c}\n${origin(c)}`)} />
    </details>
  );
}

function TextTable({ title, file, header, rows, transpose, refIdx, labelOffset, tips, help }: {
  title: string; file: string; header: string[]; rows: (string | number | null)[][]; transpose: boolean;
  refIdx: number; labelOffset: number; tips: string[]; help?: string;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => {
    const txt = [header, ...rows].map((r) => r.map((v) => (v === null ? "" : String(v))).join("\t")).join("\n");
    setCopied(await copyText(txt));
    setTimeout(() => setCopied(null), 1500);
  };
  const isRefCol = (j: number) => transpose && refIdx >= 0 && j - labelOffset === refIdx;  // no reference among the shown cases: no column is marked
  return (
    <>
      <div className="row small">
        <b className="grow" title={help}>{title}</b>
        <button onClick={copy} title="tab-separated, pastes into Excel">{copied === null ? "Copy table" : copied ? "Copied" : "Copy failed: use Export CSV"}</button>
        <button onClick={() => download(file, toCsv(header, rows))}>Export CSV</button>
      </div>
      <div className="tablewrap">
        <table className="grid">
          <thead><tr>{header.map((h, j) => <th key={j} className={isRefCol(j) ? "refrow" : ""}
            title={transpose && j >= labelOffset ? tips[j - labelOffset] : undefined}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i} className={!transpose && i === refIdx ? "refrow" : ""}>
              {r.map((v, j) => j < labelOffset
                ? <td key={j} className={j ? "small" : "mono"} title={!transpose && !j ? tips[i] : undefined}>{v}</td>
                : <td key={j} className={`num${isRefCol(j) ? " refrow" : ""}`}>{fmt(v)}</td>)}
            </tr>))}</tbody>
        </table>
      </div>
    </>
  );
}

// One case against the reference and the spread of the checked cases, per variable.
function CaseDetail({ project, merged, cases, allCases, numeric, refCase, style, focus, setFocus }: {
  project: Project; merged: Merged; cases: string[]; allCases: string[]; numeric: string[]; refCase: string; style: PlotStyle;
  focus: string; setFocus: (c: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [minPct, setMinPct] = useState<number | "">("");
  const [order, setOrder] = useState<"var" | "pct">("pct");
  const fName = caseName(project, focus), rName = caseName(project, refCase);
  // rows, the chart of the largest differences and its layout: built when their inputs change
  const { rows, hasFocus, hasRef, fig } = useMemo(() => {
    const row = (id: string) => merged.rows.find((r) => String(r[0]) === id);
    const fr = row(focus), rr = row(refCase);
    // rank, range, mean and z over the checked cases and the case itself (so a rank never exceeds n)
    const among = new Set(cases).add(focus);
    const shownRows = merged.rows.filter((r) => among.has(String(r[0])));
    const low = filter.toLowerCase();
    let rows = numeric.filter((c) => c.toLowerCase().includes(low)).map((c) => {
      const j = merged.columns.indexOf(c);
      const v = fr?.[j], r = rr?.[j];
      const vals = shownRows.map((x) => x[j]).filter((x): x is number => typeof x === "number");
      const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1));
      return {
        c, v: typeof v === "number" ? v : null, r: typeof r === "number" ? r : null, pct: pctDiff(v, r),
        rank: typeof v === "number" ? 1 + vals.filter((x) => x > v).length : null, n: vals.length,
        min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null, mean,
        z: typeof v === "number" && sd > 0 ? (v - mean) / sd : null,
      };
    }).filter((x) => minPct === "" || (x.pct !== null && Math.abs(x.pct) >= minPct));
    // largest |%| first; variables without a % (no reference value, reference 0, text) go last
    const size = (x: { pct: number | null }) => (x.pct === null ? -1 : Math.abs(x.pct));
    const bySize = [...rows].sort((a, b) => size(b) - size(a));
    if (order === "pct") rows = bySize;
    // the chart always shows the largest differences, whatever the order of the table
    const top = bySize.filter((x) => x.pct !== null).slice(0, 40);
    const nPct = rows.filter((x) => x.pct !== null).length;
    const fig = top.length ? {
      data: [{ type: "bar", orientation: "h", y: top.map((x) => x.c), x: top.map((x) => x.pct),
               marker: { color: top.map((x) => ((x.pct ?? 0) >= 0 ? "#c0504d" : "#4f81bd")) },
               hovertemplate: "%{y}: %{x:.3g}%<extra></extra>" }] as Plotly.Data[],
      layout: {
        title: { text: `${fName}: % difference vs ${rName}${nPct > top.length ? ` (largest ${top.length} of ${nPct})` : ""}` },
        yaxis: { autorange: "reversed", automargin: true }, xaxis: { title: { text: "% vs ref" }, zeroline: true },
        margin: { l: 20, t: 50 },
      } as Partial<Plotly.Layout>,
      height: Math.max(260, 22 * top.length + 120),
    } : null;
    return { rows, hasFocus: !!fr, hasRef: !!rr, fig };
  }, [merged, cases, numeric, focus, refCase, filter, minPct, order, fName, rName]);
  // the cases to choose from: the selected ones of the sources (not those deselected on the Cases tab)
  const choices = allCases.includes(focus) || !focus ? allCases : [focus, ...allCases];
  return (
    <div>
      <div className="row">
        <label>Case <select value={focus} onChange={(e) => setFocus(e.target.value)}>
          {choices.map((id) => <option key={id} value={id}>{caseName(project, id)}</option>)}
        </select></label>
        <span className="muted" title={PCT_HELP}>vs reference <b>{rName}</b>; rank, range, mean and z over the {cases.length} checked cases{cases.includes(focus) ? "" : " and this case"}</span>
      </div>
      <div className="row small">
        <input placeholder="filter variables" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label>only |% vs ref| &ge; <input type="number" className="short" value={minPct}
          onChange={(e) => setMinPct(e.target.value === "" ? "" : Number(e.target.value))} /></label>
        <label>Order <select value={order} onChange={(e) => setOrder(e.target.value as "var" | "pct")}>
          <option value="pct">largest |% vs ref| first</option><option value="var">variable</option></select></label>
        <button onClick={() => download(`case_detail_${fName}.csv`, toCsv(
          ["variable", fName, `${rName} (ref)`, "% vs ref", "rank", "n cases", "min", "max", "mean", "z"],
          rows.map((x) => [x.c, x.v, x.r, x.pct, x.rank, x.n, x.min, x.max, x.mean, x.z])))}>Export CSV</button>
      </div>
      {!hasFocus && <div className="error">The case is not in the selected sources.</div>}
      {!hasRef && <div className="muted">The reference case is not in the selected sources: no % values.</div>}
      {fig && <Plot exportName={`case_detail_${fName}`} style={style} height={Math.round(fig.height * style.heightScale)} data={fig.data} layout={fig.layout} />}
      <div className="tablewrap">
        <table className="grid">
          <thead><tr><th>variable</th><th>{fName}</th><th>{rName} (ref)</th><th title={PCT_HELP}>% vs ref</th><th>rank</th>
            <th>min</th><th>max</th><th>mean</th><th title="(value - mean) / std over the checked cases">z</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.c}><td>{x.c}</td><td className="num">{fmt(x.v)}</td><td className="num">{fmt(x.r)}</td>
              <td className="num" style={{ background: x.pct === null ? undefined
                : `rgba(${x.pct >= 0 ? "220,90,70" : "70,130,220"},${Math.min(1, Math.abs(x.pct) / 50) * 0.45})` }}>{fmt(x.pct)}</td>
              <td className="num">{x.rank === null ? "" : `${x.rank} / ${x.n}`}</td>
              <td className="num">{fmt(x.min)}</td><td className="num">{fmt(x.max)}</td><td className="num">{fmt(x.mean)}</td>
              <td className="num">{fmt(x.z)}</td></tr>))}</tbody>
        </table>
      </div>
    </div>
  );
}

function ScatterFit({ cases, labels, colors, style, x, y, xs, ys, numeric, setX, setY, fit, setFit, logAxes, setLogAxes }: {
  cases: string[]; labels: string[]; colors: string[]; style: PlotStyle;
  x: string; y: string; xs: unknown[]; ys: unknown[]; numeric: string[];
  setX: (s: string) => void; setY: (s: string) => void; fit: boolean; setFit: (b: boolean) => void;
  logAxes: boolean; setLogAxes: (b: boolean) => void;
}) {
  const pts = cases.map((c, i) => [labels[i], xs[i], ys[i], c, colors[i]] as const)
    .filter((p): p is readonly [string, number, number, string, string] => typeof p[1] === "number" && typeof p[2] === "number");
  // power law y = a x^b by least squares in log-log
  const pos = pts.filter((p) => p[1] > 0 && p[2] > 0);
  let law: { a: number; b: number; r2: number } | null = null;
  if (fit && pos.length >= 2) {
    const lx = pos.map((p) => Math.log(p[1])), ly = pos.map((p) => Math.log(p[2]));
    const mx = lx.reduce((s, v) => s + v, 0) / lx.length, my = ly.reduce((s, v) => s + v, 0) / ly.length;
    const sxx = lx.reduce((s, v) => s + (v - mx) ** 2, 0);
    if (sxx > 0) {
      const b = lx.reduce((s, v, i) => s + (v - mx) * (ly[i] - my), 0) / sxx;
      const a = Math.exp(my - b * mx);
      const ssr = ly.reduce((s, v, i) => s + (v - (my + b * (lx[i] - mx))) ** 2, 0);
      const sst = ly.reduce((s, v) => s + (v - my) ** 2, 0);
      law = { a, b, r2: sst > 0 ? 1 - ssr / sst : 1 };
    }
  }
  const xr = pos.map((p) => p[1]);
  const fx = law ? Array.from({ length: 50 }, (_, i) =>
    Math.min(...xr) * (Math.max(...xr) / Math.min(...xr)) ** (i / 49)) : [];
  // the figure is built when the points, the fit or the style change (not on every render of the mode)
  const fig = useMemo(() => ({
    data: [
      { type: "scatter", mode: "text+markers", x: pts.map((p) => p[1]), y: pts.map((p) => p[2]),
        text: pts.map((p) => p[0]), textposition: "top center",
        hovertext: pts.map((p) => p[3]), marker: { size: style.markerSize, color: pts.map((p) => p[4]) },
        textfont: { size: style.fontSize }, name: "cases" },
      ...(law ? [{ type: "scatter", mode: "lines", x: fx, y: fx.map((v) => law!.a * v ** law!.b), name: "fit", line: { dash: "dash" } }] : []),
    ] as Plotly.Data[],
    layout: {
      xaxis: { title: { text: x }, type: logAxes ? "log" : "linear" },
      yaxis: { title: { text: y }, type: logAxes ? "log" : "linear" },
    } as Partial<Plotly.Layout>,
  }), [cases, labels.join("\n"), colors, xs, ys, x, y, fit, logAxes, style.markerSize, style.fontSize]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="row">
        <label>x <select value={x} onChange={(e) => setX(e.target.value)}>{numeric.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label>y <select value={y} onChange={(e) => setY(e.target.value)}>{numeric.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label><input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} /> power-law fit</label>
        <label><input type="checkbox" checked={logAxes} onChange={(e) => setLogAxes(e.target.checked)} /> log axes</label>
        {law && <span className="mono">y = {fmt(law.a)} x^{fmt(law.b, 3)} (R&sup2; = {fmt(law.r2, 3)})</span>}
      </div>
      <Plot exportName={`${y}_vs_${x}`} style={style} height={Math.round(520 * style.heightScale)} data={fig.data} layout={fig.layout} />
    </>
  );
}
