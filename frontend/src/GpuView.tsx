import { useEffect, useState } from "react";
import { api, type GpuStatus } from "./api";
import { fmtBytes } from "./FilesView";

const mib = (v: number | null | undefined) => (v === null || v === undefined ? "" : fmtBytes(v * 1024 * 1024));
const ago = (t: number | null) => {
  if (!t) return "";
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} d`;
};
// the case folder of an M-Star solve, from "--input=/path/to/case/input.xml"
const caseOf = (cmd: string | null) => cmd?.match(/--input=(\S+)\/input\.xml/)?.[1] ?? null;

// Live status of every GPU: load, memory (free %), temperature, power and the processes on it.
export default function GpuView({ active }: { active: boolean }) {
  const [data, setData] = useState<GpuStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const load = () => api.gpus().then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => {
    if (!active) return;
    load();
    if (!auto) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [active, auto]);

  const gpus = data?.gpus ?? [];
  const busy = gpus.filter((g) => g.processes.length).length;
  const totalFree = gpus.reduce((s, g) => s + (g.memory_free_mib ?? 0), 0);
  const cls = (pct: number | null) => (pct === null ? "" : pct >= 50 ? "ok" : pct >= 20 ? "warn" : "bad");

  return (
    <div className="panel gpus">
      <div className="row">
        <h2 className="grow">GPUs {data?.host && <span className="muted">on {data.host}</span>}</h2>
        {data && <span className="small muted">{gpus.length - busy} of {gpus.length} idle &middot; {mib(totalFree)} free in total
          &middot; updated {new Date(data.time * 1000).toLocaleTimeString()}</span>}
        <label className="small"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-refresh (5 s)</label>
        <button onClick={load}>Refresh</button>
      </div>
      {error && <div className="error">{error}</div>}
      {data && !data.available && <div className="error">{data.error ?? "nvidia-smi is not available on this server"}</div>}
      {!data && !error && <div className="muted">Loading...</div>}
      {gpus.length > 0 && (
        <div className="tablewrap">
          <table className="grid gpu-table">
            <thead><tr>
              <th>GPU</th><th>name</th><th>state</th><th title="GPU compute utilization">load</th>
              <th title="free fraction of the GPU memory">memory free</th><th>used / total</th>
              <th>temp</th><th>power</th><th>running</th>
            </tr></thead>
            <tbody>
              {gpus.map((g) => {
                const n = g.processes.length;
                const idle = n === 0 && (g.utilization_pct ?? 0) < 5;
                return [
                  <tr key={g.index} className={open[g.index] ? "selected" : ""}>
                    <td className="mono"><b>{g.index}</b></td>
                    <td>{g.name.replace(/^NVIDIA /, "")}</td>
                    <td><span className={`status ${idle ? "done" : "running"}`}>{idle ? "idle" : "busy"}</span></td>
                    <td className="num">{g.utilization_pct === null ? "" : `${g.utilization_pct.toFixed(0)} %`}
                      <div className="usagebar thin"><div style={{ width: `${g.utilization_pct ?? 0}%` }} className={(g.utilization_pct ?? 0) > 90 ? "bad" : (g.utilization_pct ?? 0) > 60 ? "warn" : ""} /></div></td>
                    <td className={`num free ${cls(g.memory_free_pct)}`}><b>{g.memory_free_pct === null ? "" : `${g.memory_free_pct.toFixed(0)} %`}</b>
                      <div className="usagebar thin" title={`${mib(g.memory_used_mib)} used`}>
                        <div style={{ width: `${100 - (g.memory_free_pct ?? 0)}%` }} className={cls(g.memory_free_pct) === "bad" ? "bad" : cls(g.memory_free_pct) === "warn" ? "warn" : ""} /></div></td>
                    <td className="num small">{mib(g.memory_used_mib)} / {mib(g.memory_total_mib)}</td>
                    <td className="num">{g.temperature_c === null ? "" : `${g.temperature_c.toFixed(0)} \u00b0C`}</td>
                    <td className="num small">{g.power_w === null ? "" : `${g.power_w.toFixed(0)}${g.power_limit_w ? ` / ${g.power_limit_w.toFixed(0)}` : ""} W`}</td>
                    <td>{n ? (
                      <a onClick={() => setOpen({ ...open, [g.index]: !open[g.index] })}>
                        {n} process{n === 1 ? "" : "es"}{g.users.length ? ` (${g.users.join(", ")})` : ""} {open[g.index] ? "\u25b4" : "\u25be"}</a>
                    ) : <span className="muted">nothing</span>}</td>
                  </tr>,
                  open[g.index] && n > 0 && (
                    <tr key={`${g.index}-p`} className="gpu-procs">
                      <td /><td colSpan={8}>
                        <table className="grid narrow">
                          <thead><tr><th>pid</th><th>user</th><th>memory</th><th>running for</th><th>command</th></tr></thead>
                          <tbody>{g.processes.map((p) => {
                            const c = caseOf(p.cmdline);
                            return (
                              <tr key={p.pid}>
                                <td className="mono">{p.pid}</td><td>{p.user ?? <span className="muted">?</span>}</td>
                                <td className="num">{mib(p.memory_used_mib)}</td><td className="num">{ago(p.started)}</td>
                                <td className="mono small" title={p.cmdline ?? p.name}>
                                  {c ? <><span className="tag">M-Star</span> {c}</> : (p.cmdline ?? p.name)}</td>
                              </tr>);
                          })}</tbody>
                        </table>
                      </td>
                    </tr>),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="small muted">Memory free = share of the GPU memory not allocated by any process. M-Star solves reserve memory at start,
        so a GPU with little free memory cannot take another run even when its load is low. Process details come from
        nvidia-smi and /proc.</div>
    </div>
  );
}
