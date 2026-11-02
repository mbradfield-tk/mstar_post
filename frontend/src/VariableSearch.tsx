import { useEffect, useMemo, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, caseName, download, fmt, toCsv, type Project, type Run, type VarEntry } from "./api";
import Plot from "./Plot";
import { caseColor, type PlotStyle } from "./PlotStyle";
import { pct, runHasCases, selectedCaseIds } from "./results";

type Kind = "stats" | "series" | "table" | "long";
const KIND_LABEL: Record<Kind, string> = {
  stats: "M-Star Stats time series", series: "App script time series", table: "Result table", long: "Steady-state mean",
};
// one variable in one place; paths: case id -> file (per-case files) or "" -> the run-level file
type Hit = { key: string; kind: Kind; variable: string; file: string; srcFile?: string; run?: Run;
             cases: string[]; paths: Map<string, string> };

export default function VariableSearch({ project, style, refCase, onPlotSeries }: {
  project: Project; style: PlotStyle; refCase: string;
  onPlotSeries: (src: string, file: string, col: string) => void;
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

  useEffect(() => {
    api.runs(project.id).then(setRuns).catch((e) => setError(e.message));
    api.variables(project.id).then(setEntries).catch((e) => setError(e.message));
  }, [project.id]);
  useEffect(() => {
    selCases.filter((c) => !stats[c.id]).forEach((c) => api.stats(c.path)
      .then((fs) => setStats((m) => ({ ...m, [c.id]: fs })))
      .catch(() => setStats((m) => ({ ...m, [c.id]: [] }))));
  }, [selKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const hits = useMemo(() => {
    const out = new Map<string, Hit>();
    const add = (key: string, h: Omit<Hit, "key" | "cases" | "paths">, cid: string | null, path: string) => {
      const e: Hit = out.get(key) ?? { ...h, key, cases: [], paths: new Map() };
      if (cid && !e.cases.includes(cid)) e.cases.push(cid);
      e.paths.set(cid ?? "", path);
      out.set(key, e);
    };
    for (const c of selCases) for (const f of stats[c.id] ?? []) for (const col of f.columns)
      add(`stats|${f.file}|${col}`, { kind: "stats", variable: col, file: f.file }, c.id, f.file);
    const byName = new Map(runs.filter((r) => runHasCases(r, selIds)).map((r) => [r.name, r]));
    for (const e of entries ?? []) {
      const run = byName.get(e.run);
      if (!run) continue;
      if (e.case) {
        if (!selIds.has(e.case)) continue;
        const rel = e.path.startsWith(`${e.case}/`) ? e.path.slice(e.case.length + 1) : e.path;
        for (const col of e.columns as string[]) {
          if (e.kind === "series") add(`series|${e.run}|${rel}|${col}`, { kind: "series", variable: col, file: rel, run }, e.case, e.path);
          else if (e.kind === "table") add(`table|${e.run}|${rel}|${col}`, { kind: "table", variable: col, file: rel, run }, e.case, e.path);
        }
        if (e.kind !== "long") continue;
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
  const found = words.length ? hits.filter((h) => kinds.includes(h.kind)
    && words.every((w) => `${h.variable} ${h.file} ${h.srcFile ?? ""}`.toLowerCase().includes(w)))
    .sort((a, b) => a.variable.localeCompare(b.variable) || a.kind.localeCompare(b.kind)) : [];
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
  const [traces, setTraces] = useState<Plotly.Data[] | null>(null);
  const [bars, setBars] = useState<{ id: string; v: number | null; std?: number | null }[] | null>(null);
  const [xTitle, setXTitle] = useState("Time [s]");
  const [error, setError] = useState<string | null>(null);
  const color = (id: string) => caseColor(style, id, project.cases.findIndex((c) => c.id === id));
  const runPath = hit.run ? `${hit.run.path}/` : "";

  useEffect(() => {
    const line = (id: string, x: (number | string | null)[], y: (number | null)[]): Plotly.Data => ({
      type: "scattergl", mode: "lines", name: caseName(project, id), x, y,
      line: { color: color(id), width: id === refCase ? style.lineWidth * 1.9 : style.lineWidth },
    });
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    const go = async () => {
      if (hit.kind === "stats") {
        const ps = hit.cases.map((id) => {
          const c = project.cases.find((x) => x.id === id)!;
          return api.series(c.path, hit.paths.get(id)!, [hit.variable]).then((s) => line(id, s.t, s.columns[hit.variable] ?? [])).catch(() => null);
        });
        setTraces((await Promise.all(ps)).filter((t): t is Plotly.Data => !!t));
      } else if (hit.kind === "series") {
        const s = await api.runSeries(project.id, hit.run!.name, hit.file, [hit.variable], hit.cases);
        setTraces(Object.entries(s).map(([id, d]) => line(id, d.t, d.columns[hit.variable] ?? [])));
      } else if (hit.kind === "long") {
        const t = await api.csv(project.id, `${runPath}${hit.file}`);
        const ix = (n: string) => t.columns.findIndex((c) => c.trim().toLowerCase() === n);
        const iC = ix("case"), iF = ix("file"), iV = ix("variable"), iM = ix("mean"), iS = ix("std");
        const rows = t.rows.filter((r) => r[iV] === hit.variable && (iF < 0 || String(r[iF] ?? "") === (hit.srcFile ?? "")));
        setBars(rows.filter((r) => iC < 0 || !hit.cases.length || hit.cases.includes(String(r[iC])))
          .map((r) => ({ id: iC < 0 ? project.cases[0]?.id ?? "" : String(r[iC]), v: num(r[iM]), std: iS >= 0 ? num(r[iS]) : null })));
      } else if (hit.paths.has("")) {
        // run-level table without a case column: the variable against the first column
        const t = await api.csv(project.id, `${runPath}${hit.file}`);
        const j = t.columns.indexOf(hit.variable);
        setXTitle(t.columns[0]);
        setTraces([{ type: "scatter", mode: "lines+markers", name: hit.variable, x: t.rows.map((r) => r[0]), y: t.rows.map((r) => num(r[j])) }]);
      } else {
        // per-case files: one value per case (single row) or the variable against the first column
        const ids = hit.cases.filter((id) => hit.paths.has(id));
        const tables = await Promise.all(ids.map((id) => api.csv(project.id, `${runPath}${hit.paths.get(id)}`).then((t) => [id, t] as const).catch(() => null)));
        const ok = tables.filter((x): x is NonNullable<typeof x> => !!x);
        if (ok.every(([, t]) => t.rows.length <= 1)) {
          setBars(ok.map(([id, t]) => ({ id, v: num(t.rows[0]?.[t.columns.indexOf(hit.variable)]) })));
        } else {
          setXTitle(ok[0]?.[1].columns[0] ?? "");
          setTraces(ok.map(([id, t]) => ({ ...line(id, t.rows.map((r) => r[0]), t.rows.map((r) => num(r[t.columns.indexOf(hit.variable)]))),
            type: "scatter", mode: "lines+markers" } as Plotly.Data)));
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
  const sorted = bars ? [...bars].sort((a, b) => order(a.id) - order(b.id)) : null;
  const ref = sorted?.find((b) => b.id === refCase)?.v ?? null;
  const title = `${hit.variable}${hit.srcFile ? ` (${hit.srcFile})` : ""}`;
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
        ? <Plot exportName={hit.variable} style={style} height={Math.round(420 * style.heightScale)} data={traces} layout={{
            xaxis: { title: { text: xTitle } }, yaxis: { title: { text: hit.variable } },
            legend: { orientation: "h", y: 1.02, yanchor: "bottom" }, margin: { t: 40, r: 20, b: 50, l: 80 } }} />
        : <div className="muted">No data for the selected cases.</div>)}
      {sorted && (sorted.length ? (
        <>
          <Plot exportName={hit.variable} style={style} height={Math.round(380 * style.heightScale)} data={[{
            type: "bar", x: sorted.map((b) => caseName(project, b.id)), y: sorted.map((b) => b.v),
            error_y: sorted.some((b) => b.std) ? { type: "data", array: sorted.map((b) => b.std ?? 0), visible: true } : undefined,
            marker: { color: style.barsByCase ? sorted.map((b) => color(b.id)) : style.barColor,
                      line: { color: "#000", width: sorted.map((b) => (b.id === refCase ? 2 : 0)) } },
            hovertemplate: "%{x}: %{y:.5g}<extra></extra>",
          }]} layout={{ title: { text: title, font: { size: 13 } }, margin: { t: 50, b: 110, l: 70, r: 20 } }} />
          <table className="grid narrow">
            <thead><tr><th>case</th><th>value</th>{sorted.some((b) => b.std != null) && <th>std</th>}<th>% vs ref</th></tr></thead>
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
