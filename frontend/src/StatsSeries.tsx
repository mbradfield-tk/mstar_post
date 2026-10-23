import { useEffect, useMemo, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, caseName, download, fmt, toCsv, type Project, type ProjectCase, type Run, type RunSeriesFile,
         type StatsFile } from "./api";
import Plot from "./Plot";
import type { PlotStyle } from "./PlotStyle";

const KEY = "mstar_post.statsseries";

// One case, one file (M-Star Stats or a job's per-case time-series CSV), one or more variables over time.
// src is "stats" or "run:<run name>".
export default function StatsSeries({ project, cases, style, onSelect }: {
  project: Project; cases?: ProjectCase[]; style?: PlotStyle;
  onSelect?: (caseId: string, file: string, src: string) => void;
}) {
  const list = cases?.length ? cases : project.cases;
  const saved = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(`${KEY}.${project.id}`) ?? "{}"); } catch { return {}; }
  }, [project.id]);
  const [caseId, setCaseId] = useState<string>(saved.caseId ?? "");
  const [src, setSrc] = useState<string>(saved.src ?? "stats");
  const [file, setFile] = useState<string>(saved.file ?? "Fluid.txt");
  const [cols, setCols] = useState<string[]>(saved.cols ?? []);
  const [win, setWin] = useState<number>(0);
  const [varFilter, setVarFilter] = useState("");
  // averaging window [s]; "" = start / end of the run
  const [tFrom, setTFrom] = useState<number | "">(saved.tFrom ?? "");
  const [tTo, setTTo] = useState<number | "">(saved.tTo ?? "");
  const [statsFiles, setStatsFiles] = useState<StatsFile[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsReady, setRunsReady] = useState(false);
  const [runFiles, setRunFiles] = useState<Record<string, RunSeriesFile[]>>({});
  const [data, setData] = useState<{ t: number[]; columns: Record<string, (number | null)[]> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const c = list.find((x) => x.id === caseId) ?? list.find((x) => x.id === project.ref_case) ?? list[0];
  const runOf = src.startsWith("run:") ? src.slice(4) : null;
  const runOptions = runs.filter((r) => (runFiles[r.name] ?? []).some((f) => c && f.cases.includes(c.id)));
  const files: StatsFile[] = runOf
    ? (runFiles[runOf] ?? []).filter((f) => c && f.cases.includes(c.id)).map(({ file: f, columns: cs }) => ({ file: f, columns: cs }))
    : statsFiles;

  useEffect(() => {
    localStorage.setItem(`${KEY}.${project.id}`, JSON.stringify({ caseId: c?.id, src, file, cols, tFrom, tTo }));
  }, [project.id, c?.id, src, file, cols, tFrom, tTo]);
  useEffect(() => { if (c && files.some((f) => f.file === file)) onSelect?.(c.id, file, src); },
    [c?.id, file, src, files.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // jobs with per-case time-series CSVs (e.g. ua.csv of the heat-transfer task)
  useEffect(() => {
    api.runs(project.id).then((rs) => {
      setRuns(rs);
      setRunsReady(true);
      rs.forEach((r) => api.runTimeseries(project.id, r.name)
        .then((fs) => setRunFiles((m) => ({ ...m, [r.name]: fs })))
        .catch(() => setRunFiles((m) => ({ ...m, [r.name]: [] }))));
    }).catch(() => undefined);
  }, [project.id]);

  useEffect(() => {
    if (!c) return;
    setError(null);
    setStatsFiles([]);
    api.stats(c.path).then(setStatsFiles).catch((e) => setError(e.message));
  }, [c?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep file and variables valid for the current source and case
  const runsLoaded = runsReady && runs.every((r) => runFiles[r.name]);
  useEffect(() => {
    if (runOf && runsLoaded && !runOptions.some((r) => r.name === runOf)) setSrc("stats");
  }, [runOf, runsLoaded, c?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const filesKey = `${src}|${files.map((f) => f.file).join("|")}`;
  useEffect(() => {
    if (!files.length) return;
    const f = files.find((x) => x.file === file) ?? (runOf ? undefined : files.find((x) => x.file === "Fluid.txt")) ?? files[0];
    if (f.file !== file) setFile(f.file);
    setCols((cs) => {
      const ok = cs.filter((x) => f.columns.includes(x));
      return ok.length ? ok : [f.columns.find((x) => /energy dissipation|^UA \[/i.test(x)) ?? f.columns[0]];
    });
  }, [filesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns = files.find((f) => f.file === file)?.columns ?? [];
  const words = varFilter.toLowerCase().split(/\s+/).filter(Boolean);
  const choices = columns.filter((x) => !cols.includes(x) && words.every((w) => x.toLowerCase().includes(w)));
  useEffect(() => {
    setData(null);
    const want = cols.filter((x) => columns.includes(x));
    if (!c || !want.length) return;
    let live = true;
    const load = runOf
      ? api.runSeries(project.id, runOf, file, want, [c.id]).then((r) => r[c.id] ?? null)
      : api.series(c.path, file, want);
    load.then((d) => live && setData(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [c?.path, src, file, cols.join("|"), columns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const smooth = (t: number[], v: (number | null)[]) => {
    if (!(win > 0)) return v;
    let j = 0, s = 0, n = 0;
    return t.map((ti, i) => {
      const x = v[i];
      if (x !== null) { s += x; n++; }
      while (ti - t[j] > win) { const y = v[j]; if (y !== null) { s -= y; n--; } j++; }
      return n ? s / n : null;
    });
  };
  const t0 = data?.t[0] ?? 0, t1 = data?.t[data.t.length - 1] ?? 0;
  const a = tFrom === "" ? t0 : tFrom, b = tTo === "" ? t1 : tTo;
  const lastFrac = (f: number) => { setTFrom(Number((t1 - f * (t1 - t0)).toPrecision(4))); setTTo(""); };
  const stat = (v: (number | null)[]) => {
    const all = v.filter((y): y is number => y !== null);
    const x = v.filter((y, i): y is number => y !== null && data!.t[i] >= a && data!.t[i] <= b);
    if (!x.length) return null;
    const mean = x.reduce((p, q) => p + q, 0) / x.length;
    const std = Math.sqrt(x.reduce((p, q) => p + (q - mean) ** 2, 0) / Math.max(1, x.length - 1));
    return { min: Math.min(...x), max: Math.max(...x), mean, std, n: x.length, last: all[all.length - 1] };
  };
  if (!list.length) return <div className="muted">No cases in this project.</div>;

  return (
    <div>
      <div className="row small">
        <label>Case <select value={c?.id} onChange={(e) => setCaseId(e.target.value)}>
          {list.map((x) => <option key={x.id} value={x.id}>{caseName(project, x.id)}</option>)}</select></label>
        <label>Source <select value={runOf ? "jobs" : "stats"} onChange={(e) => {
          if (e.target.value === "stats") { setSrc("stats"); return; }
          if (runOptions[0]) setSrc(`run:${runOptions[0].name}`);
        }}>
          <option value="stats">M-Star Stats</option>
          <option value="jobs" disabled={!runOptions.length}>App script outputs{runOptions.length ? "" : " (none for this case)"}</option>
        </select></label>
        {runOf ? (
          <label>File <select value={`${runOf}|${file}`} onChange={(e) => {
            const i = e.target.value.indexOf("|");
            setSrc(`run:${e.target.value.slice(0, i)}`);
            setFile(e.target.value.slice(i + 1));
          }}>
            {!runOptions.some((r) => r.name === runOf) && <option value={`${runOf}|${file}`}>{file}</option>}
            {runOptions.map((r) => (
              <optgroup key={r.name} label={`${r.label ?? r.task} (${r.name.slice(0, 15)})`}>
                {(runFiles[r.name] ?? []).filter((f) => c && f.cases.includes(c.id)).map((f) => (
                  <option key={f.file} value={`${r.name}|${f.file}`}>{f.file}</option>))}
              </optgroup>))}
          </select></label>
        ) : (
          <label>File <select value={file} onChange={(e) => {
            const f = files.find((x) => x.file === e.target.value);
            setFile(e.target.value);
            if (f) setCols([f.columns[0]]);
          }}>
            {!files.some((f) => f.file === file) && <option value={file}>{file}</option>}
            {files.map((f) => <option key={f.file}>{f.file}</option>)}</select></label>
        )}
        <span className="chips">{cols.map((x) => (
          <span key={x} className="chip">{x}<button title="remove" onClick={() => setCols(cols.filter((y) => y !== x))}>&times;</button></span>))}
        </span>
        <input className="short-wide" placeholder="filter variables" value={varFilter}
               title="words in any order, e.g. 'dissipation mean'"
               onChange={(e) => setVarFilter(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && choices.length === 1) { setCols([...cols, choices[0]]); setVarFilter(""); } }} />
        <select value="" onChange={(e) => e.target.value && setCols([...cols, e.target.value])}>
          <option value="">+ variable ({choices.length}{words.length ? ` of ${columns.length - cols.length}` : ""})</option>
          {choices.map((x) => <option key={x}>{x}</option>)}</select>
        <label>Avg [s] <input type="number" step="any" className="short" value={win || ""} placeholder="off"
                              onChange={(e) => setWin(Number(e.target.value))} /></label>
        {data && <button onClick={() => download(`${c!.id.replace(/\//g, "_")}_${file.replace(/\.(txt|csv)$/, "")}.csv`,
          toCsv(["time [s]", ...cols], data.t.map((t, i) => [t, ...cols.map((x) => data.columns[x]?.[i] ?? null)])))}>Export CSV</button>}
      </div>
      {error && <div className="error">{error}</div>}
      {data && (
        <div className="row small">
          <b>Averaging window</b>
          <label>from [s] <input type="number" step="any" className="short" value={tFrom} placeholder={fmt(t0)}
            onChange={(e) => setTFrom(e.target.value === "" ? "" : Number(e.target.value))} /></label>
          <label>to [s] <input type="number" step="any" className="short" value={tTo} placeholder={fmt(t1)}
            onChange={(e) => setTTo(e.target.value === "" ? "" : Number(e.target.value))} /></label>
          <button onClick={() => lastFrac(0.5)}>last 50%</button>
          <button onClick={() => lastFrac(0.25)}>last 25%</button>
          <button onClick={() => { setTFrom(""); setTTo(""); }}>whole run</button>
          {a >= b && <span className="error">"from" must be before "to"</span>}
          <span className="muted">shaded on the plot; run time {fmt(t0)} to {fmt(t1)} s</span>
        </div>
      )}
      {data && cols.length > 0 && (
        <>
          <Plot exportName={`${caseName(project, c!.id)}_${file}`} style={style}
            height={Math.round(Math.max(320, 200 * cols.length + 80) * (style?.heightScale ?? 1))}
            data={cols.map((x, i) => ({
              type: "scattergl" as const, mode: "lines" as const, name: x, x: data.t,
              y: smooth(data.t, data.columns[x] ?? []), yaxis: i ? `y${i + 1}` : "y",
            }))}
            layout={{
              title: { text: `${caseName(project, c!.id)}: ${file}` }, showlegend: false,
              shapes: [
                { type: "rect", xref: "x", yref: "paper", x0: a, x1: b, y0: 0, y1: 1,
                  fillcolor: "rgba(96,165,250,0.12)", line: { width: 0 }, layer: "below" },
                ...cols.flatMap((x, i) => {
                  const s = stat(data.columns[x] ?? []);
                  return s ? [{ type: "line" as const, xref: "x" as const, yref: (i ? `y${i + 1}` : "y") as Plotly.YAxisName,
                    x0: a, x1: b, y0: s.mean, y1: s.mean, line: { color: "#ef4444", dash: "dot" as const, width: 1.5 } }] : [];
                }),
              ],
              xaxis: { title: { text: "Time [s]" }, anchor: cols.length > 1 ? `y${cols.length}` : "y" } as Partial<Plotly.LayoutAxis>,
              ...Object.fromEntries(cols.map((x, i) => [i ? `yaxis${i + 1}` : "yaxis", {
                title: { text: x, font: { size: 11 } },
                domain: [1 - (i + 1) / cols.length + (i < cols.length - 1 ? 0.03 : 0), 1 - i / cols.length - (i ? 0.03 : 0)],
              }])),
            }} />
          <table className="grid narrow">
            <thead><tr><th>variable</th><th>mean ({fmt(a)} to {fmt(b)} s)</th><th>std</th><th>CoV</th><th>min</th><th>max</th>
              <th>n</th><th>last</th></tr></thead>
            <tbody>{cols.map((x) => { const s = stat(data.columns[x] ?? []); return (
              <tr key={x}><td>{x}</td><td className="num">{fmt(s?.mean)}</td><td className="num">{fmt(s?.std)}</td>
                <td className="num">{s && s.mean ? fmt(s.std / Math.abs(s.mean)) : ""}</td>
                <td className="num">{fmt(s?.min)}</td><td className="num">{fmt(s?.max)}</td>
                <td className="num">{s?.n ?? 0}</td><td className="num">{fmt(s?.last)}</td></tr>); })}</tbody>
          </table>
        </>
      )}
    </div>
  );
}
