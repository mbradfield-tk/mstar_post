import { useCallback, useSyncExternalStore } from "react";
import { api, invalidateRuns, type Job } from "./api";

// One live job list per open project, shared by the header badge and the Jobs tab: a single
// WebSocket that reconnects with backoff and reads the list again whenever it (re)opens, so
// nothing is missed while the connection was down (server restart, tunnel drop, sleep).
export type JobsState = { jobs: Job[]; loaded: boolean; connected: boolean; error: string | null };
const EMPTY: JobsState = { jobs: [], loaded: false, connected: false, error: null };
const BACKOFF = [1000, 2000, 4000, 8000, 15000];  // ms between reconnect attempts
const PING_MS = 30000;
const isActive = (j: Job) => j.status === "queued" || j.status === "running";

type Store = {
  state: JobsState; refs: number; linger: number;
  listeners: Set<() => void>;
  start: () => void; stop: () => void; load: () => void;
  put: (j: Job) => void; drop: (id: string) => void;
};
const stores = new Map<string, Store>();

function createStore(pid: string): Store {
  let ws: WebSocket | null = null;
  let closed = true, retry = 0, timer = 0, ping = 0, first = 0, pings = 0;
  let clock = 0, seq = 0;                    // clock counts job events, seq list requests
  const touched = new Map<string, number>();  // job id -> clock of its last event
  const gone = new Map<string, number>();     // job id -> clock of its deletion
  const set = (s: Partial<JobsState>) => {
    store.state = { ...store.state, ...s };
    store.listeners.forEach((l) => l());
  };

  const put = (j: Job) => {
    touched.set(j.id, ++clock);
    gone.delete(j.id);
    const js = store.state.jobs;
    set({ jobs: js.some((x) => x.id === j.id) ? js.map((x) => (x.id === j.id ? j : x)) : [j, ...js] });
  };
  const drop = (id: string) => {
    gone.set(id, ++clock);
    if (store.state.jobs.some((j) => j.id === id)) set({ jobs: store.state.jobs.filter((j) => j.id !== id) });
  };

  const load = () => {
    const my = ++seq, since = clock;
    api.jobs(pid).then((list) => {
      if (my !== seq || closed) return;
      // events that arrived while the list was on its way are newer than the list
      const now = new Map(store.state.jobs.map((j) => [j.id, j]));
      const newer = (id: string) => (touched.get(id) ?? 0) > since;
      const out = list.filter((j) => !((gone.get(j.id) ?? 0) > since)).map((j) => (newer(j.id) ? now.get(j.id) ?? j : j));
      const ids = new Set(out.map((j) => j.id));
      set({ jobs: [...store.state.jobs.filter((j) => !ids.has(j.id) && newer(j.id)), ...out], loaded: true, error: null });
    }).catch((e) => { if (my === seq && !closed) set({ error: (e as Error).message }); });
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = window.setTimeout(connect, BACKOFF[Math.min(retry++, BACKOFF.length - 1)]);
  };
  const connect = () => {
    if (closed || ws) return;
    clearTimeout(timer);
    let sock: WebSocket;
    try {
      sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/jobs/ws`);
    } catch { schedule(); return; }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      retry = 0;
      set({ connected: true });
      load();
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      let m: { type?: string; id?: string; project?: string; job?: Job };
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "job_deleted" && m.id && (m.project === undefined || m.project === pid)) {
        drop(m.id);
        invalidateRuns(pid);
      } else if (m.type === "job" && m.job?.project === pid) {
        put(m.job);
        invalidateRuns(pid);
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (store.state.connected) set({ connected: false });
      schedule();
    };
    sock.onerror = () => sock.close();
  };
  // back in the foreground or online again: do not wait for the next backoff step
  const wake = () => {
    if (closed || document.hidden) return;
    if (ws && ws.readyState === WebSocket.OPEN) load();
    else if (!ws) { retry = 0; connect(); }
  };

  const store: Store = {
    state: EMPTY, refs: 0, linger: 0, listeners: new Set(), load, put, drop,
    start: () => {
      if (!closed) return;
      closed = false;
      connect();
      // the list normally arrives when the socket opens; without a socket (blocked, server down) ask anyway
      first = window.setTimeout(() => { if (!store.state.loaded && !store.state.connected) load(); }, 500);
      ping = window.setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send("ping");
        // safety net for a connection that died without a close event: re-read the list of active jobs once a minute
        if (++pings % 2 === 0 && !document.hidden && store.state.jobs.some(isActive)) load();
      }, PING_MS);
      document.addEventListener("visibilitychange", wake);
      window.addEventListener("online", wake);
    },
    stop: () => {
      closed = true;
      clearTimeout(timer); clearTimeout(first); clearInterval(ping);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      const s = ws;
      ws = null;
      s?.close();
    },
  };
  return store;
}

function subscribe(pid: string, cb: () => void): () => void {
  let s = stores.get(pid);
  if (!s) { s = createStore(pid); stores.set(pid, s); }
  const store = s;
  clearTimeout(store.linger);
  store.listeners.add(cb);
  if (store.refs++ === 0) store.start();
  return () => {
    store.listeners.delete(cb);
    if (--store.refs > 0) return;
    // a short grace period: the badge and the Jobs tab swap subscriptions when a project is (re)opened
    store.linger = window.setTimeout(() => {
      if (store.refs > 0) return;
      store.stop();
      if (stores.get(pid) === store) stores.delete(pid);
    }, 300);
  };
}

// live jobs of a project (null = none); every caller of the same project shares one socket and one list
export function useJobs(pid: string | null): JobsState {
  const sub = useCallback((cb: () => void) => (pid ? subscribe(pid, cb) : () => undefined), [pid]);
  return useSyncExternalStore(sub, () => (pid ? stores.get(pid)?.state ?? EMPTY : EMPTY));
}

// results of the app's own actions (re-run, rename, delete) are shown at once, not only when the socket reports them
export const putJob = (j: Job) => { stores.get(j.project)?.put(j); invalidateRuns(j.project); };
export const dropJob = (pid: string, id: string) => { stores.get(pid)?.drop(id); invalidateRuns(pid); };
export const reloadJobs = (pid: string) => stores.get(pid)?.load();
export const activeJobCount = (s: JobsState) => s.jobs.filter(isActive).length;
