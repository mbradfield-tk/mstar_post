import { useEffect, useRef, useState } from "react";
import { api, type Job } from "./api";

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
  const offset = useRef(0);
  const pre = useRef<HTMLPreElement>(null);
  const job = jobs.find((j) => j.id === selected);

  useEffect(() => {
    api.jobs(project).then(setJobs);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/jobs/ws`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
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
    offset.current = 0;
  }, [selected]);

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
              <h2 className="grow">{job.label} <span className={`status ${job.status}`}>{job.status}</span></h2>
              {active && <button onClick={() => api.cancelJob(job.id)}>Cancel</button>}
              {job.status === "done" && <button className="primary" onClick={onOpenResults}>Open results</button>}
            </div>
            <div className="small muted">
              step {Math.min(job.step + 1, job.commands.length)} of {job.commands.length}
              {job.error && <span className="error"> | {job.error}</span>}
              {" | "}<span className="mono">{job.run_dir}</span>
            </div>
            <details>
              <summary className="small">Commands</summary>
              <pre className="log small">{job.commands.map((c) => c.argv.join(" ")).join("\n")}</pre>
            </details>
            <pre ref={pre} className="log">{log || "(no output yet)"}</pre>
          </>
        ) : <div className="muted">Select a job.</div>}
      </div>
    </div>
  );
}
