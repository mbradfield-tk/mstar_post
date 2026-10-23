import { useEffect, useRef, useState } from "react";
import { api, type Job, type Project, type ProjectSummary } from "./api";
import CasesView from "./CasesView";
import DirBrowser from "./DirBrowser";
import JobsView from "./JobsView";
import PlotsView from "./PlotsView";
import ResultsView from "./ResultsView";
import RunView from "./RunView";
import TheoryView from "./TheoryView";
import ViewerView from "./ViewerView";

const TABS = ["Cases", "Run", "Jobs", "Results", "Plots", "Viewer", "Theory"] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [pid, setPid] = useState<string | null>(() => localStorage.getItem("mstar_post.project"));
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>("Cases");
  const [creating, setCreating] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    if (!project || !confirm(`Delete project "${project.name}" and all its run outputs? Case folders are not touched.`)) return;
    try {
      await api.deleteProject(project.id);
      localStorage.removeItem("mstar_post.project");
      setPid(null);
      reloadList();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="app">
      <header>
        <b className="brand">M-Star Post</b>
        <select value={pid ?? ""} onChange={(e) => setPid(e.target.value || null)}>
          <option value="">select a project...</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.n_included}/{p.n_cases})</option>)}
        </select>
        <button onClick={() => setCreating(true)}>New project</button>
        {project && <button onClick={del}>Delete project</button>}
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "tab active" : "tab"} disabled={!project && t !== "Theory"}
                    onClick={() => go(t)}>{t}</button>
          ))}
        </nav>
      </header>
      {error && <div className="error banner" onClick={() => setError(null)}>{error} (click to dismiss)</div>}
      {creating && <NewProject onClose={() => setCreating(false)} onCreated={(p) => {
        setCreating(false);
        reloadList();
        setPid(p.id);
        go("Cases");
      }} />}
      <main>
        {visited.has("Theory") && <Pane show={tab === "Theory"}><TheoryView /></Pane>}
        {!project && !creating && tab !== "Theory" && (
          <div className="panel welcome">
            <h2>Post-process M-Star CFD results</h2>
            <p>Create a project from a folder of cases (searched recursively, e.g. a study with
              several reactor folders each holding sub-cases) or a single case folder. Then pick the
              cases to include, run calculations, and explore the tables, plots and 2D/3D fields.
              Outputs are written to the project folder; case folders are never modified.</p>
            <button className="primary big" onClick={() => setCreating(true)}>New project</button>
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
                reset("Plots");
              }} />)}
            {pane("Viewer", <ViewerView project={project} />)}
          </>;
        })()}
      </main>
    </div>
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
