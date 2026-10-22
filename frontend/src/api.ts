// Typed client for the mstar_post backend.

export type CaseSettings = Record<string, string | number>;
export type CaseInfo = {
  id: string; path: string; name: string; parent: string; stats_dir: string;
  n_stats_files: number; end_time_s: number | null; has_output: boolean;
  output_kinds: string[]; settings: CaseSettings; error?: string;
};
export type ProjectCase = {
  id: string; path: string; stats_dir: string; included: boolean; info?: CaseInfo | null;
};
export type Project = {
  id: string; name: string; root: string; single: boolean; created: number;
  cases: ProjectCase[]; ref_case: string | null; notes: string; aliases?: Record<string, string>;
};
export const caseName = (p: Project, id: string) => p.aliases?.[id] || id;
export type ProjectSummary = {
  id: string; name: string; root: string; single: boolean; created: number;
  n_cases: number; n_included: number;
};
export type Param = {
  name: string; label: string; type: "number" | "integer" | "bool" | "string" | "list" | "select";
  default: unknown; help: string; group: string; options?: { value: string; label: string }[];
};
export type TaskDef = {
  id: string; label: string; description: string; params: Param[];
  presets: { label: string; params: Record<string, unknown> }[]; per_case: boolean;
};
export type Job = {
  id: string; project: string; task: string; label: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  commands: { argv: string[] }[]; run_dir: string; created_at: number;
  started_at: number | null; finished_at: number | null; returncode: number | null;
  step: number; params: { params: Record<string, unknown>; cases: string[] }; error: string | null;
};
export type Run = {
  name: string; path: string; task: string | null; label: string | null; job_id: string | null;
  status: string; params: Record<string, unknown>; created_at: number | null;
  finished_at: number | null; csvs: string[]; htmls: string[]; images: string[];
};
export type ArrayInfo = { name: string; assoc: string; ncomp: number; unit: string };
export type OutputKind = {
  kind: string; type: "volume" | "slice" | "surface" | "unknown"; ext: string;
  times: number[]; files: string[][]; arrays: ArrayInfo[];
  extent: number[] | null; origin: number[] | null; spacing: number[] | null;
  slice_axis: number | null; slice_pos: number | null; file_size: number; error?: string;
};
export type Inventory = {
  case: string; kinds: OutputKind[]; geometry: { name: string; file: string }[];
};
export type StatsFile = { file: string; columns: string[] };
export type RunSeriesFile = { file: string; columns: string[]; cases: string[] };
export type Series = { t: number[]; columns: Record<string, (number | null)[]> };
export type CsvTable = { columns: string[]; rows: (string | number | null)[][]; truncated: boolean };

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const qs = (o: Record<string, string | number | boolean | string[] | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.set(k, String(v));
  }
  return p.toString();
};

export const api = {
  roots: () => req<{ path: string; exists: boolean }[]>("/api/fs/roots"),
  listDir: (path: string) => req<{
    path: string; parent: string | null; is_case: boolean;
    entries: { name: string; path: string; is_case: boolean }[];
  }>(`/api/fs/list?${qs({ path })}`),

  projects: () => req<ProjectSummary[]>("/api/projects"),
  project: (id: string) => req<Project>(`/api/projects/${id}`),
  createProject: (name: string, root: string) =>
    req<Project>("/api/projects", json("POST", { name, root })),
  patchProject: (id: string, body: Partial<{ name: string; included: Record<string, boolean>;
    ref_case: string; notes: string; aliases: Record<string, string> }>) => req<Project>(`/api/projects/${id}`, json("PATCH", body)),
  rediscover: (id: string) => req<Project>(`/api/projects/${id}/rediscover`, { method: "POST" }),
  deleteProject: (id: string) => req(`/api/projects/${id}`, { method: "DELETE" }),
  runs: (id: string) => req<Run[]>(`/api/projects/${id}/runs`),
  deleteRun: (id: string, name: string) =>
    req(`/api/projects/${id}/runs/${encodeURIComponent(name)}`, { method: "DELETE" }),
  run: (id: string, task: string, params: Record<string, unknown>, cases?: string[], label?: string) =>
    req<Job>(`/api/projects/${id}/run`, json("POST", { task, params, cases, label })),
  csv: (id: string, path: string) => req<CsvTable>(`/api/projects/${id}/csv?${qs({ path })}`),
  runTimeseries: (id: string, run: string) =>
    req<RunSeriesFile[]>(`/api/projects/${id}/runs/${encodeURIComponent(run)}/timeseries`),
  runSeries: (id: string, run: string, file: string, columns: string[]) =>
    req<Record<string, Series>>(
      `/api/projects/${id}/runs/${encodeURIComponent(run)}/series?${qs({ file, columns })}`),
  fileUrl: (id: string, path: string, download = false) =>
    `/api/projects/${id}/file?${qs({ path, download })}`,
  zipUrl: (id: string, path: string) => `/api/projects/${id}/zip?${qs({ path })}`,

  tasks: () => req<TaskDef[]>("/api/tasks"),
  jobs: (project?: string) => req<Job[]>(`/api/jobs?${qs({ project })}`),
  cancelJob: (jid: string) => req<Job>(`/api/jobs/${jid}/cancel`, { method: "POST" }),
  rerunJob: (jid: string) => req<Job>(`/api/jobs/${jid}/rerun`, { method: "POST" }),
  renameJob: (jid: string, label: string) => req<Job>(`/api/jobs/${jid}`, json("PATCH", { label })),
  deleteJob: (jid: string) => req<{ deleted: string }>(`/api/jobs/${jid}`, { method: "DELETE" }),
  jobLog: (jid: string, offset: number) =>
    req<{ offset: number; size: number; text: string }>(`/api/jobs/${jid}/log?${qs({ offset })}`),

  inventory: (path: string) => req<Inventory>(`/api/case/inventory?${qs({ path })}`),
  stats: (path: string) => req<StatsFile[]>(`/api/case/stats?${qs({ path })}`),
  series: (path: string, file: string, columns: string[]) =>
    req<{ t: number[]; columns: Record<string, (number | null)[]> }>(
      `/api/case/series?${qs({ path, file, columns })}`),
  line: (path: string, file: string, array: string, comp: string, p0: number[], p1: number[], n = 200) =>
    req<{ distance: number[]; value: (number | null)[]; unit: string }>(
      `/api/case/line?${qs({ path, file, array, comp, p0: p0.join(","), p1: p1.join(","), n })}`),
  cmaps: () => req<string[]>("/api/case/cmaps"),
  planeUrl: (path: string, file: string, array: string, comp: string,
             axis: number | null, pos: number | null, mask = true) =>
    `/api/case/plane?${qs({ path, file, array, comp, axis, pos, mask })}`,
  planeVecUrl: (path: string, file: string, array: string, axis: number | null, pos: number | null,
                mask = true) => `/api/case/plane_vec?${qs({ path, file, array, axis, pos, mask })}`,
  streamlinesUrl: (path: string, file: string, array: string, axis: number, pos: number | null,
                   n_seeds: number, stride = 1) =>
    `/api/case/streamlines?${qs({ path, file, array, axis, pos, n_seeds, stride })}`,
  fluidCenter: (path: string, file: string) =>
    req<{ lo: number[]; hi: number[]; center: number[]; source: string }>(
      `/api/case/fluid_center?${qs({ path, file })}`),
  surfaceUrl: (path: string, file: string, max_tris = 400000) =>
    `/api/case/surface?${qs({ path, file, max_tris })}`,
  isoUrl: (path: string, file: string, array: string, comp: string, level: number, stride = 1) =>
    `/api/case/iso?${qs({ path, file, array, comp, level, stride })}`,
};

export function download(filename: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

export const fmt = (v: unknown, digits = 4): string => {
  if (typeof v !== "number") return v === null || v === undefined ? "" : String(v);
  if (!isFinite(v)) return "";
  if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5)) return v.toExponential(digits - 1);
  return Number(v.toPrecision(digits)).toString();
};

export const AXES = ["x", "y", "z"] as const;
