// Typed client for the mstar_post backend.

export type CaseSettings = Record<string, string | number>;
export type CaseInfo = {
  id: string; path: string; name: string; parent: string; stats_dir: string;
  n_stats_files: number; end_time_s: number | null; has_output: boolean;
  output_kinds: string[]; settings: CaseSettings; error?: string;
};
export type ProjectCase = {
  id: string; path: string; stats_dir: string; included: boolean; info?: CaseInfo | null; missing?: boolean;
  uid?: string; id_written?: boolean;
};
export type CatalogCase = {
  uid: string; path: string; stats_dir: string; name: string; id_written: boolean; missing: boolean;
  projects: { id: string; name: string; case_id: string; included: boolean; owner: string; program: string; purpose: string }[];
  info?: CaseInfo | null;
};
export type ProjectMeta = { owner: string; program: string; purpose: string };
export type Project = {
  id: string; name: string; root: string; single: boolean; created: number; root_missing?: boolean;
  cases: ProjectCase[]; ref_case: string | null; notes: string; aliases?: Record<string, string>; created_by?: string;
} & Partial<ProjectMeta>;
export const caseName = (p: Project, id: string) => p.aliases?.[id] || id;
export type ProjectSummary = {
  id: string; name: string; root: string; single: boolean; created: number;
  n_cases: number; n_included: number;
} & Partial<ProjectMeta>;
export type Param = {
  name: string; label: string; type: "number" | "integer" | "bool" | "string" | "list" | "select";
  default: unknown; help: string; group: string; options?: { value: string; label: string }[];
};
export type TaskDef = {
  id: string; label: string; description: string; params: Param[];
  presets: { label: string; params: Record<string, unknown> }[]; per_case: boolean; group?: "base" | "addon";
};
export type Job = {
  id: string; project: string; task: string; label: string; user?: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  commands: { argv: string[] }[]; run_dir: string; created_at: number;
  started_at: number | null; finished_at: number | null; returncode: number | null;
  step: number; params: { params: Record<string, unknown>; cases: string[] }; error: string | null;
};
export type Run = {
  name: string; path: string; task: string | null; label: string | null; job_id: string | null; user?: string | null;
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
export type SolveState = {
  state: "running" | "stalled" | "complete" | "stopped" | "failed" | "no log";
  log?: string; log_mtime?: number; log_age_s?: number; n_logs: number; pid?: number | null; alive?: boolean;
  version?: string; gpu?: string; started?: number; time_s?: number; completion_pct?: number; runtime_s?: number;
  wall_h?: number; eta_h?: number; iterations?: number; mups?: number; last_lines?: string[]; note?: string; error?: string;
};
export type RunSeriesFile = { file: string; columns: string[]; cases: string[] };
export type Series = { t: number[]; columns: Record<string, (number | null)[]> };
export type CsvTable = { columns: string[]; rows: (string | number | null)[][]; truncated: boolean };
export type BrowseEntry = { name: string; path: string; dir: boolean; link: boolean; size: number | null;
  mtime: number; is_case: boolean };
export type Browse = { path: string; parent: string | null; is_case: boolean; entries: BrowseEntry[];
  truncated: boolean; writable: boolean; disk: { total: number; used: number; free: number } };
export type WhoAmI = { user: string | null; method: "ssh" | "password" | "none"; admin: boolean;
  password_login: boolean; server_account: string };
export type GpuProcess = { pid: number; memory_used_mib: number | null; name: string; user: string | null;
  cmdline: string | null; cwd: string | null; started: number | null };
export type Gpu = { index: number; uuid: string; name: string; memory_total_mib: number | null; memory_used_mib: number | null;
  memory_free_mib: number | null; memory_free_pct: number | null; utilization_pct: number | null; temperature_c: number | null;
  power_w: number | null; power_limit_w: number | null; clock_mhz: number | null; processes: GpuProcess[]; users: string[] };
export type GpuStatus = { available: boolean; error?: string; gpus: Gpu[]; time: number; host?: string };
export type FileChunk = { path: string; size: number; mtime: number; offset: number; end: number;
  binary: boolean; text: string; image: boolean };
export type DirUsage = { path: string; bytes: number; apparent: number; files: number; dirs: number;
  truncated: boolean; seconds: number; cached: boolean };

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, credentials: "same-origin" });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch { /* not JSON */ }
    if (r.status === 401 && !url.startsWith("/api/login")) window.dispatchEvent(new Event("mstar_post:login-needed"));
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
  whoami: () => req<WhoAmI>("/api/whoami"),
  login: (user: string, password: string) => req<{ user: string }>("/api/login", json("POST", { user, password })),
  logout: () => req<{ user: null }>("/api/logout", { method: "POST" }),
  gpus: () => req<GpuStatus>("/api/gpus"),
  roots: () => req<{ path: string; exists: boolean }[]>("/api/fs/roots"),
  listDir: (path: string) => req<{
    path: string; parent: string | null; is_case: boolean;
    entries: { name: string; path: string; is_case: boolean }[];
  }>(`/api/fs/list?${qs({ path })}`),
  browse: (path: string, show_hidden = false) => req<Browse>(`/api/fs/browse?${qs({ path, show_hidden })}`),
  du: (path: string, refresh = false) => req<DirUsage>(`/api/fs/du?${qs({ path, refresh })}`),
  mkdirs: (parent: string, names: string[]) => req<{ parent: string; created: string[];
    skipped: { name: string; reason: string }[] }>("/api/fs/mkdirs", json("POST", { parent, names })),
  newFile: (parent: string, name: string, content: string) =>
    req<{ path: string }>("/api/fs/file", json("POST", { parent, name, content })),
  deletePath: (path: string, recursive = false) =>
    req<{ deleted: string }>("/api/fs/delete", json("POST", { path, recursive })),
  renamePath: (path: string, name: string) =>
    req<{ path: string }>("/api/fs/rename", json("POST", { path, name })),
  movePaths: (paths: string[], dest: string) =>
    req<{ dest: string; moved: string[]; skipped: { path: string; reason: string }[] }>("/api/fs/move", json("POST", { paths, dest })),
  // one file as an attachment, several as a zip (name = zip file name without extension);
  // a hidden form post so the browser saves the stream and long selections do not hit the URL limit
  download: (paths: string[], name?: string) => {
    // the response goes to a hidden iframe so an error reply never replaces the app page
    let fr = document.getElementById("dl-sink") as HTMLIFrameElement | null;
    if (!fr) {
      fr = document.createElement("iframe");
      fr.id = "dl-sink"; fr.name = "dl-sink"; fr.style.display = "none";
      document.body.appendChild(fr);
    }
    const f = document.createElement("form");
    f.method = "post";
    f.action = "/api/fs/download";
    f.target = "dl-sink";
    f.style.display = "none";
    const add = (k: string, v: string) => {
      const i = document.createElement("input");
      i.type = "hidden"; i.name = k; i.value = v;
      f.appendChild(i);
    };
    for (const p of paths) add("path", p);
    if (name) add("name", name);
    document.body.appendChild(f);
    f.submit();
    f.remove();
  },
  uploadFiles: (parent: string, files: File[], overwrite = false) => {
    const fd = new FormData();
    fd.append("parent", parent);
    fd.append("overwrite", String(overwrite));
    for (const f of files) fd.append("files", f, f.name);
    return req<{ parent: string; saved: { name: string; bytes: number }[]; skipped: { name: string; reason: string }[] }>(
      "/api/fs/upload", { method: "POST", body: fd });
  },
  readFile: (path: string, offset = 0, tail = false, limit = 256 << 10) =>
    req<FileChunk>(`/api/fs/read?${qs({ path, offset, tail, limit })}`),
  imageUrl: (path: string) => `/api/fs/image?${qs({ path })}`,
  meshUrl: (path: string) => `/api/fs/mesh?${qs({ path })}`,

  projects: () => req<ProjectSummary[]>("/api/projects"),
  allCases: () => req<CatalogCase[]>("/api/cases"),
  project: (id: string, refresh = false) => req<Project>(`/api/projects/${id}${refresh ? "?refresh=true" : ""}`),
  solves: (id: string) => req<Record<string, SolveState>>(`/api/projects/${id}/solves`),
  createProject: (name: string, root: string, meta?: Partial<ProjectMeta>) =>
    req<Project>("/api/projects", json("POST", { name, root, ...meta })),
  patchProject: (id: string, body: Partial<{ name: string; included: Record<string, boolean>;
    ref_case: string; notes: string; aliases: Record<string, string> } & ProjectMeta>) => req<Project>(`/api/projects/${id}`, json("PATCH", body)),
  rediscover: (id: string) => req<Project>(`/api/projects/${id}/rediscover`, { method: "POST" }),
  relocate: (id: string, body: { root?: string; cases?: Record<string, string> }) =>
    req<Project>(`/api/projects/${id}/relocate`, json("POST", body)),
  deleteProject: (id: string) => req(`/api/projects/${id}`, { method: "DELETE" }),
  runs: (id: string) => req<Run[]>(`/api/projects/${id}/runs`),
  renameBody: (id: string, run?: string) =>
    req<{ runs: { run: string; changed?: number | null; skipped?: string; error?: string }[]; changed: number; log: string }>(
      `/api/projects/${id}/rename-body?${qs({ run })}`, { method: "POST" }),
  deleteRun: (id: string, name: string) =>
    req(`/api/projects/${id}/runs/${encodeURIComponent(name)}`, { method: "DELETE" }),
  run: (id: string, task: string, params: Record<string, unknown>, cases?: string[], label?: string) =>
    req<Job>(`/api/projects/${id}/run`, json("POST", { task, params, cases, label })),
  csv: (id: string, path: string) => req<CsvTable>(`/api/projects/${id}/csv?${qs({ path })}`),
  runTimeseries: (id: string, run: string) =>
    req<RunSeriesFile[]>(`/api/projects/${id}/runs/${encodeURIComponent(run)}/timeseries`),
  runSeries: (id: string, run: string, file: string, columns: string[], cases?: string[]) =>
    req<Record<string, Series>>(
      `/api/projects/${id}/runs/${encodeURIComponent(run)}/series?${qs({ file, columns, cases })}`),
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
             axis: number | null, pos: number | null, mask = true, smooth = false) =>
    `/api/case/plane?${qs({ path, file, array, comp, axis, pos, mask, smooth })}`,
  planeVecUrl: (path: string, file: string, array: string, axis: number | null, pos: number | null,
                mask = true) => `/api/case/plane_vec?${qs({ path, file, array, axis, pos, mask })}`,
  streamlinesUrl: (path: string, file: string, array: string, axis: number, pos: number | null,
                   n_seeds: number, stride = 1) =>
    `/api/case/streamlines?${qs({ path, file, array, axis, pos, n_seeds, stride })}`,
  fluidCenter: (path: string, file: string) =>
    req<{ lo: number[]; hi: number[]; center: number[]; source: string }>(
      `/api/case/fluid_center?${qs({ path, file })}`),
  volumeMean: (path: string, file: string, array: string, comp: string, mask = true) =>
    req<{ mean: number | null; n_cells: number; unit: string; time: number | null; masked: boolean }>(
      `/api/case/mean?${qs({ path, file, array, comp, mask })}`),
  surfaceUrl: (path: string, file: string, max_tris = 400000, fmt: "stl" | "mesh" = "stl") =>
    `/api/case/surface?${qs({ path, file, max_tris, fmt })}`,
  surfaceWarm: (path: string, files: string[], max_tris = 400000) =>
    req<{ queued: number }>(`/api/case/surface_warm?${qs({ path, file: files, max_tris, fmt: "mesh" })}`),
  isoUrl: (path: string, file: string, array: string, comp: string, level: number, stride = 1, max_tris = 600000) =>
    `/api/case/iso?${qs({ path, file, array, comp, level, stride, max_tris, fmt: "mesh" })}`,
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
