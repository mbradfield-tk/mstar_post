import { useEffect, useRef, useState } from "react";
import { api, type Job } from "./api";
import { useDialog } from "./Dialog";

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString() : "");
const dur = (j: Job) => {
  if (!j.started_at) return "";
  const s = Math.round((j.finished_at ?? Date.now() / 1000) - j.started_at);
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

// Live job list (WebSocket updates) and a tailing log view.
export default function JobsView({ project, selected, onSelect, onOpenResults }: {
  project: string;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenResults: () => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const offset = useRef(0);
  const pre = useRef<HTMLPreElement>(null);
  const job = jobs.find((j) => j.id === selected);
  const ui = useDialog();
  // re-render every second while a job runs so its duration ticks
  const [, setTick] = useState(0);
  const anyActive = jobs.some((j) => j.status === "running" || j.status === "queued");
  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [anyActive]);

  useEffect(() => {
    api.jobs(project).then(setJobs);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/jobs/ws`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "job_deleted") { setJobs((js) => js.filter((j) => j.id !== m.id)); return; }
      if (m.type !== "job" || m.job.project !== project) return;
      setJobs((js) => {
        const i = js.findIndex((j) => j.id === m.job.id);
        return i < 0 ? [m.job, ...js] : js.map((j) => (j.id === m.job.id ? m.job : j));
      });
    };
    const ping = setInterval(() => ws.readyState === 1 && ws.send("ping"), 30000);
    return () => { clearInterval(ping); ws.close(); };
  }, [project]);

  useEffect(() => {
    setLog("");
    setError(null);
    offset.current = 0;
  }, [selected]);

  const rerun = async (j: Job) => {
    if (!await ui.confirm({ title: "Re-run job?", ok: "Re-run", danger: true,
      body: <p>The results of <b>{j.label}</b> are deleted and the job runs again with the same settings.</p> })) return;
    try {
      const nj = await api.rerunJob(j.id);
      setLog("");
      offset.current = 0;
      setJobs((js) => [nj, ...js.filter((x) => x.id !== j.id)]);
    } catch (e) { setError((e as Error).message); }
  };
  const rename = async (j: Job) => {
    const label = (await ui.prompt({ title: "Rename job", input: j.label, ok: "Rename" }))?.trim();
    if (!label || label === j.label) return;
    try {
      const nj = await api.renameJob(j.id, label);
      setJobs((js) => js.map((x) => (x.id === j.id ? nj : x)));
    } catch (e) { setError((e as Error).message); }
  };
  const remove = async (j: Job) => {
    if (!await ui.confirm({ title: "Delete job?", ok: "Delete", danger: true,
      body: <><p>Delete <b>{j.label}</b> and all its results? This cannot be undone.</p>
        <div className="mono small muted">{j.run_dir}</div></> })) return;
    try {
      await api.deleteJob(j.id);
      setJobs((js) => js.filter((x) => x.id !== j.id));
    } catch (e) { setError((e as Error).message); }
  };

  const active = job?.status === "running" || job?.status === "queued";
  useEffect(() => {
    if (!selected) return;
    let live = true;
    const poll = async () => {
      try {
        const r = await api.jobLog(selected, offset.current);
        if (!live) return;
        if (r.text) {
          offset.current = r.offset;
          setLog((l) => (l + r.text).slice(-400000));
          requestAnimationFrame(() => pre.current && (pre.current.scrollTop = pre.current.scrollHeight));
        }
      } catch { /* job gone */ }
    };
    poll();
    const id = active ? setInterval(poll, 1000) : undefined;
    return () => { live = false; if (id) clearInterval(id); };
  }, [selected, active]);

  return (
    <div className="split">
      {ui.dialog}
      <div className="side">
        <h3>Jobs</h3>
        {jobs.map((j) => (
          <div key={j.id} className={`taskcard${j.id === selected ? " active" : ""}`} onClick={() => onSelect(j.id)}>
            <span className={`status ${j.status}`}>{j.status}</span> <b>{j.label}</b>
            <div className="small muted">{when(j.created_at)} {dur(j) && `| ${dur(j)}`}</div>
          </div>
        ))}
        {!jobs.length && <div className="muted">No jobs yet: start one on the Run tab.</div>}
      </div>
      <div className="main panel">
        {job ? (
          <>
            <div className="row">
              <h2 className="grow plain">{job.label} <span className={`status ${job.status}`}>{job.status}</span></h2>
              {active && <button onClick={() => api.cancelJob(job.id).catch((e) => setError(e.message))}>Cancel</button>}
              {job.status === "done" && <button className="primary" onClick={onOpenResults}>Open results</button>}
              <button onClick={() => rename(job)}>Rename</button>
              {!active && <button onClick={() => rerun(job)} title="delete the results and run again with the same settings">Re-run</button>}
              {!active && <button className="danger" onClick={() => remove(job)} title="delete the job and all its results">Delete</button>}
            </div>
            {error && <div className="error">{error}</div>}
            <div className="small muted">
              step {Math.min(job.step + 1, job.commands.length)} of {job.commands.length}
              {job.error && <span className="error"> | {job.error}</span>}
              {" | "}<span className="mono">{job.run_dir}</span>
            </div>
            <details>
              <summary className="small">Commands</summary>
              <pre className="log small">{job.commands.map((c) => c.argv.join(" ")).join("\n")}</pre>
            </details>
            <pre ref={pre} className="log">{log || (active ? "Waiting for output..." : "(no output)")}</pre>
          </>
        ) : <div className="muted">{jobs.length ? "Select a job to see its log." : "Jobs started on the Run tab appear here with their live log."}</div>}
      </div>
    </div>
  );
}
