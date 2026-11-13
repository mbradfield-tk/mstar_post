import { useEffect, useMemo, useRef, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, caseName, download, fmt, toCsv, type Project, type Run, type StatsFile, type VarEntry } from "./api";
import Plot from "./Plot";
import { caseColor, type PlotStyle } from "./PlotStyle";
import { pct, PCT_HELP, runHasCases, runStamp, selectedCaseIds } from "./results";

type Kind = "stats" | "series" | "table" | "long";
const KIND_LABEL: Record<Kind, string> = {
  stats: "M-Star Stats time series", series: "App script time series", table: "Result table", long: "Steady-state mean",
};
// one variable in one place; paths: case id -> file (per-case files) or "" -> the run-level file;
// low = lower-case text the search words are matched against
type Hit = { key: string; kind: Kind; variable: string; file: string; srcFile?: string; run?: Run;
             cases: string[]; paths: Map<string, string>; low: string };

export default function VariableSearch({ project, style, refCase, onPlotSeries, active = true }: {
  project: Project; style: PlotStyle; refCase: string;
  onPlotSeries: (src: string, file: string, col: string) => void;
  active?: boolean;  // shown: the mode stays mounted while another one is shown
}) {
  const store = `mstar_post.varsearch.${project.id}`;
  const [query, setQuery] = useState(() => localStorage.getItem(store) ?? "");
  useEffect(() => localStorage.setItem(store, query), [store, query]);
  const [kinds, setKinds] = useState<Kind[]>(["stats", "series", "table", "long"]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [entries, setEntries] = useState<VarEntry[] | null>(null);
  const [stats, setStats] = useState<Record<string, { file: string; columns: string[] }[]>>({});
  const [open, setOpen] = useState<Hit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selIds = selectedCaseIds(project);
  const selKey = [...selIds].join("|");
  const selCases = project.cases.filter((c) => selIds.has(c.id));

  // the run list, and the index of their variables whenever the runs changed (first show, a job finished
  // or was made again while another mode or tab was shown)
  const runsKey = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    api.runs(project.id).then((rs) => {
      const key = rs.map(runStamp).join("|");
      if (key === runsKey.current) return;
      runsKey.current = key;
      setRuns(rs);
      setError(null);
      api.variables(project.id).then(setEntries).catch((e) => setError(e.message));
    }).catch((e) => setError(e.message));
  }, [project.id, active]);
  useEffect(() => {
    const todo = selCases.filter((c) => !stats[c.id]);
    if (!todo.length) return;
    // one state update for all cases
    Promise.all(todo.map((c) => api.stats(c.path).catch(() => [] as StatsFile[]).then((fs) => [c.id, fs] as const)))
      .then((got) => setStats((m) => ({ ...m, ...Object.fromEntries(got) })));
  }, [selKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const hits = useMemo(() => {
    const out = new Map<string, Hit>();
    const seen = new Map<string, Set<string>>();
    const add = (key: string, h: Omit<Hit, "key" | "cases" | "paths" | "low">, cid: string | null, path: string) => {
      let e = out.get(key);
      if (!e) {
        e = { ...h, key, cases: [], paths: new Map(), low: `${h.variable} ${h.file} ${h.srcFile ?? ""}`.toLowerCase() };
        out.set(key, e);
        seen.set(key, new Set());
      }
      if (cid && !seen.get(key)!.has(cid)) { seen.get(key)!.add(cid); e.cases.push(cid); }
      e.paths.set(cid ?? "", path);
      return e;
    };
    for (const c of selCases) for (const f of stats[c.id] ?? []) for (const col of f.columns)
      add(`stats|${f.file}|${col}`, { kind: "stats", variable: col, file: f.file }, c.id, f.file);
    const byName = new Map(runs.filter((r) => runHasCases(r, selIds)).map((r) => [r.name, r]));
    for (const e of entries ?? []) {
      const run = byName.get(e.run);
      if (!run) continue;
      if (e.case) {
        // a file in a case folder: the same file of every selected case is one hit, also the per-case
        // long tables (<case>/stats_summary.csv has no case column: the folder says which case it is)
        if (!selIds.has(e.case)) continue;
        const rel = e.path.startsWith(`${e.case}/`) ? e.path.slice(e.case.length + 1) : e.path;
        for (const col of e.columns) {
          const [v, src] = Array.isArray(col) ? col : [col, ""];
          if (e.kind === "long") add(`long|${e.run}|${rel}|${v}|${src}`, { kind: "long", variable: v, file: rel, srcFile: src || undefined, run }, e.case, e.path);
          else add(`${e.kind}|${e.run}|${rel}|${v}`, { kind: e.kind, variable: v, file: rel, run }, e.case, e.path);
        }
        continue;
      }
      const cs = e.cases.filter((id) => selIds.has(id));
      if (e.cases.length && !cs.length) continue;
      for (const col of e.columns) {
        const [v, src] = Array.isArray(col) ? col : [col, ""];
        const key = `${e.kind}|${e.run}|${e.path}|${v}|${src}`;
        const h = { kind: e.kind === "long" ? "long" as const : "table" as const, variable: v, file: e.path, srcFile: src || undefined, run };
        if (cs.length) cs.forEach((id) => add(key, h, id, e.path)); else add(key, h, null, e.path);
        out.get(key)!.paths = new Map([["", e.path]]);
      }
    }
    return [...out.values()];
  }, [entries, runs, stats, selKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = useMemo(() => (words.length ? hits.filter((h) => kinds.includes(h.kind) && words.every((w) => h.low.includes(w)))
    .sort((a, b) => a.variable.localeCompare(b.variable) || a.kind.localeCompare(b.kind)) : []),
    [hits, kinds, words.join(" ")]); // eslint-disable-line react-hooks/exhaustive-deps
  const MAX = 300;
  const loading = entries === null || selCases.some((c) => !stats[c.id]);
  const runLabel = (r?: Run) => r ? `${r.label ?? r.task ?? r.name} (${r.name.slice(0, 15)})` : "case folder";

  return (
    <>
      <div className="row">
        <input className="wide" autoFocus placeholder="search a variable, e.g. power number, dissipation, d32, UA ..." value={query}
               onChange={(e) => setQuery(e.target.value)} />
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <label key={k} className="small"><input type="checkbox" checked={kinds.includes(k)}
            onChange={(e) => setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} /> {KIND_LABEL[k]}</label>))}
      </div>
      <div className="small muted">
        Searches every M-Star Stats file of the {selCases.length} selected case{selCases.length === 1 ? "" : "s"} and every result table
        and time series of the jobs that include them{loading ? " (indexing...)" : ` (${hits.length.toLocaleString()} variables)`}.
        All words must match the variable or file name.
      </div>
      {error && <div className="error">{error}</div>}
      {words.length > 0 && (
        <div className="tablewrap varsearch">
          <table className="grid">
            <thead><tr><th>variable</th><th>kind</th><th>file</th><th>job</th><th>cases</th><th></th></tr></thead>
            <tbody>
              {found.slice(0, MAX).map((h) => (
                <tr key={h.key} className={open?.key === h.key ? "selected" : ""}>
                  <td><a onClick={() => setOpen(h)}>{h.variable}</a></td>
                  <td className="small">{KIND_LABEL[h.kind]}</td>
                  <td className="mono small">{h.srcFile ? `${h.srcFile} (${h.file})` : h.file}</td>
                  <td className="small">{runLabel(h.run)}</td>
                  <td className="num" title={h.cases.map((id) => caseName(project, id)).join("\n")}>{h.cases.length || ""}</td>
                  <td className="nowrap"><button className="small" onClick={() => setOpen(h)}>Show</button>{" "}
                    {(h.kind === "stats" || h.kind === "series") && (
                      <button className="small" title="add a panel with this variable to Time series"
                        onClick={() => onPlotSeries(h.kind === "stats" ? "stats" : `run:${h.run!.name}`, h.file, h.variable)}>Time series panel</button>)}</td>
                </tr>))}
              {!found.length && <tr><td colSpan={6} className="muted">{loading ? "indexing..." : "no match"}</td></tr>}
            </tbody>
          </table>
          {found.length > MAX && <div className="small muted">{found.length - MAX} more: refine the search.</div>}
        </div>
      )}
      {open && <HitView key={open.key} project={project} hit={open} style={style} refCase={refCase} onClose={() => setOpen(null)} />}
    </>
  );
}

function HitView({ project, hit, style, refCase, onClose }: {
  project: Project; hit: Hit; style: PlotStyle; refCase: string; onClose: () => void;
}) {
  // what was read (one curve per case, or one for a run-level table); the traces are built from it
  // on every change of the style, the reference case or the case names
  const [curves, setCurves] = useState<{ id: string; x: (number | string | null)[]; y: (number | null)[]; marks?: boolean }[] | null>(null);
  const [bars, setBars] = useState<{ id: string; v: number | null; std?: number | null }[] | null>(null);
  const [xTitle, setXTitle] = useState("Time [s]");
  const [error, setError] = useState<string | null>(null);
  const color = (id: string) => caseColor(style, id, project.cases.findIndex((c) => c.id === id));
  const runPath = hit.run ? `${hit.run.path}/` : "";

  useEffect(() => {
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    const go = async () => {
      if (hit.kind === "stats") {
        const ps = hit.cases.map((id) => {
          const c = project.cases.find((x) => x.id === id)!;
          return api.series(c.path, hit.paths.get(id)!, [hit.variable]).then((s) => ({ id, x: s.t, y: s.columns[hit.variable] ?? [] })).catch(() => null);
        });
        setCurves((await Promise.all(ps)).filter((t): t is NonNullable<typeof t> => !!t));
      } else if (hit.kind === "series") {
        const s = await api.runSeries(project.id, hit.run!.name, hit.file, [hit.variable], hit.cases);
        setCurves(Object.entries(s).map(([id, d]) => ({ id, x: d.t, y: d.columns[hit.variable] ?? [] })));
      } else if (hit.kind === "long") {
        // one run-level table with a case column, or the same table in the folder of every case
        const files = hit.paths.has("") ? [["", hit.file] as const] : hit.cases.filter((id) => hit.paths.has(id)).map((id) => [id, hit.paths.get(id)!] as const);
        const tables = await Promise.all(files.map(([id, f]) => api.csv(project.id, `${runPath}${f}`).then((t) => [id, t] as const)
          .catch((e) => { if (!id) throw e; return null; })));
        const out: { id: string; v: number | null; std: number | null }[] = [];
        for (const x of tables) {
          if (!x) continue;
          const [id, t] = x;
          const ix = (n: string) => t.columns.findIndex((c) => c.trim().toLowerCase() === n);
          const iC = ix("case"), iF = ix("file"), iV = ix("variable"), iM = ix("mean"), iS = ix("std");
          for (const r of t.rows) {
            if (r[iV] !== hit.variable || (iF >= 0 && String(r[iF] ?? "") !== (hit.srcFile ?? ""))) continue;
            const cid = id || (iC >= 0 ? String(r[iC]) : project.cases[0]?.id ?? "");
            if (!id && iC >= 0 && hit.cases.length && !hit.cases.includes(cid)) continue;
            out.push({ id: cid, v: num(r[iM]), std: iS >= 0 ? num(r[iS]) : null });
          }
        }
        setBars(out);
      } else if (hit.paths.has("")) {
        // run-level table without a case column: the variable against the first column
        const t = await api.csv(project.id, `${runPath}${hit.file}`);
        const j = t.columns.indexOf(hit.variable);
        setXTitle(t.columns[0]);
        setCurves([{ id: "", x: t.rows.map((r) => r[0]), y: t.rows.map((r) => num(r[j])), marks: true }]);
      } else {
        // per-case files: one value per case (single row) or the variable against the first column
        const ids = hit.cases.filter((id) => hit.paths.has(id));
        const tables = await Promise.all(ids.map((id) => api.csv(project.id, `${runPath}${hit.paths.get(id)}`).then((t) => [id, t] as const).catch(() => null)));
        const ok = tables.filter((x): x is NonNullable<typeof x> => !!x);
        if (ok.every(([, t]) => t.rows.length <= 1)) {
          setBars(ok.map(([id, t]) => ({ id, v: num(t.rows[0]?.[t.columns.indexOf(hit.variable)]) })));
        } else {
          setXTitle(ok[0]?.[1].columns[0] ?? "");
          setCurves(ok.map(([id, t]) => ({ id, x: t.rows.map((r) => r[0]), y: t.rows.map((r) => num(r[t.columns.indexOf(hit.variable)])), marks: true })));
        }
      }
    };
    // wide tables with a case column (e.g. *_means.csv): one bar per case
    const wide = async () => {
      const t = await api.csv(project.id, `${runPath}${hit.file}`);
      const j = t.columns.indexOf(hit.variable);
      setBars(t.rows.filter((r) => hit.cases.includes(String(r[0]))).map((r) => ({ id: String(r[0]), v: num(r[j]) })));
    };
    (hit.kind === "table" && hit.paths.has("") && hit.cases.length ? wide() : go()).catch((e) => setError((e as Error).message));
  }, [hit.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const order = (id: string) => project.cases.findIndex((c) => c.id === id);
  const sorted = useMemo(() => (bars ? [...bars].sort((a, b) => order(a.id) - order(b.id)) : null), [bars, project]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = sorted?.find((b) => b.id === refCase)?.v ?? null;
  const title = `${hit.variable}${hit.srcFile ? ` (${hit.srcFile})` : ""}`;
  // figures keep their identity while nothing they show changes (typing in the search box must not redraw them)
  const traces = useMemo(() => curves?.map((c): Plotly.Data => (c.id
    ? { type: c.marks ? "scatter" : "scattergl", mode: c.marks ? "lines+markers" : "lines", name: caseName(project, c.id), x: c.x, y: c.y,
        line: { color: color(c.id), width: c.id === refCase ? style.lineWidth * 1.9 : style.lineWidth } }
    : { type: "scatter", mode: "lines+markers", name: hit.variable, x: c.x, y: c.y })) ?? null,
    [curves, style, refCase, project]); // eslint-disable-line react-hooks/exhaustive-deps
  const curveLayout = useMemo(() => ({
    xaxis: { title: { text: xTitle } }, yaxis: { title: { text: hit.variable } },
    legend: { orientation: "h" as const, y: 1.02, yanchor: "bottom" as const }, margin: { t: 40, r: 20, b: 50, l: 80 } }), [xTitle, hit.variable]);
  const barData = useMemo((): Plotly.Data[] => (sorted ? [{
    type: "bar", x: sorted.map((b) => caseName(project, b.id)), y: sorted.map((b) => b.v),
    error_y: sorted.some((b) => b.std) ? { type: "data", array: sorted.map((b) => b.std ?? 0), visible: true } : undefined,
    marker: { color: style.barsByCase ? sorted.map((b) => color(b.id)) : style.barColor,
              line: { color: "#000", width: sorted.map((b) => (b.id === refCase ? 2 : 0)) } },
    hovertemplate: "%{x}: %{y:.5g}<extra></extra>",
  }] : []), [sorted, style, refCase, project]); // eslint-disable-line react-hooks/exhaustive-deps
  const barLayout = useMemo(() => ({ title: { text: title, font: { size: 13 } }, margin: { t: 50, b: 110, l: 70, r: 20 } }), [title]);
  return (
    <div className="card">
      <div className="row">
        <b className="grow">{title} <span className="muted small">{KIND_LABEL[hit.kind]} &middot; {hit.file}{hit.run ? ` \u00b7 ${hit.run.label ?? hit.run.name}` : ""}</span></b>
        {sorted && <button onClick={() => download(`${hit.variable.replace(/[^\w.-]+/g, "_")}.csv`, toCsv(
          ["case", hit.variable, "std", `% vs ${caseName(project, refCase)}`],
          sorted.map((b) => [caseName(project, b.id), b.v, b.std ?? null, pct(b.v, ref)])))}>Export CSV</button>}
        <button onClick={onClose}>Close</button>
      </div>
      {error && <div className="error">{error}</div>}
      {!error && !traces && !sorted && <div className="muted">Loading...</div>}
      {traces && (traces.length
        ? <Plot exportName={hit.variable} style={style} height={Math.round(420 * style.heightScale)} data={traces} layout={curveLayout} />
        : <div className="muted">No data for the selected cases.</div>)}
      {sorted && (sorted.length ? (
        <>
          <Plot exportName={hit.variable} style={style} height={Math.round(380 * style.heightScale)} data={barData} layout={barLayout} />
          <table className="grid narrow">
            <thead><tr><th>case</th><th>value</th>{sorted.some((b) => b.std != null) && <th>std</th>}<th title={PCT_HELP}>% vs ref</th></tr></thead>
            <tbody>{sorted.map((b) => (
              <tr key={b.id} className={b.id === refCase ? "refrow" : ""}><td className="mono" title={b.id}>{caseName(project, b.id)}</td>
                <td className="num">{fmt(b.v)}</td>{sorted.some((x) => x.std != null) && <td className="num">{fmt(b.std ?? null)}</td>}
                <td className="num">{fmt(pct(b.v, ref))}</td></tr>))}</tbody>
          </table>
        </>
      ) : <div className="muted">No values for the selected cases.</div>)}
    </div>
  );
}
