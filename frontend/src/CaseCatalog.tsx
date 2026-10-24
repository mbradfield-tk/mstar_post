import { useEffect, useMemo, useState } from "react";
import { api, download, fmt, toCsv, type CatalogCase } from "./api";

// Key settings shown as columns (matched by prefix), as in the project Cases tab.
const KEY_SETTINGS = ["Volume [L]", "Agitator speed [rpm]", "dx [m]", "Fluid 1 name", "Fluid 2 name",
  "Simulated time (input runtime)", "Wall time"];
type SortKey = "uid" | "name" | "path" | "end" | "projects";

// Every case of every project in one table: unique id, name, folder, projects, simulation data.
export default function CaseCatalog({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const [rows, setRows] = useState<CatalogCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "path", asc: true });
  const [copied, setCopied] = useState<string | null>(null);
  const load = () => { setError(null); api.allCases().then(setRows).catch((e) => setError(e.message)); };
  useEffect(load, []);

  const cols = useMemo(() => {
    const keys = new Set<string>();
    rows?.forEach((r) => Object.keys(r.info?.settings ?? {}).forEach((k) => keys.add(k)));
    const out: string[] = [];
    for (const pre of KEY_SETTINGS) for (const k of keys) if (k.startsWith(pre) && !out.includes(k)) out.push(k);
    return out;
  }, [rows]);

  const q = filter.toLowerCase();
  const shown = (rows ?? []).filter((r) => !q || r.uid.includes(q) || r.path.toLowerCase().includes(q)
    || r.projects.some((p) => p.name.toLowerCase().includes(q) || p.case_id.toLowerCase().includes(q)
      || p.owner.toLowerCase().includes(q) || p.program.toLowerCase().includes(q) || p.purpose.toLowerCase().includes(q)))
    .sort((a, b) => {
      const k = sort.key;
      const c = k === "end" ? (a.info?.end_time_s ?? -1) - (b.info?.end_time_s ?? -1)
        : k === "projects" ? a.projects.length - b.projects.length
        : String(a[k]).localeCompare(String(b[k]));
      return sort.asc ? c : -c;
    });
  const head = (k: SortKey, label: string, title?: string) => (
    <th className="sortable" title={title} onClick={() => setSort({ key: k, asc: sort.key === k ? !sort.asc : true })}>
      {label}{sort.key === k ? (sort.asc ? " \u25b2" : " \u25bc") : ""}</th>);
  const copy = (uid: string) => navigator.clipboard?.writeText(uid).then(() => { setCopied(uid); setTimeout(() => setCopied(null), 1500); });
  const exportCsv = () => download("mstar_post_cases.csv", toCsv(
    ["case_id", "name", "folder", "projects", "simulated_end_s", ...cols],
    shown.map((r) => [r.uid, r.name, r.path, r.projects.map((p) => `${p.name}:${p.case_id}`).join("; "),
      r.info?.end_time_s ?? "", ...cols.map((k) => r.info?.settings?.[k] ?? "")])));

  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow">All cases <span className="muted">({rows ? (shown.length === rows.length ? rows.length : `${shown.length} of ${rows.length}`) : "…"})</span></h2>
        <input placeholder="search id, folder, project, owner..." value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={exportCsv} disabled={!shown.length}>Export CSV</button>
        <button onClick={load}>Refresh</button>
      </div>
      <div className="small muted">Every case known to any project. The case ID is assigned once and written to
        <span className="mono"> mstar_post_case.json</span> in the case folder, so it stays with the folder when it is renamed, moved or used in another project.</div>
      {error && <div className="error">{error}</div>}
      {!rows && !error && <div className="muted">Loading...</div>}
      {rows && (
        <div className="tablewrap">
          <table className="grid">
            <thead><tr>
              {head("uid", "case ID", "unique across all projects; click to copy")}
              {head("name", "name")}{head("path", "folder")}{head("projects", "projects")}
              <th>selected</th>{head("end", "simulated [s]")}<th>outputs</th>
              {cols.map((k) => <th key={k}>{k}</th>)}
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.uid} className={r.missing ? "excluded" : ""}>
                  <td className="mono nowrap"><a onClick={() => copy(r.uid)} title="copy">{r.uid}</a>
                    {copied === r.uid && <span className="small muted"> copied</span>}
                    {!r.id_written && !r.missing && <span className="tag" title="the case folder is not writable: the id is stored in the project only">not in folder</span>}</td>
                  <td className="mono">{r.name}</td>
                  <td className="mono small" title={r.path}>{r.path}{r.missing && <span className="error"> folder missing</span>}</td>
                  <td>{r.projects.map((p) => (
                    <a key={p.id} className="chip meta" onClick={() => onOpenProject(p.id)}
                       title={`${p.name}: ${p.case_id}${p.owner ? `\nowner ${p.owner}` : ""}${p.program ? `\nproject ${p.program}` : ""}${p.purpose ? `\npurpose ${p.purpose}` : ""}`}>{p.name}</a>))}</td>
                  <td className="small">{r.projects.filter((p) => p.included).length}/{r.projects.length}</td>
                  <td className="num">{fmt(r.info?.end_time_s)}</td>
                  <td className="small">{(r.info?.output_kinds ?? []).map((k) => <span key={k} className="tag">{k}</span>)}</td>
                  {cols.map((k) => <td key={k} className={typeof r.info?.settings?.[k] === "number" ? "num" : ""}>{fmt(r.info?.settings?.[k])}</td>)}
                </tr>))}
              {!shown.length && <tr><td colSpan={7 + cols.length} className="muted">{rows.length ? "No case matches the search." : "No cases yet: create a project."}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
