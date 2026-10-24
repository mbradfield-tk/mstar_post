import { useEffect, useMemo, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, caseName, download, fmt, toCsv, type CsvTable, type Project, type Run, type RunSeriesFile,
         type StatsFile } from "./api";
import CaseNames from "./CaseNames";
import { useDialog } from "./Dialog";
import Plot from "./Plot";
import { caseColor, PlotStyleEditor, usePlotStyle, type PlotStyle } from "./PlotStyle";
import StatsSeries from "./StatsSeries";

type Mode = "series" | "single" | "bars" | "scatter" | "detail";
const MODE_LABEL: Record<Mode, string> = { series: "Time series", single: "Case time series",
  bars: "Compare means", scatter: "Trend (x-y)", detail: "Case detail" };
const MODE_HELP: Record<Mode, string> = {
  series: "M-Star Stats variables (or run metrics) over time for several cases in stacked panels",
  single: "one case: pick a Stats file or a job's time-series CSV (e.g. ua.csv) and its variables to plot over time",
  bars: "steady-state means per case as bars",
  scatter: "one mean against another across cases, with a power-law fit",
  detail: "every mean of one case against the reference case",
};

export default function PlotsView({ project, onProjectChange, active, onReset }: {
  project: Project;
  onProjectChange: (p: Project) => void;
  active: boolean;
  onReset: () => void;
}) {
  const [mode, setMode] = useState<Mode>("series");
  const [style, setStyle] = usePlotStyle(project.id);
  const ui = useDialog();
  const refKey = `mstar_post.plotref.${project.id}`;
  // Plots-only reference for % differences; the project reference case is the default
  const [ref, setRef] = useState<string>(() => localStorage.getItem(refKey) ?? project.ref_case ?? project.cases[0]?.id ?? "");
  useEffect(() => localStorage.setItem(refKey, ref), [refKey, ref]);
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow">Plots</h2>
        {(["series", "single", "bars", "scatter", "detail"] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? "primary" : ""} title={MODE_HELP[m]} onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>
        ))}
        <label title="baseline for '% vs ref' in all plot modes (the project reference case is set on the Cases tab)">Reference case{" "}
          <select value={ref} onChange={(e) => setRef(e.target.value)}>
            {project.cases.filter((c) => c.included || c.id === ref).map((c) => <option key={c.id} value={c.id}>{caseName(project, c.id)}
              {c.id === project.ref_case ? " (project ref)" : ""}{c.included ? "" : " (not selected)"}</option>)}
          </select></label>
        <button onClick={async () => await ui.confirm({ title: "Reset Plots?", ok: "Reset",
          body: <p>All panels, sources, case selections and the reference case go back to the defaults. Plot style and case names are kept.</p> }) && onReset()}>Reset</button>
        {ui.dialog}
      </div>
      <CaseNames project={project} onChange={onProjectChange} />
      <PlotStyleEditor style={style} setStyle={setStyle} project={project}
                       caseIds={project.cases.map((c) => c.id)} />
      <div className="small muted">{MODE_LABEL[mode]}: {MODE_HELP[mode]}.</div>
      {mode === "series" && <SeriesPlot project={project} style={style} active={active} refCase={ref} />}
      {mode === "single" && <StatsSeries project={project} style={style} />}
      {mode !== "series" && mode !== "single" && <MeansPlots project={project} view={mode} style={style} active={active} refCase={ref} />}
    </div>
  );
}

const caseIndex = (p: Project, id: string) => p.cases.findIndex((c) => c.id === id);
const sameRuns = (a: Run[], b: Run[]) => JSON.stringify(a) === JSON.stringify(b);
const pctDiff = (v: unknown, r: unknown) =>
  typeof v === "number" && typeof r === "number" && r !== 0 ? ((v - r) / Math.abs(r)) * 100 : null;

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

function loadPanels(pid: string): Panel[] {
  try {
    const v = JSON.parse(localStorage.getItem(`mstar_post.plots.${pid}`) ?? "");
    if (Array.isArray(v) && v.length && v.every((p) => typeof p.src === "string" && Array.isArray(p.cols)))
      return v as Panel[];
  } catch { /* none saved */ }
  return [DEFAULT_PANEL];
}

function SeriesPlot({ project, style, active, refCase }: { project: Project; style: PlotStyle; active: boolean; refCase: string }) {
  const cases = project.cases.filter((c) => c.included);
  const hideKey = `mstar_post.plots.hidden.${project.id}`;
  // cases hidden from the plot (data of all included cases is still loaded)
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPanels(loadPanels(project.id));
    setCache({});
    setCaseFiles({});
    cases.forEach((c) => api.stats(c.path)
      .then((fs) => setCaseFiles((m) => ({ ...m, [c.id]: fs })))
      .catch((e) => setError(`${c.id}: ${e.message}`)));
    api.runs(project.id).then((rs) => {
      setRuns(rs);
      rs.forEach((r) => api.runTimeseries(project.id, r.name)
        .then((fs) => setRunFiles((m) => ({ ...m, [r.name]: fs }))).catch(() => undefined));
    }).catch((e) => setError(e.message));
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // pick up runs finished while the tab was hidden
  useEffect(() => {
    if (!active) return;
    api.runs(project.id).then((rs) => {
      setRuns((old) => (sameRuns(old, rs) ? old : rs));
      rs.forEach((r) => api.runTimeseries(project.id, r.name)
        .then((fs) => setRunFiles((m) => (JSON.stringify(m[r.name]) === JSON.stringify(fs) ? m : { ...m, [r.name]: fs })))
        .catch(() => undefined));
    }).catch(() => undefined);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // union of the Stats files/columns of all included cases, reference case first
  const statsFiles = useMemo(() => {
    const order = [...cases].sort((a, b) => Number(b.id === project.ref_case) - Number(a.id === project.ref_case));
    const out: StatsFile[] = [];
    for (const c of order) for (const f of caseFiles[c.id] ?? []) {
      const e = out.find((x) => x.file === f.file);
      if (!e) out.push({ file: f.file, columns: [...f.columns] });
      else f.columns.forEach((col) => { if (!e.columns.includes(col)) e.columns.push(col); });
    }
    return out;
  }, [caseFiles, project.ref_case]); // eslint-disable-line react-hooks/exhaustive-deps
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
    src === "stats" ? statsFiles : runFiles[src.slice(4)] ?? [];

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

  useEffect(() => {
    for (const p of panels) for (const col of p.cols) {
      const k = dataKey(p, col);
      if (cache[k] || (p.src === "stats" && !filesReady)) continue;
      setCache((m) => ({ ...m, [k]: {} }));
      const put = (id: string, t: number[], v: (number | null)[]) =>
        setCache((m) => ({ ...m, [k]: { ...m[k], [id]: { t, v } } }));
      if (p.src === "stats") {
        cases.forEach((c) => {
          const file = statsFileFor(c.id, p.file, col);
          if (file) api.series(c.path, file, [col])
            .then((s) => put(c.id, s.t, s.columns[col]))
            .catch((e) => setError(`${c.id}: ${e.message}`));
        });
      } else {
        api.runSeries(project.id, p.src.slice(4), p.file, [col]).then((res) => {
          for (const [id, s] of Object.entries(res)) if (s.columns[col]) put(id, s.t, s.columns[col]);
        }).catch((e) => setError(`${p.file}: ${e.message}`));
      }
    }
  }, [panels, filesReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (key: number, patch: Partial<Panel>) =>
    setPanels((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const move = (i: number, d: number) => setPanels((ps) => {
    const q = [...ps];
    [q[i], q[i + d]] = [q[i + d], q[i]];
    return q;
  });
  const addPanel = () => setPanels((ps) => [...ps, { ...(ps[ps.length - 1] ?? DEFAULT_PANEL),
    key: Math.max(0, ...ps.map((p) => p.key)) + 1 }]);

  const colorOf = (id: string) => caseColor(style, id, caseIndex(project, id));
  const n = panels.length;
  const gap = n > 1 ? 0.06 / Math.max(1, n - 1) + 0.02 : 0;
  const yName = (i: number) => (i ? `y${i + 1}` : "y");
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
  const shapes: Partial<Plotly.Shape>[] = tss === "" ? [] : [{
    type: "line", x0: tss, x1: tss, yref: "paper", y0: 0, y1: 1, line: { dash: "dash", color: "green" },
  }];

  const stats = useMemo(() => {
    if (tss === "") return [];
    return panels.flatMap((p) => p.cols.flatMap((col) =>
      Object.entries(cache[dataKey(p, col)] ?? {}).filter(([id]) => !hidden.includes(id)).map(([id, s]) => {
        const v = s.v.filter((x, i): x is number => x !== null && s.t[i] >= tss);
        const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
        const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
        return { key: `${p.key}|${col}|${id}`, pk: `${p.key}|${col}`, col, id, mean: m, std: sd, n: v.length };
      })));
  }, [cache, panels, tss, hidden]);
  const refMean = (pk: string) => stats.find((s) => s.pk === pk && s.id === refCase)?.mean;

  const exportCsv = () => download("time_series.csv",
    toCsv(["case", "file", "column", "time_s", "value"], panels.flatMap((p) => p.cols.flatMap((col) =>
      Object.entries(cache[dataKey(p, col)] ?? {}).flatMap(([id, s]) =>
        s.t.map((t, i) => [id, p.file, col, t, s.v[i]]))))));

  return (
    <>
      <details className="card">
        <summary className="small">Cases shown: {shownCases.length} of {cases.length} included
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
                const r = runs.find((x) => runFiles[x.name]?.length);
                const src = e.target.value === "stats" ? "stats" : r ? `run:${r.name}` : null;
                if (!src) return;
                const f = filesOf(src)[0];
                update(p.key, { src, file: f?.file ?? "", cols: f ? [f.columns[0]] : [] });
              }}>
                <option value="stats">M-Star Stats</option>
                <option value="jobs" disabled={!runs.some((r) => runFiles[r.name]?.length)}>App script outputs</option>
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
                  {runs.filter((r) => runFiles[r.name]?.length).map((r) => (
                    <optgroup key={r.name} label={`${r.label ?? r.name} (${r.name.slice(0, 15)})`}>
                      {runFiles[r.name].map((f) => <option key={f.file} value={`${r.name}|${f.file}`}>{f.file}</option>)}
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
              <label title="plot each case relative to the reference case (interpolated onto the case's times)">vs ref <select
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
        {!runs.some((r) => runFiles[r.name]?.length) && <span className="muted">No app script outputs yet: run a task (e.g. stats summary with dispersion, heat transfer UA) to plot its time series.</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {panels.some((p) => (p.rel ?? "none") !== "none") && !cases.some((c) => c.id === refCase) &&
        <div className="error">The reference case is not included in the project (Cases tab); relative panels are empty.</div>}
      <Plot data={traces} exportName="time_series" style={style} height={Math.round(Math.max(360, 250 * n + 90) * style.heightScale)} layout={{
        ...layout, xaxis: { title: { text: "Time [s]" }, anchor: yName(n - 1) as Plotly.AxisName }, shapes,
        legend: { orientation: "h", y: 1.0, yanchor: "bottom" }, margin: { t: 50, r: 20, b: 50, l: 80 },
      }} />
      {tss !== "" && (
        <table className="grid narrow">
          <thead><tr><th>variable</th><th>case</th><th>mean (t &ge; {tss} s)</th><th>std</th><th>CoV</th><th>% vs ref</th><th>n</th></tr></thead>
          <tbody>{stats.map((s) => (
            <tr key={s.key} className={s.id === refCase ? "refrow" : ""}><td>{s.col}</td><td className="mono" title={s.id}>{caseName(project, s.id)}</td><td className="num">{fmt(s.mean)}</td>
              <td className="num">{fmt(s.std)}</td><td className="num">{fmt(s.std / Math.abs(s.mean))}</td>
              <td className="num">{fmt(pctDiff(s.mean, refMean(s.pk)))}</td>
              <td className="num">{s.n}</td></tr>))}</tbody>
        </table>
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
  const [srcs, setSrcs] = useState<string[]>(saved.srcs ?? []);  // "<run path>/<csv>"
  const [excluded, setExcluded] = useState<string[]>(saved.excluded ?? []);
  const [pctMode, setPctMode] = useState<"value" | "both" | "pct">(saved.pctMode ?? "value");
  const [heat, setHeat] = useState<boolean>(saved.heat ?? false);
  const [focus, setFocus] = useState<string>(saved.focus ?? "");
  const [merged, setMerged] = useState<Merged | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [colFilter, setColFilter] = useState("");
  const [xCol, setXCol] = useState("");
  const [yCol, setYCol] = useState("");
  const [fit, setFit] = useState(true);
  const [logAxes, setLogAxes] = useState(false);

  useEffect(() => {
    api.runs(project.id).then((rs) => {
      setRuns(rs);
      const all = new Set(rs.flatMap((r) => r.csvs.map((c) => `${r.path}/${c}`)));
      const kept = srcs.filter((s) => all.has(s));
      if (kept.length) { if (kept.length !== srcs.length) setSrcs(kept); return; }
      const r = rs.find((x) => x.csvs.some((c) => c.endsWith("_means.csv")));
      setSrcs(r ? [`${r.path}/${r.csvs.find((c) => c === "batch_summary_means.csv") ?? r.csvs.find((c) => c.endsWith("_means.csv"))}`] : []);
    });
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active) api.runs(project.id).then((rs) => setRuns((old) => (sameRuns(old, rs) ? old : rs))).catch(() => undefined);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem(store, JSON.stringify({ srcs, excluded, pctMode, heat, focus }));
  }, [store, srcs, excluded, pctMode, heat, focus]);

  const options = runs.flatMap((r) => r.csvs.filter((c) => c.endsWith("_means.csv") || c.endsWith("_settings.csv"))
    .map((c) => ({ value: `${r.path}/${c}`, label: `${r.label ?? r.name} (${r.name.slice(0, 15)}): ${c}` })));

  useEffect(() => {
    if (!srcs.length) { setMerged(null); return; }
    // keep the dropdown order so precedence does not depend on click order
    const ordered = options.map((o) => o.value).filter((v) => srcs.includes(v));
    if (!ordered.length) return;
    let stale = false;
    Promise.all(ordered.map((s) => api.csv(project.id, s).then((t) => ({
      label: options.find((o) => o.value === s)!.label, t }))))
      .then((tables) => {
      if (stale) return;
      const t = mergeTables(tables);
      setMerged(t);
      const num = t.columns.slice(1);
      setSel((s) => s.filter((c) => num.includes(c)).length ? s.filter((c) => num.includes(c)) : num.slice(0, 4));
      if (!num.includes(xCol)) setXCol(num.find((c) => /speed|rpm/i.test(c)) ?? num[0] ?? "");
      if (!num.includes(yCol)) setYCol(num.find((c) => /power number/i.test(c)) ?? num[1] ?? "");
    });
    return () => { stale = true; };
  }, [srcs.join("|"), runs]); // eslint-disable-line react-hooks/exhaustive-deps

  // cases deselected on the Cases tab are left out; cases unknown to the project (e.g. renamed) stay
  const deselected = new Set(project.cases.filter((c) => !c.included).map((c) => c.id));
  const allCases = merged?.rows.map((r) => String(r[0])).filter((c) => !deselected.has(c)) ?? [];
  const nHidden = merged ? merged.rows.length - allCases.length : 0;
  const shown = merged ? merged.rows.filter((r) => allCases.includes(String(r[0])) && !excluded.includes(String(r[0]))) : [];
  const table = merged && { columns: merged.columns, rows: shown };
  const cases = shown.map((r) => String(r[0]));
  const names = cases.map((c) => caseName(project, c));
  const colVals = (c: string) => table!.rows.map((r) => r[table!.columns.indexOf(c)]);
  // the reference row is taken from all merged cases, so an excluded reference still works
  const refRow = merged?.rows.find((r) => r[0] === refCase);
  const refVal = (c: string) => refRow?.[merged!.columns.indexOf(c)];
  const refName = caseName(project, refCase);
  const numeric = table?.columns.slice(1).filter((c) => colVals(c).some((v) => typeof v === "number")) ?? [];
  const shownVars = numeric.filter((c) => c.toLowerCase().includes(colFilter.toLowerCase()));
  const varList = (
    <>
      <input placeholder="filter variables" value={colFilter} onChange={(e) => setColFilter(e.target.value)} />
      <div className="row small">
        <button onClick={() => setSel([...new Set([...sel, ...shownVars])])}>select shown</button>
        <button onClick={() => setSel(sel.filter((c) => !shownVars.includes(c)))}>clear shown</button>
      </div>
      <div className="checklist">
        {shownVars.map((c) => (
          <label key={c} className="small"><input type="checkbox" checked={sel.includes(c)}
            onChange={(e) => setSel(e.target.checked ? [...sel, c] : sel.filter((x) => x !== c))} />{c}</label>
        ))}
      </div>
    </>
  );

  return (
    <>
      <div className="row">
        {!options.length && <span className="muted">Run "M-Star Stats summary" first.</span>}
      </div>
      {options.length > 0 && (
        <div className="split">
          <div className="side">
            <b className="small">Sources</b>
            <div className="checklist">
              {runs.map((r) => {
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
          </div>
          {merged && (
            <div className="side">
              <b className="small">Cases ({cases.length}/{allCases.length})</b>{" "}
              <button onClick={() => setExcluded([])}>all</button>
              <button onClick={() => setExcluded(allCases)}>none</button>
              {nHidden > 0 && <span className="small muted"> {nHidden} not selected on the Cases tab</span>}
              <div className="checklist">
                {allCases.map((c, i) => (
                  <label key={c} className="small" title={`${c}\n${merged.origin[i]}`}><input type="checkbox" checked={!excluded.includes(c)}
                    onChange={(e) => setExcluded(e.target.checked ? excluded.filter((x) => x !== c) : [...excluded, c])} />{caseName(project, c)}</label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {table && view === "bars" && (
        <div className="split">
          <div className="side">
            {varList}
            <button onClick={() => download("means_selection.csv", toCsv(["case", ...sel, ...sel.map((s) => `% vs ${refName}: ${s}`)],
              cases.map((c, i) => [names[i], ...sel.map((s) => colVals(s)[i]), ...sel.map((s) => pctDiff(colVals(s)[i], refVal(s)))])))}>
              Export selection CSV</button>
          </div>
          <div className="main">
            <div className="row small">
              <label>Show <select value={pctMode} onChange={(e) => setPctMode(e.target.value as typeof pctMode)}>
                <option value="value">values</option><option value="both">values + % vs ref</option>
                <option value="pct">% vs ref only</option></select></label>
              <label><input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} /> % difference heatmap</label>
              <span className="muted">reference: <b>{refName}</b>{!refRow && " (not in the selected sources: no % values)"}</span>
            </div>
            {heat && sel.length > 0 && (
              <Plot exportName="pct_diff_heatmap" style={style} height={Math.round(Math.max(260, 34 * sel.length + 170) * style.heightScale)} data={[{
                type: "heatmap", x: names, y: sel, zmid: 0, colorscale: "RdBu", reversescale: true,
                z: sel.map((s) => colVals(s).map((v) => pctDiff(v, refVal(s)))),
                text: sel.map((s) => colVals(s).map((v) => { const p = pctDiff(v, refVal(s)); return p === null ? "" : `${p.toFixed(1)}%`; })) as unknown as string[],
                texttemplate: "%{text}", hovertemplate: "%{y}<br>%{x}: %{z:.3g}%<extra></extra>",
                colorbar: { title: { text: `% vs ${refName}` } },
              } as Plotly.Data]} layout={{ title: { text: `% difference vs ${refName}` }, margin: { l: 20, b: 110 } }} />
            )}
            <div className="plotgrid">
              {sel.map((c) => {
                const ys = colVals(c).map((v) => (typeof v === "number" ? v : null));
                const pct = ys.map((y) => pctDiff(y, refVal(c)));
                const valTrace: Plotly.Data = { type: "bar", x: names, y: ys, name: "value", marker: {
                  color: style.barsByCase ? cases.map((id) => caseColor(style, id, caseIndex(project, id))) : style.barColor,
                  line: { color: "#000", width: cases.map((id) => (id === refCase ? 2 : 0)) } } };
                const pctTrace: Plotly.Data = { type: "bar", x: names, y: pct, name: `% vs ${refName}`,
                  yaxis: pctMode === "both" ? "y2" : "y", marker: { color: style.pctColor } };
                return (
                  <Plot key={c} exportName={c} style={style} height={Math.round(340 * style.heightScale)}
                    data={pctMode === "value" ? [valTrace] : pctMode === "pct" ? [pctTrace] : [valTrace, pctTrace]} layout={{
                    title: { text: c, font: { size: 13 } }, barmode: "group",
                    ...(pctMode === "pct" && { yaxis: { title: { text: `% vs ${refName}` } } }),
                    ...(pctMode === "both" && { yaxis2: { overlaying: "y", side: "right", title: { text: "% vs ref" } } }),
                    legend: { orientation: "h", y: 1.12 }, margin: { t: 60, b: 110, l: 70, r: 60 },
                  }} />
                );
              })}
            </div>
          </div>
        </div>
      )}
      {merged && view === "detail" && (
        <CaseDetail project={project} merged={merged} cases={cases} numeric={numeric} refCase={refCase} style={style}
                    focus={focus || allCases.find((c) => c !== refCase) || allCases[0] || ""} setFocus={setFocus} />
      )}
      {table && scatter && (
        <ScatterFit cases={cases} labels={cases.map((c) => project.aliases?.[c] ?? c.split("/").pop()!)}
                    colors={cases.map((id) => caseColor(style, id, caseIndex(project, id)))} style={style}
                    x={xCol} y={yCol} xs={colVals(xCol)} ys={colVals(yCol)}
                    numeric={numeric} setX={setXCol} setY={setYCol} fit={fit} setFit={setFit}
                    logAxes={logAxes} setLogAxes={setLogAxes} />
      )}
    </>
  );
}

// One case against the reference and the spread of the shown cases, per variable.
function CaseDetail({ project, merged, cases, numeric, refCase, style, focus, setFocus }: {
  project: Project; merged: Merged; cases: string[]; numeric: string[]; refCase: string; style: PlotStyle;
  focus: string; setFocus: (c: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [minPct, setMinPct] = useState<number | "">("");
  const [order, setOrder] = useState<"var" | "pct">("pct");
  const row = (id: string) => merged.rows.find((r) => r[0] === id);
  const fr = row(focus), rr = row(refCase);
  const shownRows = merged.rows.filter((r) => cases.includes(String(r[0])));
  let rows = numeric.filter((c) => c.toLowerCase().includes(filter.toLowerCase())).map((c) => {
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
  if (order === "pct") rows = [...rows].sort((a, b) => Math.abs(b.pct ?? -1) - Math.abs(a.pct ?? -1));
  const top = rows.filter((x) => x.pct !== null).slice(0, 40);
  const fName = caseName(project, focus), rName = caseName(project, refCase);
  return (
    <div>
      <div className="row">
        <label>Case <select value={focus} onChange={(e) => setFocus(e.target.value)}>
          {merged.rows.map((r) => String(r[0])).map((id) => <option key={id} value={id}>{caseName(project, id)}</option>)}
        </select></label>
        <span className="muted">vs reference <b>{rName}</b>; rank, range, mean and z over the {cases.length} checked cases</span>
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
      {!fr && <div className="error">The case is not in the selected sources.</div>}
      {!rr && <div className="muted">The reference case is not in the selected sources: no % values.</div>}
      {top.length > 0 && (
        <Plot exportName={`case_detail_${fName}`} style={style} height={Math.round(Math.max(260, 22 * top.length + 120) * style.heightScale)} data={[{
          type: "bar", orientation: "h", y: top.map((x) => x.c), x: top.map((x) => x.pct),
          marker: { color: top.map((x) => ((x.pct ?? 0) >= 0 ? "#c0504d" : "#4f81bd")) },
          hovertemplate: "%{y}: %{x:.3g}%<extra></extra>",
        }]} layout={{
          title: { text: `${fName}: % difference vs ${rName}${rows.length > top.length ? ` (largest ${top.length})` : ""}` },
          yaxis: { autorange: "reversed", automargin: true }, xaxis: { title: { text: "% vs ref" }, zeroline: true },
          margin: { l: 20, t: 50 },
        }} />
      )}
      <div className="tablewrap">
        <table className="grid">
          <thead><tr><th>variable</th><th>{fName}</th><th>{rName} (ref)</th><th>% vs ref</th><th>rank</th>
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
  return (
    <>
      <div className="row">
        <label>x <select value={x} onChange={(e) => setX(e.target.value)}>{numeric.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label>y <select value={y} onChange={(e) => setY(e.target.value)}>{numeric.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label><input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} /> power-law fit</label>
        <label><input type="checkbox" checked={logAxes} onChange={(e) => setLogAxes(e.target.checked)} /> log axes</label>
        {law && <span className="mono">y = {fmt(law.a)} x^{fmt(law.b, 3)} (R&sup2; = {fmt(law.r2, 3)})</span>}
      </div>
      <Plot exportName={`${y}_vs_${x}`} style={style} height={Math.round(520 * style.heightScale)} data={[
        { type: "scatter", mode: "text+markers", x: pts.map((p) => p[1]), y: pts.map((p) => p[2]),
          text: pts.map((p) => p[0]), textposition: "top center",
          hovertext: pts.map((p) => p[3]), marker: { size: style.markerSize, color: pts.map((p) => p[4]) },
          textfont: { size: style.fontSize }, name: "cases" },
        ...(law ? [{ type: "scatter" as const, mode: "lines" as const, x: fx,
          y: fx.map((v) => law!.a * v ** law!.b), name: "fit", line: { dash: "dash" as const } }] : []),
      ]} layout={{
        xaxis: { title: { text: x }, type: logAxes ? "log" : "linear" },
        yaxis: { title: { text: y }, type: logAxes ? "log" : "linear" },
      }} />
    </>
  );
}
