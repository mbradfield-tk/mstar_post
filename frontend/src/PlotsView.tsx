import { useEffect, useMemo, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, download, fmt, toCsv, type CsvTable, type Project, type Run, type RunSeriesFile,
         type StatsFile } from "./api";
import Plot from "./Plot";

type Mode = "series" | "bars" | "scatter";

export default function PlotsView({ project }: { project: Project }) {
  const [mode, setMode] = useState<Mode>("series");
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow">Plots</h2>
        {(["series", "bars", "scatter"] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? "primary" : ""} onClick={() => setMode(m)}>
            {{ series: "Time series", bars: "Compare means", scatter: "Trend (x-y)" }[m]}
          </button>
        ))}
      </div>
      {mode === "series" && <SeriesPlot project={project} />}
      {mode !== "series" && <MeansPlots project={project} scatter={mode === "scatter"} />}
    </div>
  );
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
type Panel = { key: number; src: string; file: string; cols: string[]; win: number; logY: boolean };
type SeriesMap = Record<string, { t: number[]; v: (number | null)[] }>;

const PALETTE = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
                 "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"];
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

function SeriesPlot({ project }: { project: Project }) {
  const cases = project.cases.filter((c) => c.included);
  const [panels, setPanels] = useState<Panel[]>(() => loadPanels(project.id));
  const [statsFiles, setStatsFiles] = useState<StatsFile[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runFiles, setRunFiles] = useState<Record<string, RunSeriesFile[]>>({});
  const [tss, setTss] = useState<number | "">("");
  const [cache, setCache] = useState<Record<string, SeriesMap>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPanels(loadPanels(project.id));
    setCache({});
    const c = cases.find((x) => x.id === project.ref_case) ?? cases[0];
    if (c) api.stats(c.path).then(setStatsFiles).catch((e) => setError(e.message));
    api.runs(project.id).then((rs) => {
      const ss = rs.filter((r) => r.task === "stats_summary");
      setRuns(ss);
      ss.forEach((r) => api.runTimeseries(project.id, r.name)
        .then((fs) => setRunFiles((m) => ({ ...m, [r.name]: fs }))).catch(() => undefined));
    }).catch((e) => setError(e.message));
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem(`mstar_post.plots.${project.id}`, JSON.stringify(panels));
  }, [panels, project.id]);

  const filesOf = (src: string): { file: string; columns: string[] }[] =>
    src === "stats" ? statsFiles : runFiles[src.slice(4)] ?? [];

  useEffect(() => {
    for (const p of panels) for (const col of p.cols) {
      const k = dataKey(p, col);
      if (cache[k]) continue;
      setCache((m) => ({ ...m, [k]: {} }));
      const put = (id: string, t: number[], v: (number | null)[]) =>
        setCache((m) => ({ ...m, [k]: { ...m[k], [id]: { t, v } } }));
      if (p.src === "stats") {
        cases.forEach((c) => api.series(c.path, p.file, [col])
          .then((s) => put(c.id, s.t, s.columns[col]))
          .catch((e) => setError(`${c.id}: ${e.message}`)));
      } else {
        api.runSeries(project.id, p.src.slice(4), p.file, [col]).then((res) => {
          for (const [id, s] of Object.entries(res)) if (s.columns[col]) put(id, s.t, s.columns[col]);
        }).catch((e) => setError(`${p.file}: ${e.message}`));
      }
    }
  }, [panels]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (key: number, patch: Partial<Panel>) =>
    setPanels((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const move = (i: number, d: number) => setPanels((ps) => {
    const q = [...ps];
    [q[i], q[i + d]] = [q[i + d], q[i]];
    return q;
  });
  const addPanel = () => setPanels((ps) => [...ps, { ...(ps[ps.length - 1] ?? DEFAULT_PANEL),
    key: Math.max(0, ...ps.map((p) => p.key)) + 1 }]);

  const caseColor = (id: string) => PALETTE[Math.max(0, cases.findIndex((c) => c.id === id)) % PALETTE.length];
  const n = panels.length;
  const gap = n > 1 ? 0.06 / Math.max(1, n - 1) + 0.02 : 0;
  const yName = (i: number) => (i ? `y${i + 1}` : "y");
  const traces: Plotly.Data[] = [];
  const layout: Record<string, unknown> = {};
  const seen = new Set<string>();
  panels.forEach((p, i) => {
    const top = 1 - i / n, bottom = 1 - (i + 1) / n;
    layout[i ? `yaxis${i + 1}` : "yaxis"] = {
      domain: [bottom + (i < n - 1 ? gap / 2 : 0), top - (i ? gap / 2 : 0)],
      type: p.logY ? "log" : "linear",
      title: { text: p.cols.length === 1 ? p.cols[0]
        : p.cols.map((c, j) => `${c} (${DASHES[j % DASHES.length]})`).join("<br>"), font: { size: 11 } },
    };
    p.cols.forEach((col, j) => {
      const d = cache[dataKey(p, col)] ?? {};
      cases.filter((c) => d[c.id]).forEach((c) => {
        traces.push({
          type: "scattergl", mode: "lines", name: c.id, legendgroup: c.id,
          showlegend: !seen.has(c.id), yaxis: yName(i),
          x: d[c.id].t, y: movingAvg(d[c.id].t, d[c.id].v, p.win),
          hovertemplate: `${c.id}<br>${col}: %{y:.5g}<br>t = %{x:.4g} s<extra></extra>`,
          line: { width: c.id === project.ref_case ? 2.5 : 1.3, color: caseColor(c.id),
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
      Object.entries(cache[dataKey(p, col)] ?? {}).map(([id, s]) => {
        const v = s.v.filter((x, i): x is number => x !== null && s.t[i] >= tss);
        const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
        const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
        return { key: `${p.key}|${col}|${id}`, col, id, mean: m, std: sd, n: v.length };
      })));
  }, [cache, panels, tss]);

  const exportCsv = () => download("time_series.csv",
    toCsv(["case", "file", "column", "time_s", "value"], panels.flatMap((p) => p.cols.flatMap((col) =>
      Object.entries(cache[dataKey(p, col)] ?? {}).flatMap(([id, s]) =>
        s.t.map((t, i) => [id, p.file, col, t, s.v[i]]))))));

  return (
    <>
      <div className="panels">
        {panels.map((p, i) => {
          const files = filesOf(p.src);
          const columns = files.find((f) => f.file === p.file)?.columns ?? [];
          return (
            <div key={p.key} className="row panel-row">
              <b>{i + 1}</b>
              <label>Source <select value={p.src} onChange={(e) => {
                const src = e.target.value;
                const f = filesOf(src)[0];
                update(p.key, { src, file: f?.file ?? "", cols: f ? [f.columns[0]] : [] });
              }}>
                <option value="stats">Stats files</option>
                {runs.filter((r) => runFiles[r.name]?.length).map((r) => (
                  <option key={r.name} value={`run:${r.name}`}>run: {r.label ?? r.name} ({r.name.slice(0, 15)})</option>))}
              </select></label>
              <label>File <select value={p.file} onChange={(e) => {
                const f = files.find((x) => x.file === e.target.value);
                update(p.key, { file: e.target.value, cols: f ? [f.columns[0]] : [] });
              }}>
                {!files.some((f) => f.file === p.file) && <option value={p.file}>{p.file || "-"}</option>}
                {files.map((f) => <option key={f.file}>{f.file}</option>)}
              </select></label>
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
        {!runs.some((r) => runFiles[r.name]?.length) && <span className="muted">Run "M-Star Stats summary" with dispersion/uniformity for metric time series.</span>}
      </div>
      {error && <div className="error">{error}</div>}
      <Plot data={traces} exportName="time_series" height={Math.max(360, 250 * n + 90)} layout={{
        ...layout, xaxis: { title: { text: "Time [s]" }, anchor: yName(n - 1) as Plotly.AxisName }, shapes,
        legend: { orientation: "h", y: 1.0, yanchor: "bottom" }, margin: { t: 50, r: 20, b: 50, l: 80 },
      }} />
      {tss !== "" && (
        <table className="grid narrow">
          <thead><tr><th>variable</th><th>case</th><th>mean (t &ge; {tss} s)</th><th>std</th><th>CoV</th><th>n</th></tr></thead>
          <tbody>{stats.map((s) => (
            <tr key={s.key}><td>{s.col}</td><td className="mono">{s.id}</td><td className="num">{fmt(s.mean)}</td>
              <td className="num">{fmt(s.std)}</td><td className="num">{fmt(s.std / Math.abs(s.mean))}</td>
              <td className="num">{s.n}</td></tr>))}</tbody>
        </table>
      )}
    </>
  );
}

function MeansPlots({ project, scatter }: { project: Project; scatter: boolean }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [src, setSrc] = useState("");  // "<run path>/<csv>"
  const [table, setTable] = useState<CsvTable | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [colFilter, setColFilter] = useState("");
  const [xCol, setXCol] = useState("");
  const [yCol, setYCol] = useState("");
  const [fit, setFit] = useState(true);
  const [logAxes, setLogAxes] = useState(false);

  useEffect(() => {
    api.runs(project.id).then((rs) => {
      setRuns(rs);
      const r = rs.find((x) => x.csvs.some((c) => c.endsWith("_means.csv")));
      if (r) setSrc(`${r.path}/${r.csvs.find((c) => c === "batch_summary_means.csv") ?? r.csvs.find((c) => c.endsWith("_means.csv"))}`);
    });
  }, [project.id]);

  useEffect(() => {
    if (!src) return;
    api.csv(project.id, src).then((t) => {
      setTable(t);
      const num = t.columns.slice(1);
      setSel((s) => s.filter((c) => num.includes(c)).length ? s.filter((c) => num.includes(c)) : num.slice(0, 4));
      if (!num.includes(xCol)) setXCol(num.find((c) => /speed|rpm/i.test(c)) ?? num[0] ?? "");
      if (!num.includes(yCol)) setYCol(num.find((c) => /power number/i.test(c)) ?? num[1] ?? "");
    });
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = runs.flatMap((r) => r.csvs.filter((c) => c.endsWith("_means.csv") || c.endsWith("_settings.csv"))
    .map((c) => ({ value: `${r.path}/${c}`, label: `${r.label ?? r.name}: ${c}` })));
  const cases = table?.rows.map((r) => String(r[0])) ?? [];
  const colVals = (c: string) => table!.rows.map((r) => r[table!.columns.indexOf(c)]);
  const refIdx = Math.max(0, cases.indexOf(project.ref_case ?? ""));
  const numeric = table?.columns.slice(1).filter((c) => colVals(c).some((v) => typeof v === "number")) ?? [];

  return (
    <>
      <div className="row">
        <label>Source <select value={src} onChange={(e) => setSrc(e.target.value)}>
          <option value="" disabled>choose a means CSV</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select></label>
        {!options.length && <span className="muted">Run "M-Star Stats summary" first.</span>}
      </div>
      {table && !scatter && (
        <div className="split">
          <div className="side">
            <input placeholder="filter variables" value={colFilter} onChange={(e) => setColFilter(e.target.value)} />
            <div className="checklist">
              {numeric.filter((c) => c.toLowerCase().includes(colFilter.toLowerCase())).map((c) => (
                <label key={c} className="small"><input type="checkbox" checked={sel.includes(c)}
                  onChange={(e) => setSel(e.target.checked ? [...sel, c] : sel.filter((x) => x !== c))} />{c}</label>
              ))}
            </div>
            <button onClick={() => download("means_selection.csv", toCsv(["case", ...sel],
              cases.map((c, i) => [c, ...sel.map((s) => colVals(s)[i])])))}>Export selection CSV</button>
          </div>
          <div className="main plotgrid">
            {sel.map((c) => {
              const ys = colVals(c).map((v) => (typeof v === "number" ? v : null));
              const ref = ys[refIdx];
              const pct = ys.map((y) => (y !== null && ref ? ((y - ref) / Math.abs(ref)) * 100 : null));
              return (
                <Plot key={c} exportName={c} height={340} data={[
                  { type: "bar", x: cases, y: ys, name: "value", marker: { color: "steelblue" } },
                  { type: "bar", x: cases, y: pct, name: "% vs ref", yaxis: "y2", marker: { color: "indianred" }, visible: "legendonly" },
                ]} layout={{
                  title: { text: c, font: { size: 13 } }, barmode: "group",
                  yaxis2: { overlaying: "y", side: "right", title: { text: "% vs ref" } },
                  legend: { orientation: "h", y: 1.12 }, margin: { t: 60, b: 110, l: 70, r: 60 },
                }} />
              );
            })}
          </div>
        </div>
      )}
      {table && scatter && (
        <ScatterFit cases={cases} x={xCol} y={yCol} xs={colVals(xCol)} ys={colVals(yCol)}
                    numeric={numeric} setX={setXCol} setY={setYCol} fit={fit} setFit={setFit}
                    logAxes={logAxes} setLogAxes={setLogAxes} />
      )}
    </>
  );
}

function ScatterFit({ cases, x, y, xs, ys, numeric, setX, setY, fit, setFit, logAxes, setLogAxes }: {
  cases: string[]; x: string; y: string; xs: unknown[]; ys: unknown[]; numeric: string[];
  setX: (s: string) => void; setY: (s: string) => void; fit: boolean; setFit: (b: boolean) => void;
  logAxes: boolean; setLogAxes: (b: boolean) => void;
}) {
  const pts = cases.map((c, i) => [c, xs[i], ys[i]] as const)
    .filter((p): p is readonly [string, number, number] => typeof p[1] === "number" && typeof p[2] === "number");
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
      <Plot exportName={`${y}_vs_${x}`} height={520} data={[
        { type: "scatter", mode: "text+markers", x: pts.map((p) => p[1]), y: pts.map((p) => p[2]),
          text: pts.map((p) => p[0].split("/").pop()!), textposition: "top center",
          hovertext: pts.map((p) => p[0]), marker: { size: 10 }, name: "cases" },
        ...(law ? [{ type: "scatter" as const, mode: "lines" as const, x: fx,
          y: fx.map((v) => law!.a * v ** law!.b), name: "fit", line: { dash: "dash" as const } }] : []),
      ]} layout={{
        xaxis: { title: { text: x }, type: logAxes ? "log" : "linear" },
        yaxis: { title: { text: y }, type: logAxes ? "log" : "linear" },
      }} />
    </>
  );
}
