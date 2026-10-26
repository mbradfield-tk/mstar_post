import { useEffect, useMemo, useState } from "react";
import { caseName, download, fmt, toCsv, type Project, type Run } from "./api";
import { COND, condOf, fmtPct, loadAllResults, pct, type Cell, type Column, type RunResults } from "./results";

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleDateString() : "");
const STORE = "mstar_post.allresults";
const unitOf = (col: string) => col.match(/\[([^\]]*)\]\s*$/)?.[1] ?? "";

// Every per-case result of one run, or of all finished runs of a job type merged (newest
// run per case): the summary means, every M-Star Stats steady-state mean and the derived
// values. The user picks which columns to show.
export default function AllResults({ project, runs, storeKey }: {
  project: Project; runs: Run[];  // newest first; one run or all finished runs of a job type
  storeKey: string;
}) {
  const [loaded, setLoaded] = useState<Record<string, RunResults>>({});
  const [error, setError] = useState<string | null>(null);
  const [showPct, setShowPct] = useState(false);
  const [showStd, setShowStd] = useState(false);
  const [onlySelected, setOnlySelected] = useState(true);
  const [filter, setFilter] = useState("");
  const store = `${STORE}.${project.id}.${storeKey}`;
  const [picked, setPicked] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(store) ?? "[]"); } catch { return []; }
  });
  useEffect(() => localStorage.setItem(store, JSON.stringify(picked)), [store, picked]);

  const done = runs.filter((r) => r.status === "done" || r.status === "unknown");
  useEffect(() => {
    let live = true;
    done.filter((r) => !loaded[r.name]).forEach((r) =>
      loadAllResults(project, r).then((res) => live && setLoaded((m) => ({ ...m, [r.name]: res })))
        .catch((e) => live && setError(e.message)));
    return () => { live = false; };
  }, [done.map((r) => r.name).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = done.filter((r) => !loaded[r.name]).length;

  const merged = useMemo(() => {
    const columns: Column[] = [];
    const rows = new Map<string, Record<string, Cell>>();
    const std = new Map<string, Record<string, number>>();
    const origin = new Map<string, Run>();
    for (const r of done) {
      const res = loaded[r.name];
      if (!res) continue;
      res.columns.forEach((c) => !columns.some((x) => x.col === c.col) && columns.push(c));
      for (const [cid, row] of res.rows) if (!rows.has(cid)) { rows.set(cid, row); origin.set(cid, r); std.set(cid, res.std?.get(cid) ?? {}); }
    }
    return { columns, rows, std, origin };
  }, [loaded, done.map((r) => r.name).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = new Set(project.cases.filter((c) => c.included).map((c) => c.id));
  const order = new Map(project.cases.map((c, i) => [c.id, i]));
  const cases = [...merged.rows.keys()].filter((c) => !onlySelected || selected.has(c) || !order.has(c))
    .sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b));
  const ref = project.ref_case && merged.rows.has(project.ref_case) ? project.ref_case : null;
  const refRow = ref ? merged.rows.get(ref) : undefined;
  const cond = (c: string, key: string) => condOf(project, c, key);
  const condCols = COND.filter((k) => cases.some((c) => cond(c, k.key) !== null));
  const shownCols = picked.map((p) => merged.columns.find((c) => c.col === p)).filter((c): c is Column => !!c);
  const hasStd = shownCols.some((c) => cases.some((cid) => merged.std.get(cid)?.[c.col] !== undefined));

  // column picker grouped by origin
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = useMemo(() => {
    const g = new Map<string, Column[]>();
    merged.columns.forEach((c) => g.set(c.group ?? c.source, [...(g.get(c.group ?? c.source) ?? []), c]));
    return [...g.entries()];
  }, [merged.columns]);
  const matches = (c: Column) => words.every((w) => c.col.toLowerCase().includes(w));
  const toggle = (cols: string[], on: boolean) => setPicked((p) => on ? [...p, ...cols.filter((c) => !p.includes(c))] : p.filter((c) => !cols.includes(c)));

  const exportCsv = () => download(`${project.id}_${storeKey}_all_results.csv`, toCsv(
    ["case", "run", ...COND.map((k) => k.key), ...shownCols.flatMap((c) => hasStd && showStd ? [c.col, `${c.col} std`] : [c.col]),
     ...(refRow && showPct ? shownCols.map((c) => `${c.col} % vs ref`) : [])],
    cases.map((cid) => [cid, merged.origin.get(cid)?.name ?? "", ...COND.map((k) => cond(cid, k.key) ?? ""),
      ...shownCols.flatMap((c) => hasStd && showStd ? [merged.rows.get(cid)?.[c.col] ?? "", merged.std.get(cid)?.[c.col] ?? ""] : [merged.rows.get(cid)?.[c.col] ?? ""]),
      ...(refRow && showPct ? shownCols.map((c) => { const p = pct(merged.rows.get(cid)?.[c.col] ?? null, refRow[c.col] ?? null); return p === null ? "" : p; }) : [])])));

  return (
    <div className="split allres">
      <div className="side">
        <div className="row small"><b className="grow">Variables ({picked.length} shown of {merged.columns.length})</b>
          {picked.length > 0 && <button className="small" onClick={() => setPicked([])}>clear</button>}</div>
        <input placeholder="filter variables (words in any order)" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {pending > 0 && <div className="muted small">Loading {pending} run{pending === 1 ? "" : "s"}...</div>}
        <div className="checklist tall">
          {groups.map(([g, cols]) => {
            const vis = cols.filter(matches);
            if (!vis.length) return null;
            const n = vis.filter((c) => picked.includes(c.col)).length;
            return (
              <details key={g} className="srcgroup" open={n > 0 || words.length > 0}>
                <summary className="small"><b>{g}</b> <span className="muted">{n ? `${n} of ` : ""}{vis.length}</span>
                  <span className="grow" />
                  <button className="small" onClick={(e) => { e.preventDefault(); toggle(vis.map((c) => c.col), true); }}>all</button>
                  <button className="small" onClick={(e) => { e.preventDefault(); toggle(vis.map((c) => c.col), false); }}>none</button></summary>
                {vis.map((c) => <label key={c.col} className="small srcfile" title={`from ${c.source}`}><input type="checkbox" checked={picked.includes(c.col)}
                  onChange={(e) => toggle([c.col], e.target.checked)} />{c.col}</label>)}
              </details>);
          })}
          {!merged.columns.length && !pending && <div className="muted small">No per-case results in {done.length === 1 ? "this run" : "these runs"}.</div>}
        </div>
      </div>
      <div className="main">
        <div className="row small">
          <b>Cases ({cases.length})</b>
          <label><input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} /> selected cases only</label>
          {refRow && <label><input type="checkbox" checked={showPct} onChange={(e) => setShowPct(e.target.checked)} /> % vs ref ({caseName(project, ref!)})</label>}
          {hasStd && <label><input type="checkbox" checked={showStd} onChange={(e) => setShowStd(e.target.checked)} /> show std</label>}
          <span className="grow" />
          {shownCols.length > 0 && cases.length > 0 && <button onClick={exportCsv}>Export CSV</button>}
        </div>
        {error && <div className="error">{error}</div>}
        {!shownCols.length && merged.columns.length > 0 && <div className="muted">Tick variables on the left: M-Star Stats steady-state means per file, the summary means and the derived values{done.length > 1 ? ", merged over all finished runs of this job type (newest run per case)" : ""}.</div>}
        {shownCols.length > 0 && (
          <div className="tablewrap">
            <table className="grid">
              <thead><tr>
                <th>case</th>
                {condCols.map((k, i) => <th key={k.key} className={i === condCols.length - 1 ? "cond" : ""}>{k.label}<span className="muted"> [{k.unit}]</span></th>)}
                {shownCols.map((c) => <th key={c.col} title={`${c.col}\n${c.group ?? ""} (${c.source})`}>{c.col.replace(/\s*\[[^\]]*\]\s*$/, "")}{unitOf(c.col) && <span className="muted"> [{unitOf(c.col)}]</span>}</th>)}
              </tr></thead>
              <tbody>
                {cases.map((cid) => {
                  const row = merged.rows.get(cid)!;
                  const r = merged.origin.get(cid);
                  return (
                    <tr key={cid} className={`${cid === ref ? "refrow" : ""}${order.has(cid) ? "" : " excluded"}`}>
                      <td className="mono" title={`${cid}\nfrom run ${r?.label ?? r?.name ?? "?"} (${when(r?.created_at ?? null)})`}>{caseName(project, cid)}</td>
                      {condCols.map((k, i) => <td key={k.key} className={`num${i === condCols.length - 1 ? " cond" : ""}`}>{fmt(cond(cid, k.key))}</td>)}
                      {shownCols.map((c) => {
                        const v = row[c.col] ?? null;
                        const s = merged.std.get(cid)?.[c.col];
                        const p = showPct && refRow && cid !== ref ? pct(v, refRow[c.col] ?? null) : null;
                        return (
                          <td key={c.col} className={typeof v === "number" ? "num" : ""}>
                            {fmt(v)}{showStd && s !== undefined && <span className="muted small"> ± {fmt(s, 3)}</span>}
                            {p !== null && <div className={`small pct ${p > 0 ? "up" : p < 0 ? "down" : ""}`}>{fmtPct(p)}</div>}
                          </td>);
                      })}
                    </tr>);
                })}
                {!cases.length && <tr><td colSpan={1 + condCols.length + shownCols.length} className="muted">No cases to show.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
