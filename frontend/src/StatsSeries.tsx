import { useEffect, useMemo, useRef, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, caseName, download, fmt, toCsv, type Project, type ProjectCase, type Run, type RunSeriesFile,
         type Series, type SeriesStat, type StatsFile } from "./api";
import Plot from "./Plot";
import { caseColor, type PlotStyle } from "./PlotStyle";
import { newestFirst, runSeriesFiles, runStamp } from "./results";

const KEY = "mstar_post.statsseries";

// v once it has been unchanged for ms (typed numbers must not fire a request per keystroke)
export function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => { const id = setTimeout(() => setD(v), ms); return () => clearTimeout(id); }, [v, ms]);
  return d;
}
type CaseStats = Record<string, Record<string, SeriesStat>>;  // case id -> column -> statistics
// One plotted column of one case. Columns asked for in one request share their time array; a column
// added later comes with its own (long series are decimated per request, so the times can differ).
type TV = { t: number[]; v: (number | null)[] };
const sameTimes = (a: number[], b: number[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

// One file (M-Star Stats or a job's per-case time-series CSV), one or more variables over time,
// for one case or (multi) several cases drawn together, one subplot per variable.
// src is "stats" or "run:<run name>".
export default function StatsSeries({ project, cases, style, onSelect, multi, runs: runFilter, storeKey, active = true }: {
  project: Project; cases?: ProjectCase[]; style?: PlotStyle;
  onSelect?: (caseId: string, file: string, src: string) => void;
  multi?: boolean;             // several cases on one figure
  runs?: Run[];                // restrict "App script outputs" to these runs (e.g. one job type)
  storeKey?: string;           // separate saved state per use
  active?: boolean;            // shown (the view stays mounted while hidden): the run list is read again when it turns true
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
  // series per case and column of the file `of` (source, file and the state of its runs); what is there
  // stays on screen while added columns or cases are loaded
  const [data, setData] = useState<{ of: string; d: Record<string, Record<string, TV>> }>({ of: "", d: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // the cases drawn: all valid chosen ones (multi) or exactly one; the first is the "primary" for file lists
  const chosen = list.filter((x) => caseIds.includes(x.id));
  const sel: ProjectCase[] = multi
    ? (chosen.length ? chosen : list.slice(0, Math.min(4, list.length)))
    : [chosen[0] ?? list.find((x) => x.id === project.ref_case) ?? list[0]].filter(Boolean);
  const c = sel[0];
  const selKey = sel.map((x) => x.id).join("|");
  // newest results first: a run made again counts with its new time
  const filterKey = runFilter?.map((x) => x.name).join("|");
  const runs = useMemo(() => newestFirst(runFilter ? allRuns.filter((r) => runFilter.some((x) => x.name === r.name)) : allRuns),
    [allRuns, filterKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
  }, [store, selKey, src, file, cols, tFrom, tTo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (c && files.some((f) => f.file === file)) onSelect?.(c.id, file, src); },
    [c?.id, file, src, files.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // jobs with per-case time-series CSVs (e.g. ua.csv of the heat-transfer task): the run list is read
  // on every show, the file lists come from the shared per-run cache and arrive in one update
  useEffect(() => {
    if (!active) return;
    let live = true;
    api.runs(project.id).then((rs) => {
      if (!live) return;
      const same = (a: Run, b: Run) => runStamp(a) === runStamp(b) && a.status === b.status && a.label === b.label;
      setAllRuns((old) => (old.length === rs.length && old.every((r, i) => same(r, rs[i])) ? old : rs));
      setRunsReady(true);
      const need = runFilter ? rs.filter((r) => runFilter.some((x) => x.name === r.name)) : rs;
      Promise.all(need.map((r) => runSeriesFiles(project.id, r).catch(() => [] as RunSeriesFile[]).then((fs) => [r.name, fs] as const)))
        .then((got) => live && setRunFiles((m) => {
          const next = { ...m, ...Object.fromEntries(got) };
          return JSON.stringify(next) === JSON.stringify(m) ? m : next;
        }));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [project.id, active, filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!c) return;
    let live = true;
    setError(null);
    setStatsFiles([]);
    api.stats(c.path).then((fs) => live && setStatsFiles(fs)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [c?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep source, file and variables valid for the current cases
  const runsLoaded = runsReady && runs.every((r) => runFiles[r.name]);
  useEffect(() => {
    if (!runOf || !runsLoaded || runOptions.some((r) => r.name === runOf)) return;
    // the chosen run has nothing for these cases; in a job-type view another run of the group may have
    setSrc(runFilter && runOptions[0] ? `run:${runOptions[0].name}` : "stats");
  }, [runOf, runsLoaded, runFilter ? selKey : c?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // a job-type view starts on that job's outputs
  useEffect(() => {
    if (runFilter && src === "stats" && !saved.src && runsLoaded && runOptions[0]) setSrc(`run:${runOptions[0].name}`);
  }, [runsLoaded, runOptions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const filesKey = `${src}|${file}|${files.map((f) => f.file).join("|")}`;
  useEffect(() => {
    if (!files.length) return;
    const f = files.find((x) => x.file === file) ?? (runOf ? undefined : files.find((x) => x.file === "Fluid.txt")) ?? files[0];
    if (f.file !== file) setFile(f.file);
    setCols((cs) => {
      const ok = cs.filter((x) => f.columns.includes(x));
      return ok.length === cs.length && ok.length ? cs : ok.length ? ok : [f.columns.find((x) => /energy dissipation|^UA \[/i.test(x)) ?? f.columns[0]];
    });
  }, [filesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns = files.find((f) => f.file === file)?.columns ?? [];
  const words = varFilter.toLowerCase().split(/\s+/).filter(Boolean);
  const choices = columns.filter((x) => !cols.includes(x) && words.every((w) => x.toLowerCase().includes(w)));
  // job-type view: (run, cases) to ask, newest run first; a case takes the first run that has the file for it
  const groupPicks = (ids: string[]) => {
    const todo = new Set(ids);
    return group.flatMap((r) => {
      const have = (runFiles[r.name] ?? []).find((f) => f.file === file)?.cases ?? [];
      const mine = ids.filter((id) => todo.has(id) && have.includes(id));
      mine.forEach((id) => todo.delete(id));
      return mine.length ? [[r.name, mine] as const] : [];
    });
  };
  // what the loaded series belong to: source, file and the state of the runs behind it (a run made again is read again)
  const dataOf = `${src}|${file}|${group.map(runStamp).join(",")}`;
  const groupReady = !runFilter || !runOf || runsLoaded;  // job-type view: which run holds a case is only known with all file lists
  // Only the columns and cases that are not there yet are requested, in one request per case (Stats
  // files) or run; the answers of one pass arrive in one update.
  const asked = useRef({ of: "", keys: new Set<string>() });
  const pend = useRef(0);
  useEffect(() => {
    if (asked.current.of !== dataOf) asked.current = { of: dataOf, keys: new Set() };
    const want = cols.filter((x) => columns.includes(x));
    if (!sel.length || !want.length || !groupReady) return;
    const done = asked.current.keys, of = dataOf;
    const need = sel.map((x) => [x, want.filter((col) => !done.has(`${x.id}\n${col}`))] as const).filter(([, miss]) => miss.length);
    if (!need.length) return;
    need.forEach(([x, miss]) => miss.forEach((col) => done.add(`${x.id}\n${col}`)));
    // cases missing the same columns go into one run request
    const bySet = (ids: string[]) => {
      const g = new Map<string, { cols: string[]; ids: string[] }>();
      for (const [x, miss] of need) if (ids.includes(x.id)) {
        const k = miss.join("\n");
        if (!g.has(k)) g.set(k, { cols: miss, ids: [] });
        g.get(k)!.ids.push(x.id);
      }
      return [...g.values()];
    };
    const ids = need.map(([x]) => x.id);
    const fail = (e: Error) => { if (asked.current.of === of) setError(e.message); return {} as Record<string, Series>; };
    const jobs: Promise<Record<string, Series>>[] = runOf
      ? (runFilter ? groupPicks(ids) : [[runOf, ids] as const]).flatMap(([rn, cs]) =>
          bySet(cs).map((g) => api.runSeries(project.id, rn, file, g.cols, g.ids).catch(runFilter ? () => ({}) : fail)))
      : need.map(([x, miss]) => api.series(x.path, file, miss).then((s) => ({ [x.id]: s })).catch(() => ({})));
    pend.current++;
    setBusy(true);
    setError(null);
    Promise.all(jobs).then((parts) => {
      if (--pend.current === 0) setBusy(false);
      if (asked.current.of !== of) return;  // answers for a file that was left meanwhile
      setData((old) => {
        const d = old.of === of ? { ...old.d } : {};
        for (const p of parts) for (const [id, s] of Object.entries(p)) {
          d[id] = { ...d[id] };
          for (const [col, v] of Object.entries(s.columns)) d[id][col] = { t: s.t, v };
        }
        return { of, d };
      });
    });
  }, [selKey, dataOf, cols.join("|"), columns.length, groupReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Window statistics come from the server, computed on every sample of the full series (the plotted
  // series only hold the min and max of each time bucket above 4000 rows). Typed bounds are debounced;
  // `of` and the window say what the held numbers belong to, errs = case id -> failed request.
  const fromQ = useDebounced(tFrom), toQ = useDebounced(tTo);
  const [stats, setStats] = useState<{ of: string; from: number | ""; to: number | ""; rows: CaseStats; errs: Record<string, string> } | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);
  const statsOf = dataOf;
  useEffect(() => {
    const want = cols.filter((x) => columns.includes(x));
    if (!sel.length || !want.length || (fromQ !== "" && toQ !== "" && fromQ > toQ)) { setStats(null); setStatsBusy(false); return; }
    setStatsBusy(true);
    if (!groupReady) return;
    let live = true;
    const ids = sel.map((x) => x.id);
    const from = fromQ === "" ? undefined : fromQ, to = toQ === "" ? undefined : toQ;
    const part = (p: Promise<CaseStats>, cs: string[]) => p.then((rows) => ({ rows, errs: {} as Record<string, string> }),
      (e: Error) => ({ rows: {} as CaseStats, errs: Object.fromEntries(cs.map((id) => [id, e.message])) }));
    const parts = runOf
      ? (runFilter ? groupPicks(ids) : [[runOf, ids] as const]).map(([rn, cs]) => part(api.runSeriesStats(project.id, rn, file, want, cs, from, to), cs))
      : sel.map((x) => part(api.seriesStats(x.path, file, want, from, to).then((r) => ({ [x.id]: r.stats })), [x.id]));
    Promise.all(parts).then((ps) => {
      if (!live) return;
      setStats({ of: statsOf, from: fromQ, to: toQ, rows: Object.assign({}, ...ps.map((p) => p.rows)), errs: Object.assign({}, ...ps.map((p) => p.errs)) });
      setStatsBusy(false);
    });
    return () => { live = false; };
  }, [selKey, dataOf, cols.join("|"), columns.length, groupReady, fromQ, toQ]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // the cases that have a series of at least one shown variable (series of another file are not shown)
  const loaded = data.of === dataOf ? data.d : {};
  const series = sel.map((x) => [x.id, loaded[x.id]] as const)
    .filter((p): p is readonly [string, Record<string, TV>] => !!p[1] && cols.some((col) => (p[1]![col]?.t.length ?? 0) > 0));
  const spans = series.flatMap(([, s]) => cols.map((col) => s[col]).filter((x): x is TV => !!x && x.t.length > 0));
  const t0 = spans.length ? Math.min(...spans.map((x) => x.t[0])) : 0;
  const t1 = spans.length ? Math.max(...spans.map((x) => x.t[x.t.length - 1])) : 0;
  const a = tFrom === "" ? t0 : tFrom, b = tTo === "" ? t1 : tTo;
  const lastFrac = (f: number) => { setTFrom(Number((t1 - f * (t1 - t0)).toPrecision(4))); setTTo(""); };
  // statistics of another source/file are never shown; those of another window, or while a request runs, greyed
  const held = stats && stats.of === statsOf ? stats : null;
  const statsStale = statsBusy || !held || held.from !== tFrom || held.to !== tTo;
  const statOf = (id: string, col: string): SeriesStat | undefined => held?.rows[id]?.[col];
  const [wa, wb] = held ? [held.from === "" ? t0 : held.from, held.to === "" ? t1 : held.to] : [a, b];
  const covOf = (s: SeriesStat) => (s.mean && s.std !== null ? s.std / Math.abs(s.mean) : null);
  const statsError = series.map(([id]) => held?.errs[id]).find(Boolean);
  // the moving average runs over the plotted points: say so when the server counted more samples than were plotted
  const avgDecimated = win > 0 && !!held && series.some(([id, d]) => cols.some((x) => {
    const s = held.rows[id]?.[x], tv = d[x];
    if (!s || !tv) return false;
    let got = 0;
    for (let i = 0; i < tv.v.length; i++) if (tv.v[i] !== null && tv.t[i] >= wa && tv.t[i] <= wb) got++;
    return s.n > got;
  }));
  const colorOf = (id: string) => style ? caseColor(style, id, project.cases.findIndex((x) => x.id === id)) : undefined;
  const title = multi && sel.length > 1 ? `${sel.length} cases: ${file}` : `${c ? caseName(project, c.id) : ""}: ${file}`;
  // The figure is rebuilt only when its inputs change: renders for the statistics requests or a filter
  // being typed must not make Plot redraw every trace. Mean lines (one case) only for up-to-date statistics.
  const means = series.length === 1 && !statsStale ? cols.map((x) => statOf(series[0][0], x)?.mean ?? null) : [];
  const plotData = useMemo(() => cols.flatMap((x, i) => series.flatMap(([id, d]) => (d[x] ? [{
    type: "scattergl" as const, mode: "lines" as const, name: caseName(project, id), legendgroup: id,
    showlegend: i === 0 && series.length > 1, x: d[x].t, y: smooth(d[x].t, d[x].v),
    yaxis: i ? `y${i + 1}` : "y", line: colorOf(id) ? { color: colorOf(id) } : undefined,
  }] : []))), [data, dataOf, selKey, cols.join("|"), win, style, project]); // eslint-disable-line react-hooks/exhaustive-deps
  // wide CSV: one row per case and time. Columns that came with different time arrays (a column added
  // later to a long, decimated series) are merged by time, blank where a column has no point there.
  const seriesCsv = () => toCsv(["case", "time [s]", ...cols], series.flatMap(([id, d]) => {
    const have = cols.map((x) => d[x]), first = have.find(Boolean);
    if (!first) return [];
    if (have.every((x) => !x || sameTimes(x.t, first.t))) return first.t.map((t, i) => [id, t, ...have.map((x) => x?.v[i] ?? null)]);
    const byT = new Map<number, (number | null)[]>();
    have.forEach((x, k) => x?.t.forEach((t, i) => {
      if (!byT.has(t)) byT.set(t, new Array<number | null>(cols.length).fill(null));
      byT.get(t)![k] = x.v[i];
    }));
    return [...byT.keys()].sort((p, q) => p - q).map((t) => [id, t, ...byT.get(t)!]);
  }));
  const plotLayout = useMemo(() => ({
    // title pinned to the container top; the legend sits between it and the plot (one line per ~4 cases)
    title: { text: title, yref: "container" as const, y: 1, yanchor: "top" as const, pad: { t: 8 } }, showlegend: series.length > 1,
    legend: { orientation: "h" as const, x: 0, xanchor: "left" as const, y: 1.0, yanchor: "bottom" as const },
    margin: { t: 40 + (series.length > 1 ? 24 * Math.ceil(series.length / 4) + 8 : 0), r: 20, b: 50, l: 70 },
    shapes: [
      { type: "rect" as const, xref: "x" as const, yref: "paper" as const, x0: a, x1: b, y0: 0, y1: 1,
        fillcolor: "rgba(96,165,250,0.12)", line: { width: 0 }, layer: "below" as const },
      ...means.flatMap((m, i) => (m === null ? [] : [{ type: "line" as const, xref: "x" as const, yref: (i ? `y${i + 1}` : "y") as Plotly.YAxisName,
        x0: a, x1: b, y0: m, y1: m, line: { color: "#ef4444", dash: "dot" as const, width: 1.5 } }])),
    ],
    xaxis: { title: { text: "Time [s]" }, anchor: cols.length > 1 ? `y${cols.length}` : "y" } as Partial<Plotly.LayoutAxis>,
    ...Object.fromEntries(cols.map((x, i) => [i ? `yaxis${i + 1}` : "yaxis", {
      title: { text: x, font: { size: 11 } },
      domain: [1 - (i + 1) / cols.length + (i < cols.length - 1 ? 0.03 : 0), 1 - i / cols.length - (i ? 0.03 : 0)],
    }])),
  }), [title, series.length, a, b, cols.join("|"), means.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
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
            // another file, also of the same run: start on its first variable (the old ones do not exist in it)
            const i = e.target.value.indexOf("|"), rn = e.target.value.slice(0, i), fn = e.target.value.slice(i + 1);
            const f = (runFiles[rn] ?? []).find((x) => x.file === fn);
            setSrc(`run:${rn}`);
            setFile(fn);
            if (f) setCols([f.columns[0]]);
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
        <label title="moving average over the preceding window of simulated time; smooths the plotted curves only (the statistics table and the mean lines use every raw sample)">
          Avg [s] <input type="number" step="any" className="short" value={win || ""} placeholder="off"
                              onChange={(e) => setWin(Number(e.target.value))} /></label>
        {series.length > 0 && <button onClick={() => download(`${file.replace(/\.(txt|csv)$/, "")}_${series.length === 1 ? series[0][0].replace(/\//g, "_") : `${series.length}_cases`}.csv`,
          seriesCsv())}>Export CSV</button>}
      </div>
      {error && <div className="error">{error}</div>}
      {!busy && groupReady && cols.length > 0 && sel.length > series.length && <div className="small muted">No data of {file} for {sel.filter((x) => !series.some(([id]) => id === x.id)).map((x) => caseName(project, x.id)).join(", ")}.</div>}
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
            data={plotData} layout={plotLayout} />
          {avgDecimated && <div className="small muted">Moving average: computed on the plotted points (long series are drawn with the min and max
            of each time bucket), not on every sample; the statistics below use every sample.</div>}
          <div className="row small">
            <span className="muted">Statistics from every sample of the full series, computed by the server{statsStale && a < b ? " (updating...)" : ""}.</span>
            <button disabled={statsStale} onClick={() => download(`${file.replace(/\.(txt|csv)$/, "")}_${series.length === 1 ? series[0][0].replace(/\//g, "_") : `${series.length}_cases`}_statistics.csv`,
              toCsv(["case", "variable", "from [s]", "to [s]", "mean", "std", "CoV", "min", "max", "n", "last"], cols.flatMap((x) => series.flatMap(([id]) => {
                const s = statOf(id, x);
                return s ? [[id, x, wa, wb, s.mean, s.std, covOf(s), s.min, s.max, s.n, s.last]] : [];
              }))))}>Statistics CSV</button>
          </div>
          {statsError && <div className="error">statistics: {statsError}</div>}
          <div className="scroll-x">
          <table className="grid narrow">
            <thead><tr>{series.length > 1 && <th>case</th>}<th>variable</th><th>mean ({fmt(wa)} to {fmt(wb)} s)</th><th>std</th><th>CoV</th><th>min</th><th>max</th>
              <th>n</th><th>last</th></tr></thead>
            <tbody style={statsStale ? { opacity: 0.45 } : undefined}>{cols.flatMap((x) => series.map(([id]) => {
              const s = statOf(id, x), na = statsStale && a < b && !held?.errs[id] ? "..." : ""; return (
              <tr key={`${x}|${id}`} className={id === project.ref_case ? "refrow" : ""}>{series.length > 1 && <td className="mono" title={id}>{caseName(project, id)}</td>}
                <td>{x}</td><td className="num">{s ? fmt(s.mean) : na}</td><td className="num">{s ? fmt(s.std) : na}</td>
                <td className="num">{s ? fmt(covOf(s)) : na}</td>
                <td className="num">{s ? fmt(s.min) : na}</td><td className="num">{s ? fmt(s.max) : na}</td>
                <td className="num">{s ? s.n : na}</td><td className="num">{s ? fmt(s.last) : na}</td></tr>); }))}</tbody>
          </table>
          </div>
        </>
      )}
    </div>
  );
}
