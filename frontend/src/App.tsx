import { useEffect, useRef, useState } from "react";
import { api, type Job, type Project, type ProjectMeta, type ProjectSummary } from "./api";
import { THEME_KEY, ThemeContext, type Theme } from "./theme";
import { logout, useUser } from "./user";
import LoginDialog from "./Login";
import CasesView from "./CasesView";
import Dashboard from "./Dashboard";
import DirBrowser from "./DirBrowser";
import { useDialog } from "./Dialog";
import FilesView from "./FilesView";
import GpuView from "./GpuView";
import Relocate from "./Relocate";
import JobsView from "./JobsView";
import PlotsView from "./PlotsView";
import { META_FIELDS, metaValues } from "./ProjectMeta";
import ResultsView from "./ResultsView";
import RunView from "./RunView";
import TheoryView from "./TheoryView";
import ViewerView from "./ViewerView";

const TABS = ["Cases", "Run", "Jobs", "Results", "Plots", "Viewer", "Files", "GPUs", "Theory"] as const;
const GLOBAL_TABS: readonly string[] = ["Files", "GPUs", "Theory"];  // usable without a project
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
  // the app starts on the dashboard; the last project is only pre-selected there
  const [pid, setPid] = useState<string | null>(null);
  const lastOpened = localStorage.getItem("mstar_post.project");
  const [home, setHome] = useState(true);
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>("Cases");
  const [creating, setCreating] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ui = useDialog();
  const activeJobs = useActiveJobs(pid);
  const me = useUser();
  const [loginOpen, setLoginOpen] = useState<false | { reason?: string }>(false);
  useEffect(() => {
    const on = () => setLoginOpen({ reason: "That needs a login (your session may have expired)." });
    window.addEventListener("mstar_post:login-needed", on);
    return () => window.removeEventListener("mstar_post:login-needed", on);
  }, []);
  const doLogout = async () => {
    try { await logout(); } catch (e) { setError((e as Error).message); }
  };
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
    setHome(false);
  };
  const open = (id: string) => {
    if (id !== pid) { setPid(id); setTab("Cases"); }
    setHome(false);
    setCreating(false);
  };
  const reset = (t: Tab) => setResets((r) => ({ ...r, [t]: (r[t] ?? 0) + 1 }));
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      window.scrollTo(0, scrolls.current[tab] ?? 0);
      window.dispatchEvent(new Event("resize"));  // Plotly sizes plots drawn while hidden
    });
    return () => cancelAnimationFrame(id);
  }, [tab, home]);

  const reloadList = () => api.projects().then(setProjects).catch((e) => setError(e.message));
  useEffect(() => { reloadList(); }, []);
  // keep the dashboard / header counts in step with case selection changes
  useEffect(() => {
    if (!project) return;
    setProjects((ps) => ps.map((s) => (s.id === project.id
      ? { ...s, name: project.name, owner: project.owner, program: project.program, purpose: project.purpose,
          n_cases: project.cases.length, n_included: project.cases.filter((c) => c.included).length } : s)));
  }, [project]);
  useEffect(() => {
    setProject(null);
    setRun(null);
    setJob(null);
    setVisited(new Set(["Cases"]));
    scrolls.current = {};
    if (!pid) return;
    localStorage.setItem("mstar_post.project", pid);
    api.project(pid).then(setProject).catch((e) => { setError(e.message); setPid(null); setHome(true); });
  }, [pid]);

  const onSubmitted = (j: Job) => {
    setJob(j.id);
    go("Jobs");
  };

  const del = async (p: ProjectSummary) => {
    if (!await ui.confirm({ title: "Delete project?", ok: "Delete project", danger: true,
      body: <p>Delete <b>{p.name}</b> and all its run outputs? Case folders are not touched.</p> })) return;
    try {
      await api.deleteProject(p.id);
      if (p.id === lastOpened) localStorage.removeItem("mstar_post.project");
      if (p.id === pid) setPid(null);
      reloadList();
    } catch (e) { setError((e as Error).message); }
  };

  const showDash = home && !creating;
  const showTab = !home && !creating;
  return (
    <ThemeContext.Provider value={theme}>
    <div className="app">
      <header>
        <b className="brand" onClick={() => setHome(true)} title="all projects" role="button">M-Star Post</b>
        <div className="project-bar">
          <button className={showDash ? "tab active" : "tab"} onClick={() => { setCreating(false); setHome(true); }}>Projects</button>
          <select value={pid ?? ""} onChange={(e) => e.target.value && open(e.target.value)} title="switch project">
            <option value="">{project ? "Switch project..." : "Open a project..."}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.n_included}/{p.n_cases})</option>)}
          </select>
          {me.user && <button onClick={() => setCreating(true)} title="create a project from a study or case folder">New</button>}
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={showTab && t === tab ? "tab active" : "tab"} disabled={!project && !GLOBAL_TABS.includes(t)}
                    title={!project && !GLOBAL_TABS.includes(t) ? "open a project first" : t === "Files" && !me.user ? "log in to browse files" : undefined}
                    onClick={() => go(t)}>{t}{t === "Jobs" && activeJobs > 0 && <span className="badge pulse" title={`${activeJobs} running or queued`}>{activeJobs}</span>}</button>
          ))}
        </nav>
        {me.user ? (
          <span className="user-badge" title={me.method === "ssh" ? "logged in through your SSH tunnel" : "logged in with your password"}>
            <span className="dot" />{me.user}{me.admin && <span className="small muted"> admin</span>}
            {me.method === "password" && <button className="tab small" onClick={doLogout}>Log out</button>}
          </span>
        ) : (
          <button className="tab user-btn unset" onClick={() => setLoginOpen({})} disabled={me.loading}
                  title="guests can view; log in with your server account to run and edit">{me.loading ? "..." : "Guest \u00b7 Log in"}</button>
        )}
        <button className="tab theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                title="switch between dark and light mode">{theme === "dark" ? "Light" : "Dark"}</button>
      </header>
      {ui.dialog}
      {loginOpen && <LoginDialog passwordLogin={me.password_login} reason={loginOpen.reason} onClose={() => setLoginOpen(false)} />}
      {error && <div className="error banner" onClick={() => setError(null)}>{error} <span className="dismiss">(click to dismiss)</span></div>}
      {creating && <NewProject projects={projects} onClose={() => setCreating(false)} onCreated={(p) => {
        reloadList();
        open(p.id);
      }} />}
      <main>
        {showDash && (
          <Dashboard projects={projects} current={pid} lastOpened={lastOpened} onOpen={open} onNew={() => setCreating(true)}
                     onDelete={del} onFiles={() => go("Files")} onTheory={() => go("Theory")} onGpus={() => go("GPUs")} />
        )}
        {project && showTab && !GLOBAL_TABS.includes(tab) && (
          <Relocate key={project.id} project={project} onChange={(p) => {
            setProject(p);
            reset("Viewer");
            reset("Plots");
          }} />
        )}
        {visited.has("Theory") && <Pane show={showTab && tab === "Theory"}><TheoryView /></Pane>}
        {visited.has("GPUs") && <Pane show={showTab && tab === "GPUs"}><GpuView active={showTab && tab === "GPUs"} /></Pane>}
        {visited.has("Files") && <Pane show={showTab && tab === "Files"}>
          {me.user ? <FilesView key={me.user} /> : (
            <div className="panel">
              <h2>Files</h2>
              <p className="muted">File browsing runs with your own server permissions, so it needs a login.</p>
              <button className="primary" onClick={() => setLoginOpen({})}>Log in</button>
            </div>)}
        </Pane>}
        {project && (() => {
          const pane = (t: Tab, el: JSX.Element) => visited.has(t) && (
            <Pane key={`${t}|${project.id}|${resets[t] ?? 0}`} show={showTab && tab === t}>{el}</Pane>);
          return <>
            {pane("Cases", <CasesView project={project} onChange={setProject} />)}
            {pane("Run", <RunView project={project} onSubmitted={onSubmitted} />)}
            {pane("Jobs", <JobsView project={project.id} selected={job} onSelect={setJob} owner={project.owner} onOpenResults={() => {
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

function NewProject({ onClose, onCreated, projects }: { onClose: () => void; onCreated: (p: Project) => void; projects: ProjectSummary[] }) {
  const [root, setRoot] = useState("");
  const [name, setName] = useState("");
  const me = useUser();
  const [meta, setMeta] = useState<ProjectMeta>({ owner: "", program: "", purpose: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      // the owner is always the logged-in account (the server ignores anything else)
      onCreated(await api.createProject(name || root.split("/").filter(Boolean).slice(-2).join("_"), root,
                                        { program: meta.program, purpose: meta.purpose }));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="panel">
      <div className="row"><h2 className="grow">New project</h2><button onClick={onClose}>Close</button></div>
      <p className="muted">Pick a study folder (all cases below it are discovered) or a single case folder.</p>
      <DirBrowser onSelect={setRoot} initial="/data2/mstar" />
      <div className="row">
        <label>Folder <input className="wide mono" value={root} onChange={(e) => setRoot(e.target.value)} /></label>
        <label>Name <input value={name} placeholder="default: folder name" onChange={(e) => setName(e.target.value)} /></label>
      </div>
      <div className="row small">
        <span title="the project owner is your account and cannot be changed later"><span className="muted">Owner</span> <b>{me.user ?? "\u2014"}</b></span>
        {META_FIELDS.filter(({ key }) => key !== "owner").map(({ key, label, hint }) => (
          <label key={key} title={hint}>{label}{" "}
            <input value={meta[key]} placeholder={hint} list={`new-meta-${key}`}
                   onChange={(e) => setMeta({ ...meta, [key]: e.target.value })} />
            <datalist id={`new-meta-${key}`}>{metaValues(projects, key).map((s) => <option key={s} value={s} />)}</datalist>
          </label>))}
        <button className="primary" disabled={!root || busy} onClick={create}>{busy ? "Discovering cases..." : "Create"}</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
