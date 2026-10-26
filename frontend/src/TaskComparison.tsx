import { useEffect, useMemo, useState } from "react";
import { caseName, download, fmt, toCsv, type Project, type Run, type TaskDef } from "./api";
import { COND, condOf, fmtPct, loadRunResults, pct, pickMetrics, type Cell, type Column, type RunResults } from "./results";

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleDateString() : "");
const STORE = "mstar_post.taskcmp";

// Every case of the project compared on the outputs of one job type (task), merged over
// all finished runs of that task: per case the newest run that contains it wins, so the
// table shows the project's current state regardless of how many runs were needed.
export default function TaskComparison({ project, task, runs, onOpenRun }: {
  project: Project; task: TaskDef | undefined; runs: Run[];  // runs of this task, newest first
  onOpenRun: (name: string) => void;
}) {
  const taskId = task?.id ?? runs[0]?.task ?? "";
  const [loaded, setLoaded] = useState<Record<string, RunResults>>({});
  const [error, setError] = useState<string | null>(null);
  const [showPct, setShowPct] = useState(true);
  const [onlySelected, setOnlySelected] = useState(true);
  const [picked, setPicked] = useState<string[] | null>(() => {
    try { return JSON.parse(localStorage.getItem(`${STORE}.${project.id}.${taskId}`) ?? "null"); } catch { return null; }
  });
  const [colFilter, setColFilter] = useState("");
  useEffect(() => {
    if (picked) localStorage.setItem(`${STORE}.${project.id}.${taskId}`, JSON.stringify(picked));
    else localStorage.removeItem(`${STORE}.${project.id}.${taskId}`);
  }, [picked, project.id, taskId]);

  const done = runs.filter((r) => r.status === "done" || r.status === "unknown");
  useEffect(() => {
    let live = true;
    setError(null);
    done.filter((r) => !loaded[r.name]).forEach((r) =>
      loadRunResults(project, r).then((res) => live && setLoaded((m) => ({ ...m, [r.name]: res })))
        .catch((e) => live && setError(e.message)));
    return () => { live = false; };
  }, [done.map((r) => r.name).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = done.filter((r) => !loaded[r.name]).length;

  // merge: newest run first; a case keeps the first (newest) run that has it
  const merged = useMemo(() => {
    const columns: Column[] = [];
    const rows = new Map<string, Record<string, Cell>>();
    const origin = new Map<string, Run>();
    for (const r of done) {
      const res = loaded[r.name];
      if (!res) continue;
      res.columns.forEach((c) => !columns.some((x) => x.col === c.col) && columns.push(c));
      for (const [cid, row] of res.rows) {
        if (!rows.has(cid)) { rows.set(cid, row); origin.set(cid, r); }
      }
    }
    return { columns, rows, origin };
  }, [loaded, done.map((r) => r.name).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = new Set(project.cases.filter((c) => c.included).map((c) => c.id));
  const order = new Map(project.cases.map((c, i) => [c.id, i]));
  const cases = [...merged.rows.keys()].filter((c) => !onlySelected || selected.has(c) || !order.has(c))
    .sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b));
  const notRun = project.cases.filter((c) => c.included && !merged.rows.has(c.id));
  const nHidden = merged.rows.size - cases.length;

  const defaults = pickMetrics(merged.columns);
  const metrics = picked
    ? picked.map((col) => merged.columns.find((c) => c.col === col)).filter((c): c is Column => !!c)
        .map((c) => ({ ...c, label: c.col.replace(/\s*\[[^\]]*\]\s*$/, ""), unit: c.col.match(/\[([^\]]*)\]\s*$/)?.[1] ?? "" }))
    : defaults;
  const ref = project.ref_case && merged.rows.has(project.ref_case) ? project.ref_case : null;
  const refRow = ref ? merged.rows.get(ref) : undefined;
  const cond = (c: string, key: string) => condOf(project, c, key);
  const condCols = COND.filter((k) => cases.some((c) => cond(c, k.key) !== null));
  const numericCols = merged.columns.filter((c) => [...merged.rows.values()].some((r) => typeof r[c.col] === "number"));
  const colChoices = merged.columns.filter((c) => c.col.toLowerCase().includes(colFilter.toLowerCase()));

  const exportCsv = () => download(`${project.id}_${taskId}_comparison.csv`, toCsv(
    ["case", "run", ...COND.map((k) => k.key), ...metrics.map((m) => m.col), ...(refRow ? metrics.map((m) => `${m.col} % vs ref`) : [])],
    cases.map((c) => [c, merged.origin.get(c)?.name ?? "", ...COND.map((k) => cond(c, k.key) ?? ""),
      ...metrics.map((m) => merged.rows.get(c)?.[m.col] ?? ""),
      ...(refRow ? metrics.map((m) => { const p = pct(merged.rows.get(c)?.[m.col] ?? null, refRow[m.col] ?? null); return p === null ? "" : p; }) : [])])));

  const valueNotes = [...new Set(Object.values(loaded).map((r) => r.valueNote).filter((v) => v !== "none"))];
  return (
    <div className="overview">
      <div className="card">
        <h3>{task?.label ?? taskId} across the project</h3>
        {task && <div className="small muted">{task.description}</div>}
        <div className="small" style={{ marginTop: 6 }}>
          {done.length} finished run{done.length === 1 ? "" : "s"} of this job type
          {runs.length > done.length && <span className="muted"> ({runs.length - done.length} not finished, ignored)</span>}:
          {" "}{done.map((r, i) => <span key={r.name}>{i > 0 && ", "}<a onClick={() => onOpenRun(r.name)} title={`${r.name}\n${when(r.created_at)}${r.user ? ` by ${r.user}` : ""}`}>{r.label ?? r.name}</a></span>)}
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          Each case shows its value from the newest run that includes it (hover a case for the run). Values are {valueNotes.join(" / ") || "per-case results"}.
          {ref ? <> Differences are relative to the reference case <b>{caseName(project, ref)}</b>.</> : " Set a reference case on the Cases tab for % differences."}
        </div>
      </div>

      <div className="card">
        <div className="row">
          <h3 className="grow">Cases compared <span className="muted small">({cases.length}{nHidden > 0 ? ` shown, ${nHidden} not selected` : ""})</span></h3>
          <label className="small"><input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} /> selected cases only</label>
          {refRow && <label className="small"><input type="checkbox" checked={showPct} onChange={(e) => setShowPct(e.target.checked)} /> % vs ref</label>}
          <details className="colpick">
            <summary className="small">Columns ({metrics.length}{picked ? "" : ", default"})</summary>
            <div className="row small">
              <input placeholder="filter columns" value={colFilter} onChange={(e) => setColFilter(e.target.value)} />
              <button className="small" onClick={() => setPicked(null)}>Default</button>
              <button className="small" onClick={() => setPicked(numericCols.map((c) => c.col))}>All numeric</button>
              <button className="small" onClick={() => setPicked([])}>None</button>
            </div>
            <div className="checklist">
              {colChoices.map((c) => {
                const on = metrics.some((m) => m.col === c.col);
                return <label key={c.col} className="small" title={`from ${c.source}`}><input type="checkbox" checked={on}
                  onChange={(e) => setPicked((e.target.checked ? [...metrics.map((m) => m.col), c.col] : metrics.map((m) => m.col).filter((x) => x !== c.col)))} />{c.col}</label>;
              })}
            </div>
          </details>
          {cases.length > 0 && <button onClick={exportCsv}>Export CSV</button>}
        </div>
        {error && <div className="error">{error}</div>}
        {pending > 0 && <div className="muted small">Loading {pending} run{pending === 1 ? "" : "s"}...</div>}
        {!pending && !cases.length && <div className="muted">No per-case results yet for this job type.</div>}
        {cases.length > 0 && (
          <div className="scroll-x">
            <table className="grid">
              <thead><tr>
                <th>case</th>
                {condCols.map((k, i) => <th key={k.key} className={i === condCols.length - 1 ? "cond" : ""} title={`${k.key} (from input.xml)`}>{k.label}<span className="muted"> [{k.unit}]</span></th>)}
                {metrics.map((m) => <th key={m.col} title={`${m.col}\nfrom ${m.source}`}>{m.label}{m.unit && <span className="muted"> [{m.unit}]</span>}</th>)}
              </tr></thead>
              <tbody>
                {cases.map((c) => {
                  const row = merged.rows.get(c)!;
                  const r = merged.origin.get(c);
                  const stale = r && r !== done[0];
                  return (
                    <tr key={c} className={`${c === ref ? "refrow" : ""}${order.has(c) ? "" : " excluded"}`}>
                      <td className="mono" title={`${c}\nfrom run ${r?.label ?? r?.name ?? "?"} (${when(r?.created_at ?? null)})${order.has(c) ? "" : "\nno longer in the project"}`}>
                        {caseName(project, c)}{stale && <span className="muted small" title="value from an older run than the newest one"> *</span>}</td>
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
        {cases.some((c) => merged.origin.get(c) !== done[0]) && done.length > 1 &&
          <div className="small muted">* value from an older run (the case was not part of the newest run).</div>}
        {notRun.length > 0 && (
          <div className="small muted" style={{ marginTop: 6 }}>
            Not yet computed for {notRun.length} selected case{notRun.length === 1 ? "" : "s"}: {notRun.map((c) => caseName(project, c.id)).join(", ")}.
            Run <b>{task?.label ?? taskId}</b> on them from the Run tab to complete the comparison.
          </div>
        )}
      </div>
    </div>
  );
}
