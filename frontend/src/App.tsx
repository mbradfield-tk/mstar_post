import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api, clearApiCaches, type Job, type Project, type ProjectMeta, type ProjectSummary } from "./api";
import { THEME_KEY, ThemeContext, type Theme } from "./theme";
import { loginPrompt, logout, USER_CHANGED, useUser } from "./user";
import LoginDialog from "./Login";
import CasesView from "./CasesView";
import Dashboard from "./Dashboard";
import DirBrowser from "./DirBrowser";
import { useDialog } from "./Dialog";
import ErrorBoundary from "./ErrorBoundary";
import FilesView from "./FilesView";
import GpuView from "./GpuView";
import Relocate from "./Relocate";
import JobsView from "./JobsView";
import { activeJobCount, useJobs } from "./jobsStore";
import { META_FIELDS, metaValues } from "./ProjectMeta";
import RunView from "./RunView";
import { useEvent } from "./visible";

const TABS = ["Cases", "Run", "Jobs", "Results", "Plots", "Viewer", "Files", "GPUs", "Theory"] as const;
const GLOBAL_TABS: readonly string[] = ["Files", "GPUs", "Theory"];  // usable without a project
type Tab = (typeof TABS)[number];

// The tabs that need Plotly, Three.js or KaTeX are separate chunks, fetched when first opened
// (or a little earlier, see preload), so the dashboard, Cases, Files, Jobs and GPUs start without them.
let viewerLoaded = false;
const LOADERS = {
  Results: () => import("./ResultsView"),
  Plots: () => import("./PlotsView"),
  Viewer: () => import("./ViewerView").then((m) => { viewerLoaded = true; return m; }),
  Theory: () => import("./TheoryView"),
};
const ResultsView = memo(lazy(LOADERS.Results));
const PlotsView = memo(lazy(LOADERS.Plots));
const ViewerView = memo(lazy(LOADERS.Viewer));
const TheoryView = memo(lazy(LOADERS.Theory));
const RunPane = memo(RunView);
const preload = (t: string) => { (LOADERS as Record<string, (() => Promise<unknown>) | undefined>)[t]?.().catch(() => undefined); };

// A change of account remounts the whole app below the theme provider: every tab,
// WebSocket, timer and cache starts fresh and nothing of the previous user remains.
export default function App() {
  const [session, setSession] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  useEffect(() => {
    const on = () => {
      clearApiCaches();
      // planes, LIC textures and meshes live in the Viewer chunk: nothing to clear before it was loaded
      if (viewerLoaded) import("./viewerCaches").then((m) => m.clearViewerModuleCaches()).catch(() => undefined);
      setSession((s) => s + 1);
    };
    window.addEventListener(USER_CHANGED, on);
    return () => window.removeEventListener(USER_CHANGED, on);
  }, []);
  return (
    <ThemeContext.Provider value={theme}>
      <Session key={session} theme={theme} setTheme={setTheme} />
    </ThemeContext.Provider>
  );
}

function Session({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
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
  // queued/running jobs of the open project, live from the shared jobs store (also used by the Jobs tab)
  const activeJobs = activeJobCount(useJobs(pid));
  const me = useUser();
  // a session that starts because a login expired asks for the login again
  const [loginOpen, setLoginOpen] = useState<false | { reason?: string }>(() => {
    const reason = loginPrompt();
    return reason ? { reason } : false;
  });
  useEffect(() => {
    const on = () => setLoginOpen({ reason: "That needs a login (your session may have expired)." });
    window.addEventListener("mstar_post:login-needed", on);
    return () => window.removeEventListener("mstar_post:login-needed", on);
  }, []);
  const doLogout = async () => {
    try { await logout(); } catch (e) { setError((e as Error).message); }
  };
  // tabs stay mounted once opened so their state survives switching
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(["Cases"]));
  const [resets, setResets] = useState<Partial<Record<Tab, number>>>({});
  // window scroll position per view: each tab, the dashboard ("home") and the New project form
  const where = creating ? "new" : home ? "home" : tab;
  const scrolls = useRef<Record<string, number>>({});
  const leave = () => { scrolls.current[where] = window.scrollY; };

  // the handlers below keep their identity (useEvent), so the memoised tabs do not re-render with the header
  const go = useEvent((t: Tab) => {
    leave();
    setVisited((v) => (v.has(t) ? v : new Set(v).add(t)));
    setTab(t);
    setHome(false);
    setCreating(false);
  });
  const goHome = () => { leave(); setCreating(false); setHome(true); };
  const startNew = useEvent(() => { leave(); setCreating(true); });
  const open = useEvent((id: string) => {
    leave();
    if (id !== pid) { setPid(id); setTab("Cases"); }
    setHome(false);
    setCreating(false);
  });
  const reset = useCallback((t: Tab) => setResets((r) => ({ ...r, [t]: (r[t] ?? 0) + 1 })), []);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      window.scrollTo(0, scrolls.current[where] ?? 0);
      window.dispatchEvent(new Event("resize"));  // Plotly sizes plots drawn while hidden
    });
    return () => cancelAnimationFrame(id);
  }, [where]);

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
    // project tabs start again; Files, GPUs and Theory do not belong to a project and stay as they are
    setVisited((v) => new Set<Tab>(["Cases", ...[...v].filter((t) => GLOBAL_TABS.includes(t))]));
    scrolls.current = Object.fromEntries(Object.entries(scrolls.current).filter(([k]) => k === "home" || GLOBAL_TABS.includes(k)));
    if (!pid) return;
    let live = true;  // a slower reply of a project that is no longer the open one is dropped
    localStorage.setItem("mstar_post.project", pid);
    api.project(pid).then((p) => { if (live) setProject(p); })
      .catch((e) => { if (live) { setError(e.message); setPid(null); setHome(true); } });
    return () => { live = false; };
  }, [pid]);
  // updates from the tabs (case selection, names, relocate, Viewer refresh): only a newer version of the
  // open project may replace it, so a reply that arrives after a project switch cannot bring the old one back
  const changeProject = useCallback((p: Project) => setProject((cur) => (cur && cur.id === p.id ? p : cur)), []);
  // Results and Plots load Plotly: fetch those chunks once a project is open and the browser is idle
  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) return;
    const id = window.setTimeout(() => { preload("Results"); preload("Plots"); }, 2500);
    return () => clearTimeout(id);
  }, [projectId]);

  const onSubmitted = useEvent((j: Job) => {
    setJob(j.id);
    go("Jobs");
  });
  const openResults = useEvent(() => { setRun(null); go("Results"); });
  const resetResults = useEvent(() => { setRun(null); reset("Results"); });
  const resetPlots = useEvent(() => {
    if (!pid) return;
    localStorage.removeItem(`mstar_post.plots.${pid}`);
    localStorage.removeItem(`mstar_post.means.${pid}`);
    localStorage.removeItem(`mstar_post.plotref.${pid}`);
    localStorage.removeItem(`mstar_post.plots.hidden.${pid}`);
    reset("Plots");
  });
  const refreshProject = useEvent((): Promise<unknown> => (pid ? api.project(pid, true).then(changeProject) : Promise.resolve()));
  const openFiles = useEvent(() => go("Files"));
  const openTheory = useEvent(() => go("Theory"));
  const openGpus = useEvent(() => go("GPUs"));

  const del = useEvent(async (p: ProjectSummary) => {
    if (!await ui.confirm({ title: "Delete project?", ok: "Delete project", danger: true,
      body: <p>Delete <b>{p.name}</b> and all its run outputs? Case folders are not touched.</p> })) return;
    try {
      await api.deleteProject(p.id);
      if (p.id === lastOpened) localStorage.removeItem("mstar_post.project");
      if (p.id === pid) setPid(null);
      reloadList();
    } catch (e) { setError((e as Error).message); }
  });

  const showDash = home && !creating;
  const showTab = !home && !creating;
  return (
    <div className="app">
      <header>
        <b className="brand" onClick={goHome} title="all projects" role="button">M-Star Post</b>
        <div className="project-bar">
          <button className={showDash ? "tab active" : "tab"} onClick={goHome}>Projects</button>
          <select value={pid ?? ""} onChange={(e) => e.target.value && open(e.target.value)} title="switch project">
            <option value="">{project ? "Switch project..." : "Open a project..."}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.n_included}/{p.n_cases})</option>)}
          </select>
          {me.user && <button onClick={startNew} title="create a project from a study or case folder">New</button>}
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={showTab && t === tab ? "tab active" : "tab"} disabled={!project && !GLOBAL_TABS.includes(t)}
                    title={!project && !GLOBAL_TABS.includes(t) ? "open a project first" : t === "Files" && !me.user ? "log in to browse files" : undefined}
                    onMouseEnter={() => { if (project || GLOBAL_TABS.includes(t)) preload(t); }}
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
      {creating && <NewProject projects={projects} onClose={() => { leave(); setCreating(false); }} onCreated={(p) => {
        reloadList();
        open(p.id);
      }} />}
      <main>
        {showDash && (
          <Dashboard projects={projects} current={pid} lastOpened={lastOpened} onOpen={open} onNew={startNew}
                     onDelete={del} onFiles={openFiles} onTheory={openTheory} onGpus={openGpus} />
        )}
        {project && showTab && !GLOBAL_TABS.includes(tab) && (
          <Relocate key={project.id} project={project} onChange={(p) => {
            changeProject(p);
            reset("Viewer");
            reset("Plots");
          }} />
        )}
        {visited.has("Theory") && <Pane label="Theory" show={showTab && tab === "Theory"}><TheoryView /></Pane>}
        {visited.has("GPUs") && <Pane label="GPUs" show={showTab && tab === "GPUs"}><GpuView active={showTab && tab === "GPUs"} /></Pane>}
        {visited.has("Files") && <Pane label="Files" show={showTab && tab === "Files"}>
          {me.user ? <FilesView key={me.user} /> : (
            <div className="panel">
              <h2>Files</h2>
              <p className="muted">File browsing runs with your own server permissions, so it needs a login.</p>
              <button className="primary" onClick={() => setLoginOpen({})}>Log in</button>
            </div>)}
        </Pane>}
        {project && (() => {
          // `active` = the tab is really on screen (not behind the dashboard or the New project form):
          // polling stops otherwise, and coming back refreshes the tab's lists
          const on = (t: Tab) => showTab && tab === t;
          const pane = (t: Tab, el: JSX.Element) => visited.has(t) && (
            <Pane key={`${t}|${project.id}|${resets[t] ?? 0}`} label={t} show={on(t)}>{el}</Pane>);
          return <>
            {pane("Cases", <CasesView project={project} onChange={changeProject} active={on("Cases")} />)}
            {pane("Run", <RunPane project={project} onSubmitted={onSubmitted} />)}
            {pane("Jobs", <JobsView project={project.id} selected={job} onSelect={setJob} owner={project.owner}
              onOpenResults={openResults} active={on("Jobs")} />)}
            {pane("Results", <ResultsView project={project} runName={run} onRunChange={setRun}
              onProjectChange={changeProject} active={on("Results")} onReset={resetResults} />)}
            {pane("Plots", <PlotsView project={project} onProjectChange={changeProject} active={on("Plots")} onReset={resetPlots} />)}
            {pane("Viewer", <ViewerView project={project} active={on("Viewer")} onRefresh={refreshProject} />)}
          </>;
        })()}
      </main>
    </div>
  );
}

// a render error in one tab is caught here: the header and the other tabs stay usable;
// Suspense shows a line while the chunk of a lazily loaded tab is on its way
function Pane({ show, label, children }: { show: boolean; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: show ? "contents" : "none" }}>
      <ErrorBoundary label={`The ${label} tab`}>
        <Suspense fallback={<div className="panel muted">Loading {label}...</div>}>{children}</Suspense>
      </ErrorBoundary>
    </div>
  );
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
