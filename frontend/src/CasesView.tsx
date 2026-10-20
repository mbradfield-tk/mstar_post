import { useMemo, useState } from "react";
import { api, download, fmt, toCsv, type Project, type ProjectCase } from "./api";

// Key settings shown as columns (matched by prefix).
const KEY_SETTINGS = ["Impeller speed", "Fluid volume", "dx [m]", "Fluid 1 name",
  "Fluid 2 name", "Surface tension", "Max Courant"];

function settingCols(cases: ProjectCase[]): string[] {
  const keys = new Set<string>();
  cases.forEach((c) => Object.keys(c.info?.settings ?? {}).forEach((k) => keys.add(k)));
  const out: string[] = [];
  for (const pre of KEY_SETTINGS) {
    for (const k of keys) if (k.startsWith(pre) && !out.includes(k)) out.push(k);
  }
  return out;
}

export default function CasesView({ project, onChange }: {
  project: Project;
  onChange: (p: Project) => void;
}) {
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const cols = useMemo(() => settingCols(project.cases), [project]);
  const shown = project.cases.filter((c) => c.id.toLowerCase().includes(filter.toLowerCase()));
  const groups = useMemo(() => {
    const g = new Map<string, ProjectCase[]>();
    for (const c of shown) {
      const k = c.id.includes("/") ? c.id.slice(0, c.id.lastIndexOf("/")) : "";
      g.set(k, [...(g.get(k) ?? []), c]);
    }
    return g;
  }, [shown]);

  const patch = async (body: Parameters<typeof api.patchProject>[1]) => {
    setError(null);
    try {
      const p = await api.patchProject(project.id, body);
      onChange({ ...p, cases: p.cases.map((c) => ({ ...c, info: project.cases.find((o) => o.id === c.id)?.info })) });
    } catch (e) { setError((e as Error).message); }
  };
  const setIncluded = (ids: string[], v: boolean) =>
    patch({ included: Object.fromEntries(ids.map((id) => [id, v])) });

  const rediscover = async () => {
    setBusy(true);
    try {
      await api.rediscover(project.id);
      onChange(await api.project(project.id));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const exportTable = () => download(`${project.id}_cases.csv`, toCsv(
    ["case", "included", "end_time_s", ...cols],
    project.cases.map((c) => [c.id, c.included, c.info?.end_time_s ?? "",
      ...cols.map((k) => c.info?.settings?.[k] ?? "")])));

  const nIncl = project.cases.filter((c) => c.included).length;
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow">Cases <span className="muted">({nIncl} of {project.cases.length} included)</span></h2>
        <input placeholder="filter cases" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={() => setIncluded(shown.map((c) => c.id), true)}>Include shown</button>
        <button onClick={() => setIncluded(shown.map((c) => c.id), false)}>Exclude shown</button>
        <button onClick={() => setShowDiff(!showDiff)}>{showDiff ? "Hide" : "Compare"} settings</button>
        <button onClick={exportTable}>Export CSV</button>
        <button disabled={busy} onClick={rediscover}>{busy ? "Scanning..." : "Rediscover"}</button>
      </div>
      <div className="muted small mono">{project.root}</div>
      {error && <div className="error">{error}</div>}
      {showDiff && <SettingsDiff cases={project.cases.filter((c) => c.included)} />}
      <table className="grid">
        <thead>
          <tr>
            <th title="include in post-processing">incl.</th>
            <th title="reference case for % differences">ref</th>
            <th>case</th><th>end t [s]</th><th>outputs</th>
            {cols.map((k) => <th key={k}>{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...groups].map(([g, cs]) => [
            g && (
              <tr key={`g-${g}`} className="group">
                <td><input type="checkbox" checked={cs.every((c) => c.included)}
                           onChange={(e) => setIncluded(cs.map((c) => c.id), e.target.checked)} /></td>
                <td colSpan={4 + cols.length}><b>{g}</b> <span className="muted">({cs.length})</span></td>
              </tr>
            ),
            ...cs.map((c) => (
              <tr key={c.id} className={c.included ? "" : "excluded"}>
                <td><input type="checkbox" checked={c.included}
                           onChange={(e) => setIncluded([c.id], e.target.checked)} /></td>
                <td><input type="radio" checked={project.ref_case === c.id}
                           onChange={() => patch({ ref_case: c.id })} /></td>
                <td className="mono" title={c.path}>{g ? c.id.slice(g.length + 1) : c.id}
                  {c.info?.error && <span className="error"> {c.info.error}</span>}</td>
                <td>{fmt(c.info?.end_time_s)}</td>
                <td className="small">{(c.info?.output_kinds ?? []).map((k) =>
                  <span key={k} className="tag">{k}</span>)}</td>
                {cols.map((k) => <td key={k}>{fmt(c.info?.settings?.[k])}</td>)}
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}

function SettingsDiff({ cases }: { cases: ProjectCase[] }) {
  const keys = useMemo(() => {
    const s = new Set<string>();
    cases.forEach((c) => Object.keys(c.info?.settings ?? {}).forEach((k) => s.add(k)));
    return [...s];
  }, [cases]);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const rows = keys.map((k) => {
    const vals = cases.map((c) => c.info?.settings?.[k]);
    const differs = new Set(vals.map((v) => fmt(v, 6))).size > 1;
    return { k, vals, differs };
  }).filter((r) => !onlyDiff || r.differs);
  return (
    <div className="card">
      <label><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
        only settings that differ between included cases</label>
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>setting</th>{cases.map((c) => <th key={c.id} className="mono">{c.id}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k} className={r.differs ? "differs" : ""}>
                <td>{r.k}</td>{r.vals.map((v, i) => <td key={i}>{fmt(v, 6)}</td>)}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={cases.length + 1} className="muted">no differences</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
