import { useEffect, useState } from "react";
import { api, caseName, type CsvTable, type Project, type Run, type TaskDef } from "./api";
import CaseNames from "./CaseNames";
import { SimTimeTable, simTimeSummary } from "./CasesView";
import CsvTableView from "./CsvTableView";
import { useDialog } from "./Dialog";
import { useUser } from "./user";
import RunSummary from "./RunSummary";
import StatsSeries from "./StatsSeries";
import TaskComparison from "./TaskComparison";
import AllResults from "./AllResults";

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString() : "");
// stats_plots/<stem>.html name of a Stats file, as written by mstar_stats_summary.make_plots
const plotStem = (statsFile: string) => statsFile.replace(/\.[^./]+$/, "").replace(/[^\w.-]+/g, "_");
// results are normalised to the body name "Agitator" (M-Star: "Moving Body" = "agitator")
const canonBody = (s: string) => s.replace(/Moving[ _]Body|(?<![A-Za-z])agitator(?![A-Za-z])/g, "Agitator");

// Prefer the cross-case means table when a run is opened.
const PREFERRED = ["batch_summary_means.csv", "stats_summary_means.csv"];
type Section = "overview" | "all" | "files" | "series";
const SECTIONS: [Section, string, string][] = [
  ["overview", "Overview", "what was run, which cases were compared and the key results"],
  ["all", "All results", "pick any steady-state mean: M-Star Stats variables, summary means and derived values per case"],
  ["files", "Files", "every table (and legacy HTML plot or image) of the run"],
  ["series", "Case time series", "any variable of one case over time"],
];
type CmpSection = "key" | "all" | "series";
const CMP_SECTIONS: [CmpSection, string, string][] = [
  ["key", "Key results", "the headline metrics of every case, merged over all runs of this job type"],
  ["all", "All results", "pick any steady-state mean across all cases: M-Star Stats variables, summary means and derived values"],
  ["series", "Case time series", "any variable over time, several cases on one figure"],
];

export default function ResultsView({ project, runName, onRunChange, onProjectChange, active, onReset }: {
  project: Project;
  runName: string | null;
  onRunChange: (name: string | null) => void;
  onProjectChange: (p: Project) => void;
  active: boolean;
  onReset: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [tasks, setTasks] = useState<TaskDef[]>([]);
  const [section, setSection] = useState<Section>("overview");
  const [file, setFile] = useState<string | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seriesSel, setSeriesSel] = useState<{ caseId: string; file: string; src: string } | null>(null);
  // sidebar: runs listed by date, or grouped by job type with a project-wide comparison per type
  const [groupBy, setGroupBy] = useState<"date" | "task">(() => (localStorage.getItem(`mstar_post.results.group.${project.id}`) as "task" | null) ?? "task");
  useEffect(() => localStorage.setItem(`mstar_post.results.group.${project.id}`, groupBy), [groupBy, project.id]);
  const [compareTask, setCompareTask] = useState<string | null>(null);
  const [cmpSection, setCmpSection] = useState<CmpSection>("key");
  const run = compareTask ? null : runs.find((r) => r.name === runName) ?? null;
  const ui = useDialog();
  const me = useUser();
  const runIds = run?.params?.cases;
  const runCases = Array.isArray(runIds) ? project.cases.filter((c) => runIds.includes(c.id)) : [];
  const openFile = (f: string) => { setFile(f); setSection("files"); };
  const openRun = (name: string) => { setCompareTask(null); onRunChange(name); };
  const taskLabel = (id: string | null) => tasks.find((t) => t.id === id)?.label ?? id ?? "unknown job type";
  const byTask = runs.reduce((m, r) => m.set(r.task ?? "", [...(m.get(r.task ?? "") ?? []), r]), new Map<string, Run[]>());

  useEffect(() => { api.tasks().then(setTasks).catch(() => undefined); }, []);

  const reload = () => api.runs(project.id).then((rs) => {
    setRuns(rs);
    if (!runName && rs.length) onRunChange(rs[0].name);
  }).catch((e) => setError(e.message));
  useEffect(() => { if (active) reload(); }, [project.id, active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!run) { setFile(null); return; }
    const pick = PREFERRED.find((p) => run.csvs.includes(p)) ?? run.csvs[0] ?? run.htmls[0] ?? null;
    setFile(pick);
  }, [run?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // the bottom block follows the top block: all variables of the same file and case
  // (Stats file: stats_plots/<stem>.html; job CSV: the job's <stem>.html next to it, if that job is selected)
  const seriesCandidates = !run || !seriesSel ? [] : seriesSel.src === "stats"
    ? [`${seriesSel.caseId}/stats_plots/${plotStem(seriesSel.file)}.html`, `stats_plots/${plotStem(seriesSel.file)}.html`,
       `${seriesSel.caseId}/stats_plots/${canonBody(plotStem(seriesSel.file))}.html`, `stats_plots/${canonBody(plotStem(seriesSel.file))}.html`]
    : seriesSel.src === `run:${run.name}`
      ? [`${seriesSel.caseId}/${plotStem(seriesSel.file)}.html`, `${plotStem(seriesSel.file)}.html`] : [];
  const seriesHtml = seriesCandidates.find((h) => run?.htmls.includes(h)) ?? null;

  useEffect(() => {
    setTable(null);
    setError(null);
    if (!run || !file?.endsWith(".csv")) return;
    api.csv(project.id, `${run.path}/${file}`).then(setTable).catch((e) => setError(e.message));
  }, [run?.path, file]); // eslint-disable-line react-hooks/exhaustive-deps

  const del = async () => {
    if (!run || !await ui.confirm({ title: "Delete run?", ok: "Delete", danger: true,
      body: <p>Delete run <b>{run.label ?? run.name}</b> and all its outputs? This cannot be undone.</p> })) return;
    await api.deleteRun(project.id, run.name);
    onRunChange(null);
    reload();
  };
  const [renaming, setRenaming] = useState(false);
  const [renameNote, setRenameNote] = useState<string | null>(null);
  // M-Star "Moving Body" / "agitator" -> "Agitator" in the result files of one run or all runs
  const renameBody = async (all: boolean) => {
    if (!await ui.confirm({ title: all ? "Rename the impeller body in all runs?" : "Rename the impeller body in this run?", ok: "Rename",
      body: <p>Every <b>Moving Body</b> / <b>agitator</b> in the result files {all ? "of every finished run" : "of this run"} becomes
        <b> Agitator</b>: CSV headers and values (columns that become identical are merged), HTML plots and file names.
        Case folders are not touched. Runs made from now on are normalised automatically.</p> })) return;
    setRenaming(true);
    setRenameNote(null);
    try {
      const r = await api.renameBody(project.id, all ? undefined : run?.name);
      const bad = r.runs.filter((x) => x.error || x.skipped);
      setRenameNote(`${r.changed} file${r.changed === 1 ? "" : "s"} updated in ${r.runs.length} run${r.runs.length === 1 ? "" : "s"}`
        + (bad.length ? `; ${bad.map((x) => `${x.run}: ${x.skipped ?? "failed"}`).join(", ")}` : ""));
      setFile(null);
      reload();
    } catch (e) { setError((e as Error).message); }
    setRenaming(false);
  };

  const group = (files: string[]) => {
    const g = new Map<string, string[]>();
    files.forEach((f) => {
      const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "(run)";
      g.set(d, [...(g.get(d) ?? []), f]);
    });
    return g;
  };

  return (
    <div className="split">
      {ui.dialog}
      <div className="side">
        <div className="row"><h3 className="grow">Runs</h3><button onClick={reload}>Refresh</button>
          <button onClick={() => { setCompareTask(null); onReset(); }} title="newest run, default file, no table filters">Reset</button></div>
        {runs.length > 1 && <div className="row small">
          <span className="muted">group</span>
          <span className="seg">
            <button className={groupBy === "task" ? "primary" : ""} onClick={() => setGroupBy("task")} title="runs grouped by job type, with a comparison of all cases per type">by job type</button>
            <button className={groupBy === "date" ? "primary" : ""} onClick={() => setGroupBy("date")}>by date</button>
          </span></div>}
        {runs.length > 0 && me.user && <div className="row small">
          <button disabled={renaming} onClick={() => renameBody(true)}
                  title="rename M-Star's 'Moving Body' / 'agitator' to 'Agitator' in the result files of every run">
            {renaming ? "Renaming..." : "Moving Body \u2192 Agitator (all runs)"}</button></div>}
        {renameNote && <div className="note small" onClick={() => setRenameNote(null)}>{renameNote}</div>}
        {(groupBy === "task" ? [...byTask.entries()] : [["", runs] as [string, Run[]]]).map(([tid, rs]) => (
          <div key={tid || "all"} className="run-group">
            {groupBy === "task" && (
              <div className={`taskcard compare${compareTask === tid ? " active" : ""}`} onClick={() => setCompareTask(tid)}
                   title="all cases of the project compared on the outputs of this job type (newest run per case)">
                <b>{taskLabel(tid)}</b> <span className="muted small">&middot; {rs.length} run{rs.length === 1 ? "" : "s"}</span>
                <div className="small">Compare all cases &rarr;</div>
              </div>)}
            {rs.map((r) => (
              <div key={r.name} className={`taskcard${groupBy === "task" ? " nested" : ""}${run?.name === r.name ? " active" : ""}`} onClick={() => openRun(r.name)}>
                <span className={`status ${r.status}`}>{r.status}</span> <b>{r.label ?? r.task}</b>
                <div className="small muted">{when(r.created_at)}{r.user && <> &middot; {r.user}</>}
                  {Array.isArray(r.params?.cases) && <> &middot; {(r.params.cases as string[]).length} case{(r.params.cases as string[]).length === 1 ? "" : "s"}</>}</div>
              </div>
            ))}
          </div>
        ))}
        {!runs.length && <div className="muted">No runs yet: start a calculation on the Run tab.</div>}
        {run && (
          <>
            <h3>Files</h3>
            {[...group([...run.csvs, ...run.htmls, ...run.images])].map(([d, fs]) => (
              <details key={d} open={d === "(run)"}>
                <summary className="small mono">{d === "(run)" ? "run folder" : caseName(project, d)}</summary>
                <ul className="filelist">
                  {fs.map((f) => (
                    <li key={f} className={f === file && section === "files" ? "active" : ""} onClick={() => openFile(f)}>
                      {f.slice(f.lastIndexOf("/") + 1)}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </>
        )}
      </div>
      <div className="main panel">
        {compareTask !== null ? (
          <>
            <div className="row">
              <h2 className="grow plain">{taskLabel(compareTask)} <span className="muted">across the project</span></h2>
            </div>
            <div className="row section-bar">
              <span className="seg">
                {CMP_SECTIONS.map(([k, label, help]) => (
                  <button key={k} className={cmpSection === k ? "primary" : ""} title={help} onClick={() => setCmpSection(k)}>{label}</button>))}
              </span>
              <span className="small muted">{CMP_SECTIONS.find(([k]) => k === cmpSection)?.[2]}</span>
            </div>
            {cmpSection === "key" && (
              <TaskComparison key={compareTask} project={project} task={tasks.find((t) => t.id === compareTask)}
                              runs={byTask.get(compareTask) ?? []} onOpenRun={openRun} />)}
            {cmpSection === "all" && (
              <div className="card">
                <AllResults key={compareTask} project={project} runs={byTask.get(compareTask) ?? []} storeKey={`task.${compareTask}`} />
              </div>)}
            {cmpSection === "series" && (
              <div className="card">
                <StatsSeries key={compareTask} project={project} multi storeKey={`task.${compareTask}`}
                             runs={(byTask.get(compareTask) ?? []).filter((r) => r.status === "done" || r.status === "unknown")} />
              </div>)}
          </>
        ) : run ? (
          <>
            <div className="row">
              <h2 className="grow plain">{run.label ?? run.name} <span className={`status ${run.status}`}>{run.status}</span></h2>
              <a className="button" href={api.zipUrl(project.id, run.path)}>Download run (.zip)</a>
              {me.user && <button disabled={renaming} onClick={() => renameBody(false)}
                      title="rename M-Star's 'Moving Body' / 'agitator' to 'Agitator' in this run's result files">Moving Body {"\u2192"} Agitator</button>}
              {me.user && <button className="danger" disabled={!me.canManage(run.user, project.owner, project.created_by)} onClick={del}
                      title={me.canManage(run.user, project.owner, project.created_by) ? "delete this run and all its outputs" : `only ${run.user ?? "the owner"}, the project owner or an admin can delete this run`}>Delete run</button>}
            </div>
            <div className="row small muted">
              <span>{tasks.find((t) => t.id === run.task)?.label ?? run.task}</span>
              <span>&middot;</span><span>{when(run.created_at)}</span>
              <span>&middot;</span><span className="mono">{run.name}</span>
            </div>
            <div className="row section-bar">
              <span className="seg">
                {SECTIONS.map(([k, label, help]) => (
                  <button key={k} className={section === k ? "primary" : ""} title={help} onClick={() => setSection(k)}>{label}</button>))}
              </span>
              <span className="small muted">{SECTIONS.find(([k]) => k === section)?.[2]}</span>
            </div>

            {section === "overview" && (
              <>
                <RunSummary project={project} run={run} task={tasks.find((t) => t.id === run.task)} onOpenFile={openFile} />
                {runCases.length > 0 && (
                  <details className="card">
                    <summary><b>Simulation time</b> <span className="small muted">{simTimeSummary(runCases)}</span></summary>
                    <SimTimeTable project={project} cases={runCases} />
                  </details>
                )}
                <details className="card">
                  <summary><b>All run parameters</b></summary>
                  <pre className="log small">{JSON.stringify(run.params, null, 2)}</pre>
                </details>
              </>
            )}

            {section === "all" && (
              <div className="card">
                <AllResults key={run.name} project={project} runs={[run]} storeKey={`run.${run.task ?? "x"}`} />
              </div>
            )}

            {section === "series" && (
              <div className="card">
                <StatsSeries project={project} onSelect={(caseId, f, src) => setSeriesSel({ caseId, file: f, src })} />
                {seriesSel && seriesHtml && (
                  <div className="small muted">
                    Legacy HTML plot of all variables of {seriesSel.file} for this case in this run: <a onClick={() => openFile(seriesHtml)}>{seriesHtml}</a>
                  </div>
                )}
              </div>
            )}

            {section === "files" && (
              <>
                <div className="row">
                  <h3 className="grow plain">{file ?? "Pick a file on the left"}</h3>
                  {file && <a className="button" href={api.fileUrl(project.id, `${run.path}/${file}`, true)}>Download file</a>}
                </div>
                {error && <div className="error">{error}</div>}
                {file?.endsWith(".csv") && !table && !error && <div className="muted">Loading table...</div>}
                {table?.columns[0] === "case" && <CaseNames project={project} onChange={onProjectChange} />}
                {table && file && <CsvTableView table={table} name={file} refCase={project.ref_case}
                                                caseLabel={(id) => caseName(project, id)} />}
                {file?.endsWith(".html") && (
                  <iframe className="htmlframe" src={api.fileUrl(project.id, `${run.path}/${file}`)} />
                )}
                {file?.endsWith(".png") && <img className="result-img" src={api.fileUrl(project.id, `${run.path}/${file}`)} />}
                {!file && <div className="muted">This run has no CSV/HTML/PNG outputs (yet). Check the job log.</div>}
              </>
            )}
          </>
        ) : <div className="muted">{runs.length ? "Select a run on the left, or a job type to compare all cases on its outputs." : "Results of finished jobs appear here: an overview of each run, its key results, every table and the case time series."}</div>}
      </div>
    </div>
  );
}
