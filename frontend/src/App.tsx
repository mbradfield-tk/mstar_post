import { useEffect, useState } from "react";
import { api, type Job, type Project, type ProjectSummary } from "./api";
import CasesView from "./CasesView";
import DirBrowser from "./DirBrowser";
import JobsView from "./JobsView";
import PlotsView from "./PlotsView";
import ResultsView from "./ResultsView";
import RunView from "./RunView";
import ViewerView from "./ViewerView";

const TABS = ["Cases", "Run", "Jobs", "Results", "Plots", "Viewer"] as const;
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

  const reloadList = () => api.projects().then(setProjects).catch((e) => setError(e.message));
  useEffect(() => { reloadList(); }, []);
  useEffect(() => {
    setProject(null);
    setRun(null);
    setJob(null);
    if (!pid) return;
    localStorage.setItem("mstar_post.project", pid);
    api.project(pid).then(setProject).catch((e) => { setError(e.message); setPid(null); });
  }, [pid]);

  const onSubmitted = (j: Job) => {
    setJob(j.id);
    setTab("Jobs");
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
            <button key={t} className={t === tab ? "tab active" : "tab"} disabled={!project}
                    onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
      </header>
      {error && <div className="error banner" onClick={() => setError(null)}>{error} (click to dismiss)</div>}
      {creating && <NewProject onClose={() => setCreating(false)} onCreated={(p) => {
        setCreating(false);
        reloadList();
        setPid(p.id);
        setTab("Cases");
      }} />}
      <main>
        {!project && !creating && (
          <div className="panel welcome">
            <h2>Post-process M-Star CFD results</h2>
            <p>Create a project from a folder of cases (searched recursively, e.g. a study with
              several reactor folders each holding sub-cases) or a single case folder. Then pick the
              cases to include, run calculations, and explore the tables, plots and 2D/3D fields.
              Outputs are written to the project folder; case folders are never modified.</p>
            <button className="primary big" onClick={() => setCreating(true)}>New project</button>
          </div>
        )}
        {project && tab === "Cases" && <CasesView project={project} onChange={setProject} />}
        {project && tab === "Run" && <RunView project={project} onSubmitted={onSubmitted} />}
        {project && tab === "Jobs" && (
          <JobsView project={project.id} selected={job} onSelect={setJob} onOpenResults={() => {
            setRun(null);
            setTab("Results");
          }} />
        )}
        {project && tab === "Results" && <ResultsView project={project} runName={run} onRunChange={setRun} />}
        {project && tab === "Plots" && <PlotsView project={project} />}
        {project && tab === "Viewer" && <ViewerView project={project} />}
      </main>
    </div>
  );
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
