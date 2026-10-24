import { useEffect, useState } from "react";
import { api, type ProjectMeta, type ProjectSummary } from "./api";
import CaseCatalog from "./CaseCatalog";
import { META_FIELDS, metaValues } from "./ProjectMeta";

const when = (t: number) => new Date(t * 1000).toLocaleDateString();
const FILTER_KEY = "mstar_post.dashboard.filters";
type Filters = Partial<Record<keyof ProjectMeta, string>>;

// Start page: every project as a card; open one, create or delete.
export default function Dashboard({ projects, current, lastOpened, onOpen, onNew, onDelete, onFiles, onTheory }: {
  projects: ProjectSummary[];
  current: string | null;
  lastOpened: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (p: ProjectSummary) => void;
  onFiles: () => void;
  onTheory: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"projects" | "cases">("projects");
  const [meta, setMeta] = useState<Filters>(() => {
    try { return JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}"); } catch { return {}; }
  });
  useEffect(() => localStorage.setItem(FILTER_KEY, JSON.stringify(meta)), [meta]);
  const [runs, setRuns] = useState<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    projects.forEach((p) => api.runs(p.id).then((rs) => live && setRuns((m) => ({ ...m, [p.id]: rs.length }))).catch(() => undefined));
    return () => { live = false; };
  }, [projects.map((p) => p.id).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = filter.toLowerCase();
  const matchMeta = (p: ProjectSummary) => META_FIELDS.every(({ key }) => !meta[key] || (p[key] ?? "").trim() === meta[key]);
  const shown = [...projects]
    .filter((p) => matchMeta(p) && (!q || p.name.toLowerCase().includes(q) || p.root.toLowerCase().includes(q)
      || META_FIELDS.some(({ key }) => (p[key] ?? "").toLowerCase().includes(q))))
    .sort((a, b) => (a.id === lastOpened ? -1 : b.id === lastOpened ? 1 : b.created - a.created));
  const anyFilter = !!q || META_FIELDS.some(({ key }) => meta[key]);

  return (
    <div className="dashboard">
      <div className="panel welcome">
        <h2>M-Star Post</h2>
        <p>Post-process M-Star CFD results: compare the steady-state statistics of several cases,
          quantify dispersion, uniformity and heat transfer, and explore 2D/3D fields. Open a project
          below, then select the cases to work on.</p>
        <div className="feature-grid">
          {[["Compare cases", "Steady-state means of every Stats variable, mixing times, impeller power, Po, P/V, Kolmogorov scale and % differences to a reference case."],
            ["Dispersion & uniformity", "Interfacial area kinetics, drop size distributions, Hinze d_max, zonal CoV and segregation index for two-fluid runs."],
            ["Heat transfer", "Overall UA and U from wall heat flux and a lumped energy balance, with the film coefficient when the wall conducts."],
            ["2D / 3D fields", "Slices, isosurfaces, streamlines and LIC of any Volume output, up to four cases side by side with a shared color range."]]
            .map(([t, d]) => <div key={t} className="feature"><b>{t}</b><div className="small muted">{d}</div></div>)}
        </div>
        <div className="row">
          <button className="primary big" onClick={onNew}>New project</button>
          <span className="seg">
            <button className={view === "projects" ? "primary" : ""} onClick={() => setView("projects")}>Projects</button>
            <button className={view === "cases" ? "primary" : ""} onClick={() => setView("cases")} title="every case of every project with its unique case ID">All cases</button>
          </span>
          <span className="grow" />
          <button onClick={onFiles}>Browse files</button>
          <button onClick={onTheory}>Theory</button>
        </div>
      </div>
      {view === "cases" && <CaseCatalog onOpenProject={onOpen} />}
      {view === "projects" && <div className="panel">
        <div className="row">
          <h2 className="grow">Projects <span className="muted">({shown.length === projects.length ? projects.length : `${shown.length} of ${projects.length}`})</span></h2>
          {META_FIELDS.map(({ key, label }) => {
            const vals = metaValues(projects, key);
            return vals.length ? (
              <label key={key} className="small">{label}{" "}
                <select value={meta[key] ?? ""} onChange={(e) => setMeta({ ...meta, [key]: e.target.value || undefined })}>
                  <option value="">all</option>
                  {vals.map((v) => <option key={v} value={v}>{v}</option>)}
                </select></label>) : null;
          })}
          <input placeholder="search name, folder, owner..." value={filter} onChange={(e) => setFilter(e.target.value)} />
          {anyFilter && <button onClick={() => { setFilter(""); setMeta({}); }}>Clear</button>}
        </div>
        {!projects.length && <div className="muted">No projects yet. Create one from a study folder (all cases below it are found) or from a single case folder.</div>}
        {projects.length > 0 && !shown.length && <div className="muted">No project matches the filters.</div>}
        <div className="project-grid">
          {shown.map((p) => (
            <div key={p.id} className={`project-card${p.id === current ? " active" : ""}`} onClick={() => onOpen(p.id)}
                 role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(p.id)}>
              <div className="row">
                <b className="grow">{p.name}</b>
                {p.id === current ? <span className="tag">open</span> : p.id === lastOpened ? <span className="tag">last opened</span> : null}
                {p.single && <span className="tag">single case</span>}
              </div>
              <div className="small mono muted" title={p.root}>{p.root}</div>
              <div className="meta-chips">
                {META_FIELDS.map(({ key, label }) => p[key] ? (
                  <span key={key} className={`chip meta${meta[key] === p[key] ? " on" : ""}`} title={`${label}: ${p[key]} (click to filter)`}
                        onClick={(e) => { e.stopPropagation(); setMeta({ ...meta, [key]: meta[key] === p[key] ? undefined : p[key] }); }}>
                    <span className="muted">{key === "program" ? "project" : key}</span> {p[key]}</span>) : null)}
                {!p.owner && !p.program && !p.purpose && <span className="small muted">no owner / project / purpose set yet (open it to add them)</span>}
              </div>
              <div className="project-stats small">
                <span><b>{p.n_included}</b> of {p.n_cases} case{p.n_cases === 1 ? "" : "s"} selected</span>
                <span><b>{runs[p.id] ?? "…"}</b> run{runs[p.id] === 1 ? "" : "s"}</span>
                <span className="muted">created {when(p.created)}</span>
              </div>
              <div className="row">
                <button className="primary" onClick={(e) => { e.stopPropagation(); onOpen(p.id); }}>{p.id === current ? "Continue" : "Open"}</button>
                <span className="grow" />
                <button className="danger small" onClick={(e) => { e.stopPropagation(); onDelete(p); }} title="delete the project and its run outputs; case folders are not touched">Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>}
    </div>
  );
}
