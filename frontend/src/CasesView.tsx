import { useMemo, useState } from "react";
import { api, caseName, download, fmt, toCsv, type Project, type ProjectCase } from "./api";
import ProjectMetaEditor from "./ProjectMeta";
import { useUser } from "./user";

// Key settings shown as columns (matched by prefix).
const KEY_SETTINGS = ["Volume [L]", "Agitator speed [rpm]", "Simulated time (input runtime)", "Wall time", "Iterations",
  "Fluid 1 name", "Fluid 2 name", "dx [m]", "Impeller diameter", "Surface tension", "Max Courant"];
const END = "Simulated time (end) [s]", RUNTIME = "Simulated time (input runtime) [s]",
      WALL = "Wall time (cumulative) [h]", ITER = "Iterations [count]";
const num = (v: unknown) => (typeof v === "number" ? v : null);

export function simTime(c: ProjectCase) {
  const s = c.info?.settings ?? {};
  const end = num(s[END]) ?? c.info?.end_time_s ?? null, runtime = num(s[RUNTIME]);
  return { end, runtime, wall: num(s[WALL]), iter: num(s[ITER]),
           done: end !== null && runtime !== null && runtime > 0 ? end / runtime : null };
}

export function simTimeSummary(cases: ProjectCase[]) {
  const t = cases.map(simTime);
  const sum = (k: "end" | "wall") => t.reduce((a, x) => a + (x[k] ?? 0), 0);
  const complete = t.filter((x) => x.done !== null && x.done >= 0.999).length;
  return `simulated ${fmt(sum("end"))} s in total, ${complete} of ${cases.length} cases ran to the input runtime, `
    + `wall time ${fmt(sum("wall"))} h in total`;
}

// Per-case simulated time, input runtime, progress, iterations and wall time.
export function SimTimeTable({ project, cases }: { project: Project; cases: ProjectCase[] }) {
  return (
    <table className="grid narrow">
      <thead><tr><th>case</th><th>simulated [s]</th><th>input runtime [s]</th><th>progress [%]</th>
        <th>iterations [count]</th><th>wall time [h]</th></tr></thead>
      <tbody>{cases.map((c) => {
        const t = simTime(c);
        return (
          <tr key={c.id}><td className="mono" title={c.id}>{caseName(project, c.id)}</td><td className="num">{fmt(t.end)}</td>
            <td className="num">{fmt(t.runtime)}</td>
            <td className={`num${t.done !== null && t.done < 0.999 ? " error" : ""}`}>{t.done === null ? "" : fmt(100 * t.done, 4)}</td>
            <td className="num">{fmt(t.iter)}</td><td className="num">{fmt(t.wall)}</td></tr>
        );
      })}</tbody>
    </table>
  );
}

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
    ["case", "case_id", "included", "end_time_s", ...cols],
    project.cases.map((c) => [c.id, c.uid ?? "", c.included, c.info?.end_time_s ?? "",
      ...cols.map((k) => c.info?.settings?.[k] ?? "")])));

  const nIncl = project.cases.filter((c) => c.included).length;
  const me = useUser();
  const ro = !me.user;  // guests see the table but change nothing
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow">Cases <span className="muted">({nIncl} of {project.cases.length} selected)</span></h2>
        <input placeholder="filter cases" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button disabled={ro} onClick={() => setIncluded(shown.map((c) => c.id), true)}>Select shown</button>
        <button disabled={ro} onClick={() => setIncluded(shown.map((c) => c.id), false)}>Deselect shown</button>
        <button onClick={() => setShowDiff(!showDiff)}>{showDiff ? "Hide" : "Compare"} settings</button>
        <button onClick={exportTable}>Export CSV</button>
        <button disabled={busy || ro} onClick={rediscover}>{busy ? "Scanning..." : "Rediscover"}</button>
      </div>
      <div className="muted small mono">{project.root}</div>
      {ro ? (
        <div className="row small meta-row">
          {project.owner && <span><span className="muted">Owner</span> {project.owner}</span>}
          {project.program && <span><span className="muted">Associated project</span> {project.program}</span>}
          {project.purpose && <span><span className="muted">Purpose</span> {project.purpose}</span>}
          <span className="muted">Viewing as guest: log in to select cases or edit the project.</span>
        </div>
      ) : <ProjectMetaEditor project={project} onChange={onChange} />}
      <div className="small">
        <span className="muted">Tick the cases to work on: only selected cases are used by Run, Plots, Viewer and the case time series until you change the selection. </span>
        Selected cases: {simTimeSummary(project.cases.filter((c) => c.included))}
      </div>
      {!nIncl && project.cases.length > 0 && <div className="error">No case is selected: the Run, Plots and Viewer tabs have nothing to work on.</div>}
      {error && <div className="error">{error}</div>}
      {showDiff && <SettingsDiff cases={project.cases.filter((c) => c.included)} />}
      <div className="scroll-x">
      <table className="grid">
        <thead>
          <tr>
            <th title="selected: used by Run, Plots, Viewer and the case time series">sel.</th>
            <th title="reference case for % differences">ref</th>
            <th>case</th><th title="unique case ID across all projects (stored in mstar_post_case.json in the case folder)">ID</th><th>simulated [s]</th><th>outputs</th>
            {cols.map((k) => <th key={k}>{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...groups].map(([g, cs]) => [
            g && (
              <tr key={`g-${g}`} className="group">
                <td><input type="checkbox" checked={cs.every((c) => c.included)} disabled={ro}
                           onChange={(e) => setIncluded(cs.map((c) => c.id), e.target.checked)} /></td>
                <td colSpan={5 + cols.length}><b>{g}</b> <span className="muted">({cs.length})</span></td>
              </tr>
            ),
            ...cs.map((c) => (
              <tr key={c.id} className={c.included ? "" : "excluded"}>
                <td><input type="checkbox" checked={c.included} disabled={ro}
                           onChange={(e) => setIncluded([c.id], e.target.checked)} /></td>
                <td><input type="radio" checked={project.ref_case === c.id} disabled={ro}
                           onChange={() => patch({ ref_case: c.id })} /></td>
                <td className="mono" title={c.path}>{g ? c.id.slice(g.length + 1) : c.id}
                  {c.info?.error && <span className="error"> {c.info.error}</span>}</td>
                <td className="mono small nowrap" title={c.id_written === false ? "the case folder is not writable: the id is stored in the project only" : "written to mstar_post_case.json in the case folder"}>
                  {c.uid ?? ""}{c.id_written === false && <span className="tag">not in folder</span>}</td>
                <td className="num">{fmt(simTime(c).end)}</td>
                <td className="small">{(c.info?.output_kinds ?? []).map((k) =>
                  <span key={k} className="tag">{k}</span>)}</td>
                {cols.map((k) => <td key={k} className={typeof c.info?.settings?.[k] === "number" ? "num" : ""}>{fmt(c.info?.settings?.[k])}</td>)}
              </tr>
            )),
          ])}
          {!shown.length && <tr><td colSpan={6 + cols.length} className="muted">
            {project.cases.length ? "No case matches the filter." : "No cases found under this folder: check the path or use Rediscover."}</td></tr>}
        </tbody>
      </table>
      </div>
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
        only settings that differ between selected cases</label>
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>setting</th>{cases.map((c) => <th key={c.id} className="mono">{c.id}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k} className={r.differs ? "differs" : ""}>
                <td>{r.k}</td>{r.vals.map((v, i) => <td key={i} className={typeof v === "number" ? "num" : ""}>{fmt(v, 6)}</td>)}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={cases.length + 1} className="muted">no differences</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
