import { useEffect, useMemo, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, download, fmt, toCsv, type CsvTable, type Project, type Run, type StatsFile } from "./api";
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

function SeriesPlot({ project }: { project: Project }) {
  const cases = project.cases.filter((c) => c.included);
  const [files, setFiles] = useState<StatsFile[]>([]);
  const [file, setFile] = useState("Fluid.txt");
  const [col, setCol] = useState("Mean Velocity [m/s]");
  const [win, setWin] = useState(0);
  const [tss, setTss] = useState<number | "">("");
  const [data, setData] = useState<Record<string, { t: number[]; v: (number | null)[] }>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = cases.find((x) => x.id === project.ref_case) ?? cases[0];
    if (c) api.stats(c.path).then(setFiles).catch((e) => setError(e.message));
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns = files.find((f) => f.file === file)?.columns ?? [];
  useEffect(() => {
    if (columns.length && !columns.includes(col)) setCol(columns[0]);
  }, [file, files]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!col) return;
    setError(null);
    setData({});
    cases.forEach((c) => api.series(c.path, file, [col])
      .then((s) => setData((d) => ({ ...d, [c.id]: { t: s.t, v: s.columns[col] } })))
      .catch((e) => setError(`${c.id}: ${e.message}`)));
  }, [file, col, project]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    if (tss === "") return {};
    return Object.fromEntries(Object.entries(data).map(([id, s]) => {
      const v = s.v.filter((x, i): x is number => x !== null && s.t[i] >= tss);
      const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
      return [id, { mean: m, std: sd, n: v.length }];
    }));
  }, [data, tss]);

  const traces: Plotly.Data[] = cases.filter((c) => data[c.id]).map((c) => ({
    type: "scattergl", mode: "lines", name: c.id,
    x: data[c.id].t, y: movingAvg(data[c.id].t, data[c.id].v, win),
    line: { width: c.id === project.ref_case ? 2.5 : 1.3 },
  }));
  const shapes: Partial<Plotly.Shape>[] = tss === "" ? [] : [{
    type: "line", x0: tss, x1: tss, yref: "paper", y0: 0, y1: 1, line: { dash: "dash", color: "green" },
  }];

  const exportCsv = () => download(`${file.replace(/\W+/g, "_")}_${col.replace(/\W+/g, "_")}.csv`,
    toCsv(["case", "time_s", col], Object.entries(data).flatMap(([id, s]) =>
      s.t.map((t, i) => [id, t, s.v[i]]))));

  return (
    <>
      <div className="row">
        <label>Stats file <select value={file} onChange={(e) => setFile(e.target.value)}>
          {files.map((f) => <option key={f.file}>{f.file}</option>)}</select></label>
        <label>Variable <select value={col} onChange={(e) => setCol(e.target.value)}>
          {columns.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label>Moving avg [s] <input type="number" step="any" value={win || ""} placeholder="off"
                                     onChange={(e) => setWin(Number(e.target.value))} /></label>
        <label>Steady from [s] <input type="number" step="any" value={tss}
                                      onChange={(e) => setTss(e.target.value === "" ? "" : Number(e.target.value))} /></label>
        <button onClick={exportCsv}>Export CSV</button>
      </div>
      {error && <div className="error">{error}</div>}
      <Plot data={traces} exportName={col} height={520} layout={{
        xaxis: { title: { text: "Time [s]" } }, yaxis: { title: { text: col } }, shapes,
        legend: { orientation: "h", y: -0.18 },
      }} />
      {tss !== "" && (
        <table className="grid narrow">
          <thead><tr><th>case</th><th>mean (t &ge; {tss} s)</th><th>std</th><th>CoV</th><th>n</th></tr></thead>
          <tbody>{Object.entries(stats).map(([id, s]) => (
            <tr key={id}><td className="mono">{id}</td><td className="num">{fmt(s.mean)}</td>
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
