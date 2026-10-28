import { useEffect, useMemo, useState } from "react";
import { api, caseName, download, fmt, toCsv, type Project, type ProjectCase, type SolveState } from "./api";
import ProjectMetaEditor from "./ProjectMeta";
import { useUser } from "./user";

// Key settings shown as columns (matched by prefix); columns that are blank for every case are dropped.
const KEY_SETTINGS = ["Volume [L]", "Agitator speed [rpm]", "Simulated time (input runtime)", "Wall time",
  "Fluid 1 name", "Fluid 1 density", "Fluid 1 dynamic viscosity", "Fluid 2 name", "Fluid 2 density", "Fluid 2 dynamic viscosity",
  "dx [m]", "Impeller diameter", "Surface tension", "Max Courant"];
// significant digits per column (prefix match); default 4
const DIGITS: [string, number][] = [["Wall time", 3], ["Impeller diameter", 3], ["Max Courant", 2], ["Fluid 1 density", 4], ["Fluid 2 density", 4],
  ["Fluid 1 dynamic viscosity", 3], ["Fluid 2 dynamic viscosity", 3]];
const digitsOf = (k: string) => DIGITS.find(([p]) => k.startsWith(p))?.[1] ?? 4;
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
  const blank = (v: unknown) => v === undefined || v === null || v === "";
  return out.filter((k) => cases.some((c) => !blank(c.info?.settings?.[k])));
}

// One-line summary of the output kinds ("Volume, 2 slices, 3 surfaces"); the full list expands on click.
function Outputs({ kinds }: { kinds: string[] }) {
  if (!kinds.length) return <span className="muted">none</span>;
  const n = (re: RegExp) => kinds.filter((k) => re.test(k)).length;
  const parts: string[] = [];
  if (kinds.includes("Volume")) parts.push("Volume");
  const slices = n(/^Slice/i), surfaces = n(/Surface/i), bodies = n(/MovingBody/i);
  if (slices) parts.push(`${slices} slice${slices > 1 ? "s" : ""}`);
  if (surfaces) parts.push(`${surfaces} surface${surfaces > 1 ? "s" : ""}`);
  if (bodies) parts.push(`${bodies} bod${bodies > 1 ? "ies" : "y"}`);
  const other = kinds.length - (kinds.includes("Volume") ? 1 : 0) - slices - surfaces - bodies;
  if (other > 0) parts.push(`${other} other`);
  return (
    <details className="outputs" onClick={(e) => e.stopPropagation()}>
      <summary title={kinds.join("\n")}>{parts.join(", ")} <span className="muted">({kinds.length})</span></summary>
      <div className="tags">{kinds.map((k) => <span key={k} className="tag">{k}</span>)}</div>
    </details>
  );
}

const ago = (s: number | undefined) => s === undefined ? "" : s < 90 ? `${Math.round(s)} s ago`
  : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${(s / 3600).toFixed(1)} h ago` : `${(s / 86400).toFixed(1)} d ago`;
const hours = (h: number | undefined) => h === undefined || !Number.isFinite(h) ? "" : h < 1 ? `${Math.round(60 * h)} min` : `${h.toFixed(1)} h`;
const SOLVE_CLASS: Record<SolveState["state"], string> = { running: "running", stalled: "queued", complete: "done", stopped: "", failed: "failed", "no log": "" };
const SOLVE_HELP: Record<SolveState["state"], string> = {
  running: "the solver process of the newest log is alive",
  stalled: "the solver process is alive but the log has not been written for 30 min",
  complete: "the newest log ends with 'Simulation Complete'",
  stopped: "stopped by the user (checkpoint written)",
  failed: "the log ends without a completion marker and the solver process is gone (crashed or killed)",
  "no log": "no mstar-run-*.txt in the case folder",
};

// M-Star solver state of a case from its newest run log, with the last progress block on hover.
export function SolveTag({ s }: { s: SolveState | undefined }) {
  if (!s) return <span className="muted small">...</span>;
  const pct = s.completion_pct !== undefined ? `${fmt(s.completion_pct, 3)} %` : "";
  const title = [SOLVE_HELP[s.state], s.log && `log: ${s.log}${s.n_logs > 1 ? ` (${s.n_logs} runs)` : ""}`,
    s.log_age_s !== undefined && `last written ${ago(s.log_age_s)}`,
    s.time_s !== undefined && `t = ${fmt(s.time_s)} s of ${fmt(s.runtime_s)} s${pct ? ` (${pct})` : ""}`,
    s.wall_h !== undefined && `wall time ${hours(s.wall_h)}${s.state === "running" && s.eta_h !== undefined && s.eta_h > 0 ? `, about ${hours(s.eta_h)} remaining` : ""}`,
    s.iterations !== undefined && `${fmt(s.iterations)} iterations${s.mups ? `, ${fmt(s.mups, 4)} MUPS` : ""}`,
    s.gpu && `GPU: ${s.gpu}`, s.version && `M-Star ${s.version}`, s.pid && `PID ${s.pid}`,
    s.note, s.error, s.last_lines?.length && `last lines:\n${s.last_lines.join("\n")}`].filter(Boolean).join("\n");
  return (
    <span className={`status ${SOLVE_CLASS[s.state]}`} title={title}>
      {s.state}{pct && s.state !== "complete" ? ` ${pct}` : ""}
      {s.state === "running" && s.eta_h !== undefined && s.eta_h > 0 && <span className="muted">{hours(s.eta_h)} left</span>}
    </span>
  );
}

// Solver states of the project's cases, refreshed every 30 s while shown.
export function useSolves(pid: string, active: boolean) {
  const [solves, setSolves] = useState<Record<string, SolveState> | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = () => api.solves(pid).then((s) => live && setSolves(s)).catch(() => undefined);
    load();
    const id = setInterval(load, 30000);
    return () => { live = false; clearInterval(id); };
  }, [pid, active]);
  return solves;
}

export default function CasesView({ project, onChange, active = true }: {
  project: Project;
  onChange: (p: Project) => void;
  active?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const solves = useSolves(project.id, active);
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
    ["case", "case_id", "included", "solver", "completion_pct", "end_time_s", ...cols],
    project.cases.map((c) => [c.id, c.uid ?? "", c.included, solves?.[c.id]?.state ?? "", solves?.[c.id]?.completion_pct ?? "",
      c.info?.end_time_s ?? "", ...cols.map((k) => c.info?.settings?.[k] ?? "")])));

  const nIncl = project.cases.filter((c) => c.included).length;
  const nRunning = solves ? Object.values(solves).filter((s) => s.state === "running" || s.state === "stalled").length : 0;
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
        {nRunning > 0 && <span className="muted"> &middot; {nRunning} solve{nRunning === 1 ? "" : "s"} running: outputs written so far are already viewable (Viewer &gt; Refresh for new time steps).</span>}
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
            <th>case</th><th title="unique case ID across all projects (stored in mstar_post_case.json in the case folder)">ID</th>
            <th title="M-Star solver state from the newest mstar-run-*.txt log in the case folder (hover a tag for details); refreshed every 30 s">solver</th>
            <th>simulated [s]</th><th>outputs</th>
            {cols.map((k) => <th key={k}>{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...groups].map(([g, cs]) => [
            g && (
              <tr key={`g-${g}`} className="group">
                <td><input type="checkbox" checked={cs.every((c) => c.included)} disabled={ro}
                           onChange={(e) => setIncluded(cs.map((c) => c.id), e.target.checked)} /></td>
                <td colSpan={6 + cols.length}><b>{g}</b> <span className="muted">({cs.length})</span></td>
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
                <td className="nowrap"><SolveTag s={solves?.[c.id]} /></td>
                <td className="num">{fmt(simTime(c).end)}</td>
                <td className="small nowrap"><Outputs kinds={c.info?.output_kinds ?? []} /></td>
                {cols.map((k) => <td key={k} className={typeof c.info?.settings?.[k] === "number" ? "num" : ""}>{fmt(c.info?.settings?.[k], digitsOf(k))}</td>)}
              </tr>
            )),
          ])}
          {!shown.length && <tr><td colSpan={7 + cols.length} className="muted">
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
