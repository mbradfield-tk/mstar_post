import { useEffect, useMemo, useState } from "react";
import { api, caseName, download, fmt, toCsv, type CsvTable, type Project, type Run, type TaskDef } from "./api";

// Key metrics shown in the run overview, in priority order: [column pattern, short label].
// The unit is taken from the column's "[...]" suffix.
const KEY_METRICS: [RegExp, string][] = [
  [/^Mean Energy Dissipation Rate \[/, "Mean eps"],
  [/^Power per Volume P\/V/, "P/V"],
  [/^Power Number from Torque/, "Po"],
  [/^Impeller Power P \(/, "P"],
  [/^Mean Velocity \[/, "Mean velocity"],
  [/^Blend Time t95/, "t95 blend"],
  [/^Kolmogorov Scale at Mean Resolved Dissipation \[/, "Kolmogorov"],
  [/^Mixing Time/i, "Mixing time"],
  [/^Specific Interfacial Area \[/, "a"],
  [/^Interface Enhancement E/, "E = a/a0"],
  [/^Sauter Diameter d32 \(/, "d32"],
  [/^Dispersion Time t95/, "t95 disp"],
  [/^Number of Drops/, "Drops"],
  [/^Zonal CoV of Phase Fraction \(Fluid 1/, "Zonal CoV"],
  [/^Segregation Index S \(Fluid 1/, "S"],
  [/^Homogeneity Time t_S \(Fluid 1/, "t_S"],
  [/^Continuous Phase/, "Continuous phase"],
  [/^UA \[/, "UA"],
  [/^U \[/, "U"],
  [/^Q_wall/, "Q wall"],
];
const MAX_METRICS = 10;
// case operating conditions (keys of case_info.settings) shown in front of the key results
const COND = [{ key: "Volume [L]", label: "Volume", unit: "L" }, { key: "Agitator speed [rpm]", label: "Speed", unit: "rpm" }];
const unitOf = (col: string) => col.match(/\[([^\]]*)\]\s*$/)?.[1] ?? "";
const shortName = (col: string) => col.replace(/\s*\[[^\]]*\]\s*$/, "");

type Metric = { col: string; label: string; unit: string; source: string };
type Cell = string | number | null;

const pickMetrics = (columns: { col: string; source: string }[]): Metric[] => {
  const out: Metric[] = [];
  for (const [re, label] of KEY_METRICS) {
    const hit = columns.find((c) => re.test(c.col) && !out.some((m) => m.col === c.col));
    if (hit) out.push({ col: hit.col, label, unit: unitOf(hit.col), source: hit.source });
    if (out.length >= MAX_METRICS) break;
  }
  if (!out.length) {  // unknown task: first numeric-looking columns
    columns.slice(0, MAX_METRICS).forEach((c) =>
      out.push({ col: c.col, label: shortName(c.col), unit: unitOf(c.col), source: c.source }));
  }
  return out;
};

const pct = (v: Cell, r: Cell) =>
  typeof v === "number" && typeof r === "number" && r !== 0 ? ((v - r) / Math.abs(r)) * 100 : null;
const fmtPct = (p: number) => `${p > 0 ? "+" : ""}${p.toFixed(Math.abs(p) < 10 ? 1 : 0)}%`;
const dur = (a: number | null, b: number | null) => {
  if (!a || !b) return "";
  const s = Math.round(b - a);
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${(s / 3600).toFixed(1)} h`;
};

// What was run, on which cases, with which non-default settings, and the key results per case.
export default function RunSummary({ project, run, task, onOpenFile }: {
  project: Project; run: Run; task: TaskDef | undefined; onOpenFile: (file: string) => void;
}) {
  const [tables, setTables] = useState<Record<string, CsvTable>>({});
  const [finals, setFinals] = useState<{ cols: { col: string; source: string }[]; rows: Map<string, Record<string, Cell>> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPct, setShowPct] = useState(true);
  const prm = (run.params?.params ?? {}) as Record<string, unknown>;
  const caseIds: string[] = Array.isArray(run.params?.cases) ? (run.params.cases as string[]) : project.cases.map((c) => c.id);
  const ref = project.ref_case && caseIds.includes(project.ref_case) ? project.ref_case : null;
  const meansFiles = run.csvs.filter((f) => !f.includes("/") && /_means\.csv$/.test(f));
  const multi = caseIds.length > 1;

  // one row per case merged over all *_means.csv files (first file wins per column)
  useEffect(() => {
    setTables({});
    setError(null);
    let live = true;
    Promise.all(meansFiles.map((f) => api.csv(project.id, `${run.path}/${f}`).then((t) => [f, t] as const)))
      .then((ts) => live && setTables(Object.fromEntries(ts)))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [run.path, meansFiles.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  // no means table (per-case tasks such as calc_ua): final values of the per-case time series
  useEffect(() => {
    setFinals(null);
    if (meansFiles.length) return;
    let live = true;
    api.runTimeseries(project.id, run.name).then(async (files) => {
      const cols: { col: string; source: string }[] = [];
      const rows = new Map<string, Record<string, Cell>>();
      for (const f of files) {
        const want = pickMetrics(f.columns.map((c) => ({ col: c, source: f.file }))).map((m) => m.col);
        if (!want.length) continue;
        const s = await api.runSeries(project.id, run.name, f.file, want);
        for (const [cid, d] of Object.entries(s)) {
          const row = rows.get(cid) ?? {};
          for (const c of want) {
            const v = (d.columns[c] ?? []).filter((x): x is number => x !== null);
            if (v.length) row[c] = v[v.length - 1];
          }
          rows.set(cid, row);
        }
        want.forEach((c) => cols.push({ col: c, source: f.file }));
      }
      if (live) setFinals({ cols, rows });
    }).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [run.name, meansFiles.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const { metrics, rows, valueNote } = useMemo(() => {
    if (meansFiles.length) {
      const columns: { col: string; source: string }[] = [];
      const rows = new Map<string, Record<string, Cell>>();
      for (const f of meansFiles) {
        const t = tables[f];
        if (!t || t.columns[0] !== "case") continue;
        t.columns.slice(1).forEach((c) => !columns.some((x) => x.col === c) && columns.push({ col: c, source: f }));
        for (const r of t.rows) {
          const row = rows.get(String(r[0])) ?? {};
          t.columns.forEach((c, i) => { if (i && row[c] === undefined) row[c] = r[i]; });
          rows.set(String(r[0]), row);
        }
      }
      return { metrics: pickMetrics(columns), rows, valueNote: "steady-state means" };
    }
    return { metrics: finals ? pickMetrics(finals.cols) : [], rows: finals?.rows ?? new Map(), valueNote: "final values" };
  }, [tables, finals, meansFiles.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const ordered = caseIds.filter((c) => rows.has(c));
  const refRow = ref ? rows.get(ref) : undefined;
  // operating conditions of each case from the project's case info (input.xml), shown before the results
  const cond = (c: string, key: string): number | string | null => {
    const v = project.cases.find((x) => x.id === c)?.info?.settings?.[key];
    return typeof v === "number" || typeof v === "string" ? v : null;
  };
  const condCols = COND.filter((k) => ordered.some((c) => cond(c, k.key) !== null));

  // non-default settings
  const settings = (task?.params ?? []).flatMap((p) => {
    const v = prm[p.name];
    const d = p.default;
    const same = JSON.stringify(v ?? null) === JSON.stringify(d ?? null)
      || (Array.isArray(d) && Array.isArray(v) && d.join(" ") === v.join(" "));
    if (same || v === null || v === undefined || v === "") return [];
    const txt = p.type === "bool" ? (v ? "on" : "off") : Array.isArray(v) ? v.join(" ") : String(v);
    return [{ label: p.label, value: txt }];
  });

  // headline findings for the first few numeric metrics
  const findings = multi ? metrics.slice(0, 4).flatMap((m) => {
    const vals = ordered.map((c) => [c, rows.get(c)?.[m.col]] as const).filter((x): x is readonly [string, number] => typeof x[1] === "number");
    if (vals.length < 2) return [];
    const hi = vals.reduce((a, b) => (b[1] > a[1] ? b : a)), lo = vals.reduce((a, b) => (b[1] < a[1] ? b : a));
    const spread = lo[1] !== 0 ? ((hi[1] - lo[1]) / Math.abs(lo[1])) * 100 : null;
    return [{ m, hi, lo, spread }];
  }) : [];

  const exportCsv = () => download(`${run.name}_overview.csv`, toCsv(
    ["case", ...COND.map((k) => k.key), ...metrics.map((m) => m.col), ...(refRow ? metrics.map((m) => `${m.col} % vs ref`) : [])],
    ordered.map((c) => [c, ...COND.map((k) => cond(c, k.key) ?? ""), ...metrics.map((m) => rows.get(c)?.[m.col] ?? ""),
      ...(refRow ? metrics.map((m) => { const p = pct(rows.get(c)?.[m.col] ?? null, refRow[m.col] ?? null); return p === null ? "" : p; }) : [])])));

  const n = { tables: run.csvs.length, plots: run.htmls.length, images: run.images.length };
  return (
    <div className="overview">
      <div className="overview-grid">
        <div className="card">
          <h3>What was run</h3>
          <div><b>{task?.label ?? run.task}</b></div>
          {task && <div className="small muted">{task.description}</div>}
          <div className="small" style={{ marginTop: 6 }}>
            {settings.length ? <>
              <span className="muted">Settings changed from the defaults:</span>
              <ul className="kv">{settings.map((s) => <li key={s.label}><span className="muted">{s.label}</span> {s.value}</li>)}</ul>
            </> : <span className="muted">Default settings.</span>}
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            {run.created_at && new Date(run.created_at * 1000).toLocaleString()}
            {dur(run.created_at, run.finished_at) && <> &middot; took {dur(run.created_at, run.finished_at)}</>}
            {run.user && <> &middot; started by <b>{run.user}</b></>}
            {" "}&middot; <span className={`status ${run.status}`}>{run.status}</span>
          </div>
        </div>
        <div className="card">
          <h3>{multi ? `${caseIds.length} cases compared` : "1 case"}</h3>
          <div className="chips">
            {caseIds.map((c) => (
              <span key={c} className={`chip${c === ref ? " ref" : ""}${project.cases.some((x) => x.id === c) ? "" : " gone"}`}
                    title={c === ref ? `${c} (reference case)` : c}>{caseName(project, c)}{c === ref ? " (ref)" : ""}
                {(cond(c, "Volume [L]") !== null || cond(c, "Agitator speed [rpm]") !== null) && <span className="muted small">
                  {" "}{[cond(c, "Volume [L]") !== null ? `${fmt(cond(c, "Volume [L]"), 3)} L` : "", cond(c, "Agitator speed [rpm]") !== null ? `${fmt(cond(c, "Agitator speed [rpm]"), 4)} rpm` : ""].filter(Boolean).join(", ")}</span>}</span>))}
          </div>
          {multi && <div className="small muted" style={{ marginTop: 6 }}>
            {ref ? <>Differences are relative to the reference case <b>{caseName(project, ref)}</b>.</>
              : "No reference case among these cases: set one on the Cases tab for % differences."}
          </div>}
          <div className="small muted" style={{ marginTop: 6 }}>
            Outputs: {n.tables} table{n.tables === 1 ? "" : "s"}, {n.plots} plot{n.plots === 1 ? "" : "s"}, {n.images} image{n.images === 1 ? "" : "s"}
            {meansFiles.length > 0 && <> &middot; key results from {meansFiles.map((f, i) => <span key={f}>{i > 0 && ", "}<a onClick={() => onOpenFile(f)}>{f}</a></span>)}</>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <h3 className="grow">Key results <span className="muted small">({valueNote})</span></h3>
          {refRow && multi && <label className="small"><input type="checkbox" checked={showPct} onChange={(e) => setShowPct(e.target.checked)} /> % vs ref</label>}
          {ordered.length > 0 && <button onClick={exportCsv}>Export CSV</button>}
        </div>
        {error && <div className="error">{error}</div>}
        {!error && !ordered.length && (
          <div className="muted">{meansFiles.length || finals === null
            ? (Object.keys(tables).length || finals ? "No per-case results found in this run." : "Loading...")
            : "This run has no summary table or per-case time series; browse its files instead."}</div>
        )}
        {ordered.length > 0 && (
          <div className="scroll-x">
            <table className="grid">
              <thead><tr>
                <th>case</th>
                {condCols.map((k, i) => <th key={k.key} className={i === condCols.length - 1 ? "cond" : ""} title={`${k.key} (from input.xml)`}>{k.label}<span className="muted"> [{k.unit}]</span></th>)}
                {metrics.map((m) => <th key={m.col} title={`${m.col}\nfrom ${m.source}`}>{m.label}{m.unit && <span className="muted"> [{m.unit}]</span>}</th>)}
              </tr></thead>
              <tbody>
                {ordered.map((c) => {
                  const row = rows.get(c)!;
                  return (
                    <tr key={c} className={c === ref ? "refrow" : ""}>
                      <td className="mono" title={c}>{caseName(project, c)}</td>
                      {condCols.map((k, i) => <td key={k.key} className={`num${i === condCols.length - 1 ? " cond" : ""}`}>{fmt(cond(c, k.key))}</td>)}
                      {metrics.map((m) => {
                        const v = row[m.col] ?? null;
                        const p = showPct && refRow && c !== ref ? pct(v, refRow[m.col] ?? null) : null;
                        return (
                          <td key={m.col} className={typeof v === "number" ? "num" : ""}>
                            {fmt(v)}
                            {p !== null && <div className={`small pct ${p > 0 ? "up" : p < 0 ? "down" : ""}`}>{fmtPct(p)}</div>}
                          </td>);
                      })}
                    </tr>);
                })}
              </tbody>
            </table>
          </div>
        )}
        {findings.length > 0 && (
          <ul className="findings small">
            {findings.map(({ m, hi, lo, spread }) => (
              <li key={m.col}>
                <b>{m.label}</b>{m.unit && <span className="muted"> [{m.unit}]</span>}: highest in <b>{caseName(project, hi[0])}</b> ({fmt(hi[1])}),
                lowest in <b>{caseName(project, lo[0])}</b> ({fmt(lo[1])})
                {spread !== null && spread > 0.5 && <span className="muted">, spread {spread.toFixed(spread < 10 ? 1 : 0)}%</span>}
              </li>))}
          </ul>
        )}
      </div>
    </div>
  );
}
