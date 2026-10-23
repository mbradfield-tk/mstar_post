import { useEffect, useRef, useState } from "react";
import { api, type Job, type Project, type ProjectSummary } from "./api";
import { THEME_KEY, ThemeContext, type Theme } from "./theme";
import CasesView from "./CasesView";
import DirBrowser from "./DirBrowser";
import { useDialog } from "./Dialog";
import FilesView from "./FilesView";
import Relocate from "./Relocate";
import JobsView from "./JobsView";
import PlotsView from "./PlotsView";
import ResultsView from "./ResultsView";
import RunView from "./RunView";
import TheoryView from "./TheoryView";
import ViewerView from "./ViewerView";

const TABS = ["Cases", "Run", "Jobs", "Results", "Plots", "Viewer", "Files", "Theory"] as const;
const GLOBAL_TABS: readonly string[] = ["Files", "Theory"];  // usable without a project
type Tab = (typeof TABS)[number];

// number of queued/running jobs of a project, kept live over the jobs WebSocket
function useActiveJobs(pid: string | null): number {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    setJobs([]);
    if (!pid) return;
    api.jobs(pid).then(setJobs).catch(() => undefined);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/jobs/ws`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "job_deleted") setJobs((js) => js.filter((j) => j.id !== m.id));
      else if (m.type === "job" && m.job.project === pid)
        setJobs((js) => (js.some((j) => j.id === m.job.id) ? js.map((j) => (j.id === m.job.id ? m.job : j)) : [m.job, ...js]));
    };
    const ping = setInterval(() => ws.readyState === 1 && ws.send("ping"), 30000);
    return () => { clearInterval(ping); ws.close(); };
  }, [pid]);
  return jobs.filter((j) => j.status === "queued" || j.status === "running").length;
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [pid, setPid] = useState<string | null>(() => localStorage.getItem("mstar_post.project"));
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>("Cases");
  const [creating, setCreating] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ui = useDialog();
  const activeJobs = useActiveJobs(pid);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  // tabs stay mounted once opened so their state survives switching
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(["Cases"]));
  const [resets, setResets] = useState<Partial<Record<Tab, number>>>({});
  const scrolls = useRef<Partial<Record<Tab, number>>>({});

  const go = (t: Tab) => {
    scrolls.current[tab] = window.scrollY;
    setVisited((v) => (v.has(t) ? v : new Set(v).add(t)));
    setTab(t);
  };
  const reset = (t: Tab) => setResets((r) => ({ ...r, [t]: (r[t] ?? 0) + 1 }));
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      window.scrollTo(0, scrolls.current[tab] ?? 0);
      window.dispatchEvent(new Event("resize"));  // Plotly sizes plots drawn while hidden
    });
    return () => cancelAnimationFrame(id);
  }, [tab]);

  const reloadList = () => api.projects().then(setProjects).catch((e) => setError(e.message));
  useEffect(() => { reloadList(); }, []);
  useEffect(() => {
    setProject(null);
    setRun(null);
    setJob(null);
    setVisited(new Set([tab]));
    scrolls.current = {};
    if (!pid) return;
    localStorage.setItem("mstar_post.project", pid);
    api.project(pid).then(setProject).catch((e) => { setError(e.message); setPid(null); });
  }, [pid]);

  const onSubmitted = (j: Job) => {
    setJob(j.id);
    go("Jobs");
  };

  const del = async () => {
    if (!project || !await ui.confirm({ title: "Delete project?", ok: "Delete project", danger: true,
      body: <p>Delete <b>{project.name}</b> and all its run outputs? Case folders are not touched.</p> })) return;
    try {
      await api.deleteProject(project.id);
      localStorage.removeItem("mstar_post.project");
      setPid(null);
      reloadList();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <ThemeContext.Provider value={theme}>
    <div className="app">
      <header>
        <b className="brand">M-Star Post</b>
        <div className="project-bar">
          <select value={pid ?? ""} onChange={(e) => setPid(e.target.value || null)} title="project">
            <option value="">Select a project...</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.n_included}/{p.n_cases})</option>)}
          </select>
          <button onClick={() => setCreating(true)} title="create a project from a study or case folder">New</button>
          {project && <button className="danger" onClick={del} title="delete this project and its run outputs">Delete</button>}
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "tab active" : "tab"} disabled={!project && !GLOBAL_TABS.includes(t)}
                    title={!project && !GLOBAL_TABS.includes(t) ? "select or create a project first" : undefined}
                    onClick={() => go(t)}>{t}{t === "Jobs" && activeJobs > 0 && <span className="badge pulse" title={`${activeJobs} running or queued`}>{activeJobs}</span>}</button>
          ))}
        </nav>
        <button className="tab theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                title="switch between dark and light mode">{theme === "dark" ? "Light" : "Dark"}</button>
      </header>
      {ui.dialog}
      {error && <div className="error banner" onClick={() => setError(null)}>{error} <span className="dismiss">(click to dismiss)</span></div>}
      {creating && <NewProject onClose={() => setCreating(false)} onCreated={(p) => {
        setCreating(false);
        reloadList();
        setPid(p.id);
        go("Cases");
      }} />}
      <main>
        {project && !GLOBAL_TABS.includes(tab) && (
          <Relocate key={project.id} project={project} onChange={(p) => {
            setProject(p);
            reset("Viewer");
            reset("Plots");
          }} />
        )}
        {visited.has("Theory") && <Pane show={tab === "Theory"}><TheoryView /></Pane>}
        {visited.has("Files") && <Pane show={tab === "Files"}><FilesView /></Pane>}
        {!project && !creating && !GLOBAL_TABS.includes(tab) && (
          <div className="panel welcome">
            <h2>Post-process M-Star CFD results</h2>
            <p>Create a project from a folder of cases (searched recursively, e.g. a study with
              several reactor folders each holding sub-cases) or a single case folder. Then pick the
              cases to include, run calculations, and explore the tables, plots and 2D/3D fields.
              Outputs are written to the project folder; case folders are never modified.</p>
            <div className="feature-grid">
              {[["Compare cases", "Steady-state means of every Stats variable, mixing times, impeller power, Po, P/V, Kolmogorov scale and % differences to a reference case."],
                ["Dispersion & uniformity", "Interfacial area kinetics, drop size distributions, Hinze d_max, zonal CoV and segregation index for two-fluid runs."],
                ["Heat transfer", "Overall UA and U from wall heat flux and a lumped energy balance, with the film coefficient when the wall conducts."],
                ["2D / 3D fields", "Slices, isosurfaces, streamlines and LIC of any Volume output, up to four cases side by side with a shared color range."]]
                .map(([t, d]) => <div key={t} className="feature"><b>{t}</b><div className="small muted">{d}</div></div>)}
            </div>
            <div className="row">
              <button className="primary big" onClick={() => setCreating(true)}>New project</button>
              {projects.length > 0 && <span className="muted">or pick one of the {projects.length} existing projects in the header</span>}
              <span className="grow" />
              <button onClick={() => go("Files")}>Browse files</button>
              <button onClick={() => go("Theory")}>Theory</button>
            </div>
          </div>
        )}
        {project && (() => {
          const pane = (t: Tab, el: JSX.Element) => visited.has(t) && (
            <Pane key={`${t}|${project.id}|${resets[t] ?? 0}`} show={tab === t}>{el}</Pane>);
          return <>
            {pane("Cases", <CasesView project={project} onChange={setProject} />)}
            {pane("Run", <RunView project={project} onSubmitted={onSubmitted} />)}
            {pane("Jobs", <JobsView project={project.id} selected={job} onSelect={setJob} onOpenResults={() => {
              setRun(null);
              go("Results");
            }} />)}
            {pane("Results", <ResultsView project={project} runName={run} onRunChange={setRun}
              onProjectChange={setProject} active={tab === "Results"}
              onReset={() => { setRun(null); reset("Results"); }} />)}
            {pane("Plots", <PlotsView project={project} onProjectChange={setProject} active={tab === "Plots"}
              onReset={() => {
                localStorage.removeItem(`mstar_post.plots.${project.id}`);
                localStorage.removeItem(`mstar_post.means.${project.id}`);
                localStorage.removeItem(`mstar_post.plotref.${project.id}`);
                localStorage.removeItem(`mstar_post.plots.hidden.${project.id}`);
                reset("Plots");
              }} />)}
            {pane("Viewer", <ViewerView project={project} onRefresh={() => {
              api.project(project.id, true).then((p) => { setProject(p); reset("Viewer"); })
                .catch((e) => setError(e.message));
            }} />)}
          </>;
        })()}
      </main>
    </div>
    </ThemeContext.Provider>
  );
}

function Pane({ show, children }: { show: boolean; children: React.ReactNode }) {
  return <div style={{ display: show ? "contents" : "none" }}>{children}</div>;
}

function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [root, setRoot] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createProject(name || root.split("/").filter(Boolean).slice(-2).join("_"), root));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="panel">
      <div className="row"><h2 className="grow">New project</h2><button onClick={onClose}>Close</button></div>
      <p className="muted">Pick a study folder (all cases below it are discovered) or a single case folder.</p>
      <DirBrowser onSelect={setRoot} />
      <div className="row">
        <label>Folder <input className="wide mono" value={root} onChange={(e) => setRoot(e.target.value)} /></label>
        <label>Name <input value={name} placeholder="default: folder name" onChange={(e) => setName(e.target.value)} /></label>
        <button className="primary" disabled={!root || busy} onClick={create}>{busy ? "Discovering cases..." : "Create"}</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
