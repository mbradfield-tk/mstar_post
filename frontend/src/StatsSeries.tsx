import { useEffect, useMemo, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, caseName, download, fmt, toCsv, type Project, type ProjectCase, type Run, type RunSeriesFile,
         type Series, type StatsFile } from "./api";
import Plot from "./Plot";
import { caseColor, type PlotStyle } from "./PlotStyle";

const KEY = "mstar_post.statsseries";

// One file (M-Star Stats or a job's per-case time-series CSV), one or more variables over time,
// for one case or (multi) several cases drawn together, one subplot per variable.
// src is "stats" or "run:<run name>".
export default function StatsSeries({ project, cases, style, onSelect, multi, runs: runFilter, storeKey }: {
  project: Project; cases?: ProjectCase[]; style?: PlotStyle;
  onSelect?: (caseId: string, file: string, src: string) => void;
  multi?: boolean;             // several cases on one figure
  runs?: Run[];                // restrict "App script outputs" to these runs (e.g. one job type)
  storeKey?: string;           // separate saved state per use
}) {
  // selected (included) cases of the project unless the caller passes a list; all cases if none is selected
  const included = project.cases.filter((c) => c.included);
  const list = cases?.length ? cases : included.length ? included : project.cases;
  const store = `${KEY}.${project.id}${storeKey ? `.${storeKey}` : ""}`;
  const saved = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(store) ?? "{}"); } catch { return {}; }
  }, [store]);
  const [caseIds, setCaseIds] = useState<string[]>(saved.caseIds ?? (saved.caseId ? [saved.caseId] : []));
  const [src, setSrc] = useState<string>(saved.src ?? "stats");
  const [file, setFile] = useState<string>(saved.file ?? "Fluid.txt");
  const [cols, setCols] = useState<string[]>(saved.cols ?? []);
  const [win, setWin] = useState<number>(0);
  const [varFilter, setVarFilter] = useState("");
  // averaging window [s]; "" = start / end of the run
  const [tFrom, setTFrom] = useState<number | "">(saved.tFrom ?? "");
  const [tTo, setTTo] = useState<number | "">(saved.tTo ?? "");
  const [statsFiles, setStatsFiles] = useState<StatsFile[]>([]);
  const [allRuns, setAllRuns] = useState<Run[]>([]);
  const [runsReady, setRunsReady] = useState(false);
  const [runFiles, setRunFiles] = useState<Record<string, RunSeriesFile[]>>({});
  const [data, setData] = useState<Record<string, Series> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // the cases drawn: all valid chosen ones (multi) or exactly one; the first is the "primary" for file lists
  const chosen = list.filter((x) => caseIds.includes(x.id));
  const sel: ProjectCase[] = multi
    ? (chosen.length ? chosen : list.slice(0, Math.min(4, list.length)))
    : [chosen[0] ?? list.find((x) => x.id === project.ref_case) ?? list[0]].filter(Boolean);
  const c = sel[0];
  const runs = runFilter ? allRuns.filter((r) => runFilter.some((x) => x.name === r.name)) : allRuns;
  const runOf = src.startsWith("run:") ? src.slice(4) : null;
  // in a job-type view (runFilter) the chosen run stands for the whole group: cases are fetched
  // from whichever run of the group holds the file, so every case of the project can be drawn
  const group = runFilter && runOf ? runs : runOf ? runs.filter((r) => r.name === runOf) : [];
  const anySel = (f: RunSeriesFile) => sel.some((x) => f.cases.includes(x.id));
  const runOptions = runs.filter((r) => (runFiles[r.name] ?? []).some((f) => (runFilter ? anySel(f) : c && f.cases.includes(c.id))));
  const files: StatsFile[] = runOf
    ? (runFilter
        ? [...new Map(group.flatMap((r) => runFiles[r.name] ?? []).filter(anySel).map((f) => [f.file, { file: f.file, columns: f.columns }])).values()]
        : (runFiles[runOf] ?? []).filter((f) => c && f.cases.includes(c.id)).map(({ file: f, columns: cs }) => ({ file: f, columns: cs })))
    : statsFiles;

  useEffect(() => {
    localStorage.setItem(store, JSON.stringify({ caseIds: sel.map((x) => x.id), src, file, cols, tFrom, tTo }));
  }, [store, sel.map((x) => x.id).join("|"), src, file, cols, tFrom, tTo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (c && files.some((f) => f.file === file)) onSelect?.(c.id, file, src); },
    [c?.id, file, src, files.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // jobs with per-case time-series CSVs (e.g. ua.csv of the heat-transfer task)
  useEffect(() => {
    api.runs(project.id).then((rs) => {
      setAllRuns(rs);
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
  // a job-type view starts on that job's outputs
  useEffect(() => {
    if (runFilter && src === "stats" && !saved.src && runsLoaded && runOptions[0]) setSrc(`run:${runOptions[0].name}`);
  }, [runsLoaded, runOptions.length]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const selKey = sel.map((x) => x.id).join("|");
  useEffect(() => {
    setData(null);
    const want = cols.filter((x) => columns.includes(x));
    if (!sel.length || !want.length) return;
    let live = true;
    const ids = sel.map((x) => x.id);
    const load: Promise<Record<string, Series>> = runOf
      ? (runFilter
          // newest run first; a case takes the first run that has the file for it
          ? (() => {
              const todo = new Set(ids);
              const picks = group.flatMap((r) => {
                const have = (runFiles[r.name] ?? []).find((f) => f.file === file)?.cases ?? [];
                const mine = ids.filter((id) => todo.has(id) && have.includes(id));
                mine.forEach((id) => todo.delete(id));
                return mine.length ? [[r.name, mine] as const] : [];
              });
              return Promise.all(picks.map(([rn, cs]) => api.runSeries(project.id, rn, file, want, cs).catch(() => ({}))))
                .then((parts) => Object.assign({}, ...parts) as Record<string, Series>);
            })()
          : api.runSeries(project.id, runOf, file, want, ids))
      : Promise.all(sel.map((x) => api.series(x.path, file, want).then((d) => [x.id, d] as const).catch(() => null)))
          .then((rs) => Object.fromEntries(rs.filter((r): r is readonly [string, Series] => !!r)));
    load.then((d) => live && setData(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [selKey, src, file, cols.join("|"), columns.length, runFilter ? Object.keys(runFiles).length : 0]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const series = sel.map((x) => [x.id, data?.[x.id]] as const).filter((p): p is readonly [string, Series] => !!p[1] && p[1].t.length > 0);
  const t0 = series.length ? Math.min(...series.map(([, d]) => d.t[0])) : 0;
  const t1 = series.length ? Math.max(...series.map(([, d]) => d.t[d.t.length - 1])) : 0;
  const a = tFrom === "" ? t0 : tFrom, b = tTo === "" ? t1 : tTo;
  const lastFrac = (f: number) => { setTFrom(Number((t1 - f * (t1 - t0)).toPrecision(4))); setTTo(""); };
  const stat = (d: Series, v: (number | null)[]) => {
    const all = v.filter((y): y is number => y !== null);
    const x = v.filter((y, i): y is number => y !== null && d.t[i] >= a && d.t[i] <= b);
    if (!x.length) return null;
    const mean = x.reduce((p, q) => p + q, 0) / x.length;
    const std = Math.sqrt(x.reduce((p, q) => p + (q - mean) ** 2, 0) / Math.max(1, x.length - 1));
    return { min: Math.min(...x), max: Math.max(...x), mean, std, n: x.length, last: all[all.length - 1] };
  };
  const colorOf = (id: string) => style ? caseColor(style, id, project.cases.findIndex((x) => x.id === id)) : undefined;
  const title = multi && sel.length > 1 ? `${sel.length} cases: ${file}` : `${c ? caseName(project, c.id) : ""}: ${file}`;
  if (!list.length) return <div className="muted">No cases in this project.</div>;

  return (
    <div>
      <div className="row small">
        {multi ? (
          <details className="colpick">
            <summary><b>Cases ({sel.length}/{list.length})</b> <span className="muted">{sel.map((x) => caseName(project, x.id)).join(", ").slice(0, 60)}{sel.map((x) => caseName(project, x.id)).join(", ").length > 60 ? "…" : ""}</span></summary>
            <div className="row small">
              <button className="small" onClick={() => setCaseIds(list.map((x) => x.id))}>all</button>
              <button className="small" onClick={() => setCaseIds([list[0].id])}>first only</button>
            </div>
            <div className="checklist">
              {list.map((x) => <label key={x.id} className="small" title={x.id}><input type="checkbox" checked={sel.some((s) => s.id === x.id)}
                onChange={(e) => setCaseIds(e.target.checked ? [...sel.map((s) => s.id), x.id] : sel.map((s) => s.id).filter((i) => i !== x.id))} />{caseName(project, x.id)}</label>)}
            </div>
          </details>
        ) : (
          <label>Case <select value={c?.id} onChange={(e) => setCaseIds([e.target.value])}>
            {list.map((x) => <option key={x.id} value={x.id}>{caseName(project, x.id)}</option>)}</select></label>
        )}
        <label>Source <select value={runOf ? "jobs" : "stats"} onChange={(e) => {
          if (e.target.value === "stats") { setSrc("stats"); return; }
          if (runOptions[0]) setSrc(`run:${runOptions[0].name}`);
        }}>
          <option value="stats">M-Star Stats</option>
          <option value="jobs" disabled={!runOptions.length}>App script outputs{runOptions.length ? "" : multi ? " (none for these cases)" : " (none for this case)"}</option>
        </select></label>
        {runOf && runFilter ? (
          <label>File <select value={file} onChange={(e) => { setFile(e.target.value); const f = files.find((x) => x.file === e.target.value); if (f) setCols([f.columns[0]]); }}>
            {!files.some((f) => f.file === file) && <option value={file}>{file}</option>}
            {files.map((f) => <option key={f.file}>{f.file}</option>)}</select></label>
        ) : runOf ? (
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
        <label title="moving average over the preceding window of simulated time; smooths turbulent traces (plot and statistics)">
          Avg [s] <input type="number" step="any" className="short" value={win || ""} placeholder="off"
                              onChange={(e) => setWin(Number(e.target.value))} /></label>
        {series.length > 0 && <button onClick={() => download(`${file.replace(/\.(txt|csv)$/, "")}_${series.length === 1 ? series[0][0].replace(/\//g, "_") : `${series.length}_cases`}.csv`,
          toCsv(["case", "time [s]", ...cols], series.flatMap(([id, d]) => d.t.map((t, i) => [id, t, ...cols.map((x) => d.columns[x]?.[i] ?? null)]))))}>Export CSV</button>}
      </div>
      {error && <div className="error">{error}</div>}
      {data && sel.length > series.length && <div className="small muted">No data of {file} for {sel.filter((x) => !series.some(([id]) => id === x.id)).map((x) => caseName(project, x.id)).join(", ")}.</div>}
      {series.length > 0 && (
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
      {series.length > 0 && cols.length > 0 && (
        <>
          <Plot exportName={`${title.replace(/[^\w.-]+/g, "_")}`} style={style}
            height={Math.round((Math.max(320, 200 * cols.length + 80) + (series.length > 1 ? 24 * Math.ceil(series.length / 4) : 0)) * (style?.heightScale ?? 1))}
            data={cols.flatMap((x, i) => series.map(([id, d]) => ({
              type: "scattergl" as const, mode: "lines" as const, name: caseName(project, id), legendgroup: id,
              showlegend: i === 0 && series.length > 1, x: d.t, y: smooth(d.t, d.columns[x] ?? []),
              yaxis: i ? `y${i + 1}` : "y", line: colorOf(id) ? { color: colorOf(id) } : undefined,
            })))}
            layout={{
              // title pinned to the container top; the legend sits between it and the plot (one line per ~4 cases)
              title: { text: title, yref: "container", y: 1, yanchor: "top", pad: { t: 8 } }, showlegend: series.length > 1,
              legend: { orientation: "h", x: 0, xanchor: "left", y: 1.0, yanchor: "bottom" },
              margin: { t: 40 + (series.length > 1 ? 24 * Math.ceil(series.length / 4) + 8 : 0), r: 20, b: 50, l: 70 },
              shapes: [
                { type: "rect", xref: "x", yref: "paper", x0: a, x1: b, y0: 0, y1: 1,
                  fillcolor: "rgba(96,165,250,0.12)", line: { width: 0 }, layer: "below" },
                ...(series.length === 1 ? cols.flatMap((x, i) => {
                  const s = stat(series[0][1], series[0][1].columns[x] ?? []);
                  return s ? [{ type: "line" as const, xref: "x" as const, yref: (i ? `y${i + 1}` : "y") as Plotly.YAxisName,
                    x0: a, x1: b, y0: s.mean, y1: s.mean, line: { color: "#ef4444", dash: "dot" as const, width: 1.5 } }] : [];
                }) : []),
              ],
              xaxis: { title: { text: "Time [s]" }, anchor: cols.length > 1 ? `y${cols.length}` : "y" } as Partial<Plotly.LayoutAxis>,
              ...Object.fromEntries(cols.map((x, i) => [i ? `yaxis${i + 1}` : "yaxis", {
                title: { text: x, font: { size: 11 } },
                domain: [1 - (i + 1) / cols.length + (i < cols.length - 1 ? 0.03 : 0), 1 - i / cols.length - (i ? 0.03 : 0)],
              }])),
            }} />
          <div className="scroll-x">
          <table className="grid narrow">
            <thead><tr>{series.length > 1 && <th>case</th>}<th>variable</th><th>mean ({fmt(a)} to {fmt(b)} s)</th><th>std</th><th>CoV</th><th>min</th><th>max</th>
              <th>n</th><th>last</th></tr></thead>
            <tbody>{cols.flatMap((x) => series.map(([id, d]) => { const s = stat(d, d.columns[x] ?? []); return (
              <tr key={`${x}|${id}`} className={id === project.ref_case ? "refrow" : ""}>{series.length > 1 && <td className="mono" title={id}>{caseName(project, id)}</td>}
                <td>{x}</td><td className="num">{fmt(s?.mean)}</td><td className="num">{fmt(s?.std)}</td>
                <td className="num">{s && s.mean ? fmt(s.std / Math.abs(s.mean)) : ""}</td>
                <td className="num">{fmt(s?.min)}</td><td className="num">{fmt(s?.max)}</td>
                <td className="num">{s?.n ?? 0}</td><td className="num">{fmt(s?.last)}</td></tr>); }))}</tbody>
          </table>
          </div>
        </>
      )}
    </div>
  );
}
