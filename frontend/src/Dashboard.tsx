import { memo, useEffect, useMemo, useState } from "react";
import { cachedRuns, type ProjectMeta, type ProjectSummary } from "./api";
import CaseCatalog from "./CaseCatalog";
import { META_FIELDS, metaValues } from "./ProjectMeta";
import { useUser } from "./user";

const when = (t: number) => new Date(t * 1000).toLocaleDateString();
const FILTER_KEY = "mstar_post.dashboard.filters";
type Filters = Partial<Record<keyof ProjectMeta, string>>;
type SortKey = keyof ProjectMeta | "name" | "root" | "cases" | "runs" | "created";

// Start page: every project as a card; open one, create or delete.
export default memo(function Dashboard({ projects, current, lastOpened, onOpen, onNew, onDelete, onFiles, onTheory, onGpus }: {
  projects: ProjectSummary[];
  current: string | null;
  lastOpened: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (p: ProjectSummary) => void;
  onFiles: () => void;
  onTheory: () => void;
  onGpus: () => void;
}) {
  const [filter, setFilter] = useState("");
  const me = useUser();
  const [view, setView] = useState<"projects" | "cases">("projects");
  const [stored, setMeta] = useState<Filters>(() => {
    try { return JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}") ?? {}; } catch { return {}; }
  });
  // a stored filter value that no project has any more (project deleted, field edited) is ignored:
  // it would hide every project while its select shows "all" or is not there at all
  const idsKey = projects.map((p) => p.id).join("|");
  const options = useMemo(() => Object.fromEntries(META_FIELDS.map(({ key }) => [key, metaValues(projects, key)])) as Record<keyof ProjectMeta, string[]>,
    [projects]);
  const meta = useMemo<Filters>(() => (projects.length
    ? Object.fromEntries(Object.entries(stored).filter(([k, v]) => v && options[k as keyof ProjectMeta]?.includes(v))) : stored),
    [stored, options, projects.length]);
  useEffect(() => { if (projects.length) localStorage.setItem(FILTER_KEY, JSON.stringify(meta)); }, [meta, projects.length]);
  const [runs, setRuns] = useState<Record<string, number>>({});
  const [layout, setLayout] = useState<"tiles" | "table">(() => (localStorage.getItem("mstar_post.dashboard.layout") as "table" | null) ?? "tiles");
  useEffect(() => localStorage.setItem("mstar_post.dashboard.layout", layout), [layout]);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean } | null>(null);
  // run counts: from the shared run-list cache, two requests at a time (they must not queue in front of
  // the requests of a project being opened); leaving the dashboard stops the remaining ones
  useEffect(() => {
    let alive = true;
    const todo = projects.map((p) => p.id);
    const next = (): Promise<void> => {
      const id = todo.shift();
      if (!alive || !id) return Promise.resolve();
      return cachedRuns(id, 60000).then((rs) => { if (alive) setRuns((m) => (m[id] === rs.length ? m : { ...m, [id]: rs.length })); })
        .catch(() => undefined).then(next);
    };
    void next();
    void next();
    return () => { alive = false; };
  }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = filter.toLowerCase();
  const matchMeta = (p: ProjectSummary) => META_FIELDS.every(({ key }) => !meta[key] || (p[key] ?? "").trim() === meta[key]);
  const shown = [...projects]
    .filter((p) => matchMeta(p) && (!q || p.name.toLowerCase().includes(q) || p.root.toLowerCase().includes(q)
      || META_FIELDS.some(({ key }) => (p[key] ?? "").toLowerCase().includes(q))))
    .sort((a, b) => (a.id === lastOpened ? -1 : b.id === lastOpened ? 1 : b.created - a.created));
  const anyFilter = !!q || META_FIELDS.some(({ key }) => meta[key]);
  const sortVal = (p: ProjectSummary, k: SortKey): string | number => k === "cases" ? p.n_included : k === "runs" ? runs[p.id] ?? -1
    : k === "created" ? p.created : (k === "name" ? p.name : k === "root" ? p.root : p[k] ?? "").toLowerCase();
  const rows = sort ? [...shown].sort((a, b) => {
    const x = sortVal(a, sort.key), y = sortVal(b, sort.key);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sort.asc ? c : -c;
  }) : shown;
  const head = (k: SortKey, label: string) => (
    <th className="sortable" onClick={() => setSort({ key: k, asc: sort?.key === k ? !sort.asc : k !== "created" && k !== "runs" && k !== "cases" })}>
      {label}{sort?.key === k ? (sort.asc ? " \u25b2" : " \u25bc") : ""}</th>);

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
          {me.user ? <button className="primary big" onClick={onNew}>New project</button>
            : <span className="muted">You are viewing as a guest: open any project to look at its results. Log in (header) to create projects, select cases and run calculations.</span>}
          <span className="seg">
            <button className={view === "projects" ? "primary" : ""} onClick={() => setView("projects")}>Projects</button>
            <button className={view === "cases" ? "primary" : ""} onClick={() => setView("cases")} title="every case of every project with its unique case ID">All cases</button>
          </span>
          <span className="grow" />
          <button onClick={onFiles}>Browse files</button>
          <button onClick={onGpus} title="which GPUs are free and what is running on them">GPUs</button>
          <button onClick={onTheory}>Theory</button>
        </div>
      </div>
      {view === "cases" && <CaseCatalog onOpenProject={onOpen} />}
      {view === "projects" && <div className="panel">
        <div className="row">
          <h2 className="grow">Projects <span className="muted">({shown.length === projects.length ? projects.length : `${shown.length} of ${projects.length}`})</span></h2>
          {META_FIELDS.map(({ key, label }) => {
            const vals = options[key];
            return vals.length ? (
              <label key={key} className="small">{label}{" "}
                <select value={meta[key] ?? ""} onChange={(e) => setMeta({ ...meta, [key]: e.target.value || undefined })}>
                  <option value="">all</option>
                  {vals.map((v) => <option key={v} value={v}>{v}</option>)}
                </select></label>) : null;
          })}
          <input placeholder="search name, folder, owner..." value={filter} onChange={(e) => setFilter(e.target.value)} />
          {anyFilter && <button onClick={() => { setFilter(""); setMeta({}); }}>Clear</button>}
          <span className="seg">
            <button className={layout === "tiles" ? "primary" : ""} onClick={() => setLayout("tiles")} title="one card per project">Tiles</button>
            <button className={layout === "table" ? "primary" : ""} onClick={() => setLayout("table")} title="one row per project, sortable columns">Table</button>
          </span>
        </div>
        {!projects.length && <div className="muted">No projects yet. Create one from a study folder (all cases below it are found) or from a single case folder.</div>}
        {projects.length > 0 && !shown.length && <div className="muted">No project matches the filters.</div>}
        {layout === "table" && shown.length > 0 && (
          <div className="tablewrap">
            <table className="grid project-table">
              <thead><tr>{head("name", "name")}{head("owner", "owner")}{head("program", "project")}{head("purpose", "purpose")}
                {head("cases", "cases selected")}{head("runs", "runs")}{head("created", "created")}{head("root", "folder")}<th /></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.id} className={`clickable${p.id === current ? " selected" : ""}`} onClick={() => onOpen(p.id)}>
                  <td><b>{p.name}</b>{" "}
                    {p.id === current ? <span className="tag">open</span> : p.id === lastOpened ? <span className="tag">last opened</span> : null}
                    {p.single && <span className="tag">single case</span>}</td>
                  {META_FIELDS.map(({ key, label }) => (
                    <td key={key} className="small">{p[key] && (
                      <span className={`chip meta${meta[key] === p[key] ? " on" : ""}`} title={`${label}: ${p[key]} (click to filter)`}
                            onClick={(e) => { e.stopPropagation(); setMeta({ ...meta, [key]: meta[key] === p[key] ? undefined : p[key] }); }}>{p[key]}</span>)}</td>))}
                  <td className="num">{p.n_included} / {p.n_cases}</td>
                  <td className="num">{runs[p.id] ?? "\u2026"}</td>
                  <td className="small">{when(p.created)}</td>
                  <td className="small mono muted" title={p.root}>{p.root}</td>
                  <td className="nowrap">
                    <button className="primary small" onClick={(e) => { e.stopPropagation(); onOpen(p.id); }}>{p.id === current ? "Continue" : "Open"}</button>{" "}
                    {me.canManage(p.owner) && <button className="danger small" onClick={(e) => { e.stopPropagation(); onDelete(p); }}
                      title="delete the project and its run outputs; case folders are not touched">Delete</button>}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
        {layout === "tiles" && <div className="project-grid">
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
                {me.canManage(p.owner) && <button className="danger small" onClick={(e) => { e.stopPropagation(); onDelete(p); }} title="delete the project and its run outputs; case folders are not touched">Delete</button>}
              </div>
            </div>
          ))}
        </div>}
      </div>}
    </div>
  );
});
