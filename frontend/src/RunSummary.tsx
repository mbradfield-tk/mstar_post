import { useEffect, useState } from "react";
import { caseName, download, fmt, toCsv, type Project, type Run, type TaskDef } from "./api";
import { COND, condOf, fmtPct, loadRunResults, meansFilesOf, pct, pickMetrics, type RunResults } from "./results";

const dur = (a: number | null, b: number | null) => {
  if (!a || !b) return "";
  const s = Math.round(b - a);
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${(s / 3600).toFixed(1)} h`;
};

// What was run, on which cases, with which non-default settings, and the key results per case.
export default function RunSummary({ project, run, task, onOpenFile }: {
  project: Project; run: Run; task: TaskDef | undefined; onOpenFile: (file: string) => void;
}) {
  const [res, setRes] = useState<RunResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPct, setShowPct] = useState(true);
  const prm = (run.params?.params ?? {}) as Record<string, unknown>;
  const caseIds: string[] = Array.isArray(run.params?.cases) ? (run.params.cases as string[]) : project.cases.map((c) => c.id);
  const ref = project.ref_case && caseIds.includes(project.ref_case) ? project.ref_case : null;
  const meansFiles = meansFilesOf(run);
  const multi = caseIds.length > 1;

  useEffect(() => {
    setRes(null);
    setError(null);
    let live = true;
    loadRunResults(project, run).then((r) => live && setRes(r)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [run.path, run.csvs.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const metrics = res ? pickMetrics(res.columns) : [];
  const rows = res?.rows ?? new Map<string, Record<string, string | number | null>>();
  const valueNote = res?.valueNote ?? "";
  const ordered = caseIds.filter((c) => rows.has(c));
  const refRow = ref ? rows.get(ref) : undefined;
  const cond = (c: string, key: string) => condOf(project, c, key);
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
          <div className="muted">{res === null ? "Loading..." : res.valueNote === "none"
            ? "This run has no summary table or per-case time series; browse its files instead."
            : "No per-case results found in this run."}</div>
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
