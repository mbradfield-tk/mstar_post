import { memo, useEffect, useRef, useState } from "react";
import { api, type Job } from "./api";
import { useDialog } from "./Dialog";
import { dropJob, putJob, useJobs } from "./jobsStore";
import { useUser } from "./user";
import { usePageVisible } from "./visible";

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString() : "");
const dur = (j: Job) => {
  if (!j.started_at) return "";
  const s = Math.round((j.finished_at ?? Date.now() / 1000) - j.started_at);
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const NEAR_BOTTOM = 40;  // px: the log follows new output only while it is scrolled (almost) to the end

// Live job list (shared jobs store: WebSocket updates, reconnects by itself) and a tailing log view.
export default memo(function JobsView({ project, selected, onSelect, onOpenResults, owner, active = true }: {
  project: string;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenResults: () => void;
  owner?: string | null;  // project owner: may manage every job of the project
  active?: boolean;       // the tab is on screen: the duration tick and the log tail pause otherwise
}) {
  const me = useUser();
  const { jobs, loaded, connected, error: listError } = useJobs(project);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const offset = useRef(0);
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const job = jobs.find((j) => j.id === selected);
  const ui = useDialog();
  const shown = usePageVisible() && active;
  // re-render every second while a job runs so its duration ticks
  const [, setTick] = useState(0);
  const anyActive = jobs.some((j) => j.status === "running" || j.status === "queued");
  useEffect(() => {
    if (!anyActive || !shown) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [anyActive, shown]);

  useEffect(() => {
    setLog("");
    setError(null);
    offset.current = 0;
    follow.current = true;
  }, [selected]);

  const rerun = async (j: Job) => {
    if (!await ui.confirm({ title: "Re-run job?", ok: "Re-run", danger: true,
      body: <p>The results of <b>{j.label}</b> are deleted and the job runs again with the same settings.</p> })) return;
    try {
      const nj = await api.rerunJob(j.id);
      setLog("");
      offset.current = 0;
      follow.current = true;
      putJob(nj);
    } catch (e) { setError((e as Error).message); }
  };
  const rename = async (j: Job) => {
    const label = (await ui.prompt({ title: "Rename job", input: j.label, ok: "Rename" }))?.trim();
    if (!label || label === j.label) return;
    try {
      putJob(await api.renameJob(j.id, label));
    } catch (e) { setError((e as Error).message); }
  };
  const remove = async (j: Job) => {
    if (!await ui.confirm({ title: "Delete job?", ok: "Delete", danger: true,
      body: <><p>Delete <b>{j.label}</b> and all its results? This cannot be undone.</p>
        <div className="mono small muted">{j.run_dir}</div></> })) return;
    try {
      await api.deleteJob(j.id);
      dropJob(project, j.id);
    } catch (e) { setError((e as Error).message); }
  };

  const running = job?.status === "running" || job?.status === "queued";
  // Tail of the selected job's log: one request at a time, the next one a second after the reply
  // (never overlapping, so a slow reply cannot append the same text twice). `offset` is the next byte to ask for.
  useEffect(() => {
    if (!selected || !shown) return;
    let live = true, timer = 0;
    const poll = async () => {
      try {
        const r = await api.jobLog(selected, offset.current);
        if (!live) return;
        if (r.size < offset.current) {  // the log started again (job re-run elsewhere): read it from the start
          offset.current = 0;
          setLog("");
          void poll();
          return;
        }
        if (r.text) {
          const el = pre.current;
          follow.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
          offset.current = r.offset;
          setLog((l) => (l + r.text).slice(-400000));
          // a long log arrives in pieces: fetch the rest right away, also for a finished job
          if (r.offset < r.size) { timer = window.setTimeout(poll, 0); return; }
        }
      } catch { /* job gone */ }
      if (live && running) timer = window.setTimeout(poll, 1000);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [selected, running, shown]);
  // keep the end of the log in view, but leave it alone once the user scrolled up to read
  useEffect(() => {
    const el = pre.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [log, shown]);

  return (
    <div className="split">
      {ui.dialog}
      <div className="side">
        <h3>Jobs</h3>
        {loaded && !connected && <div className="small muted" title="the live connection to the server was lost; it is retried automatically and the list is read again when it is back">
          reconnecting to the server...</div>}
        {listError && <div className="error small">{listError}</div>}
        {jobs.map((j) => (
          <div key={j.id} className={`taskcard${j.id === selected ? " active" : ""}`} onClick={() => onSelect(j.id)}>
            <span className={`status ${j.status}`}>{j.status}</span> <b>{j.label}</b>
            <div className="small muted">{when(j.created_at)} {dur(j) && `| ${dur(j)}`}{j.user && ` | ${j.user}`}</div>
          </div>
        ))}
        {!jobs.length && <div className="muted">{loaded ? "No jobs yet: start one on the Run tab." : listError ? "" : "Loading..."}</div>}
      </div>
      <div className="main panel">
        {job ? (
          <>
            <div className="row">
              <h2 className="grow plain">{job.label} <span className={`status ${job.status}`}>{job.status}</span></h2>
              {(() => {
                const mine = me.canManage(job.user, owner);
                const why = !me.user ? "log in to manage jobs" : `only ${job.user ?? "the owner"}, the project owner or an admin`;
                return <>
                  {running && <button disabled={!mine} title={mine ? undefined : why} onClick={() => api.cancelJob(job.id).catch((e) => setError(e.message))}>Cancel</button>}
                  {job.status === "done" && <button className="primary" onClick={onOpenResults}>Open results</button>}
                  {me.user && <button onClick={() => rename(job)}>Rename</button>}
                  {!running && <button disabled={!mine} title={mine ? "delete the results and run again with the same settings" : why} onClick={() => rerun(job)}>Re-run</button>}
                  {!running && <button className="danger" disabled={!mine} title={mine ? "delete the job and all its results" : why} onClick={() => remove(job)}>Delete</button>}
                </>;
              })()}
            </div>
            {error && <div className="error">{error}</div>}
            <div className="small muted">
              {job.user && <>started by <b>{job.user}</b> | </>}
              step {Math.min(job.step + 1, job.commands.length)} of {job.commands.length}
              {job.error && <span className="error"> | {job.error}</span>}
              {" | "}<span className="mono">{job.run_dir}</span>
            </div>
            <details>
              <summary className="small">Commands</summary>
              <pre className="log small">{job.commands.map((c) => c.argv.join(" ")).join("\n")}</pre>
            </details>
            <pre ref={pre} className="log">{log || (running ? "Waiting for output..." : "(no output)")}</pre>
          </>
        ) : <div className="muted">{jobs.length ? "Select a job to see its log." : "Jobs started on the Run tab appear here with their live log."}</div>}
      </div>
    </div>
  );
});
