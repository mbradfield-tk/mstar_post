import { api, type CsvTable, type Project, type Run } from "./api";
import { cmapLut } from "./cmap";

// Data layer of Plots > Zones: the per-case outputs of finished cfd_zoner runs
// (zones.csv, heterogeneity.csv, zone_weights.csv, class_boundaries.csv, zone slices,
// exposure_cdf.csv, histogram.csv, profiles.csv) merged over runs, newest run per
// case and variable. Replaces the script's former zoner_comparison figures.

export type ZoneClass = { id: number; label: string; mean: number; std: number; min: number; max: number;
                          cells: number; volume: number; volFrac: number; contribution: number | null; upper: number | null };
export type ZoneCase = {
  caseId: string; run: Run; dir: string;        // dir = "<case id>" or "<case id>/<variable slug>"
  variable: string; unit: string;                // VTK array name and its unit (e.g. "W/kg")
  alias: string;                                 // requested variable (edr, velocity, ...) from zoner_summary.csv
  classes: ZoneClass[]; globalMean: number; het: Record<string, number>;
  tSel: number | null; tSteady: number | null;
};
export type ZoneSliceMeta = { view: string; title: string; uLabel: string; vLabel: string; u0: number; du: number; nu: number;
                              v0: number; dv: number; nv: number; coord: number };
export type ZoneSlice = ZoneSliceMeta & { u: number[]; v: number[]; cls: Int16Array }; // cls[v * nu + u], 0 = outside

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const col = (t: CsvTable, name: string) => t.columns.indexOf(name);

export const zonerRuns = (runs: Run[]) =>
  runs.filter((r) => r.task === "cfd_zoner" && (r.status === "done" || r.status === "unknown"))
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

// (case id, dir) of every zoner output folder of a run; case ids contain "/", so match by prefix
export function zonerDirsOf(project: Project, run: Run): { caseId: string; dir: string }[] {
  const out: { caseId: string; dir: string }[] = [];
  for (const f of run.csvs) {
    if (!f.endsWith("/zones.csv")) continue;
    const dir = f.slice(0, -"/zones.csv".length);
    const c = project.cases.find((x) => dir === x.id || dir.startsWith(`${x.id}/`))
      ?? (project.single ? project.cases[0] : undefined);
    if (c) out.push({ caseId: c.id, dir });
  }
  return out;
}

const unitOfVar = (v: string) => v.match(/\(([^)]+)\)\s*$/)?.[1] ?? "";

async function loadZoneCase(project: Project, run: Run, caseId: string, dir: string): Promise<ZoneCase | null> {
  const get = (f: string) => api.csv(project.id, `${run.path}/${dir}/${f}`).catch(() => null);
  const [zones, het, weights, bounds, summary] = await Promise.all([
    get("zones.csv"), get("heterogeneity.csv"), get("zone_weights.csv"), get("class_boundaries.csv"), get("zoner_summary.csv")]);
  if (!zones || !zones.rows.length) return null;
  const meanCol = zones.columns.findIndex((c) => c.startsWith("mean "));
  const variable = meanCol >= 0 ? zones.columns[meanCol].slice(5) : "";
  const w = new Map<number, number>(), up = new Map<number, number>();
  if (weights) {
    const cc = weights.columns.findIndex((c) => c.startsWith("contribution_to_mean"));
    for (const r of weights.rows) { const c = num(r[col(weights, "class")]); const v = num(r[cc]); if (c !== null && v !== null) w.set(c, v); }
  }
  if (bounds) {
    const ub = bounds.columns.findIndex((c) => c.startsWith("upper_boundary"));
    for (const r of bounds.rows) { const c = num(r[col(bounds, "class")]); const v = num(r[ub]); if (c !== null && v !== null) up.set(c, v); }
  }
  const classes: ZoneClass[] = [];
  for (const r of zones.rows) {
    if (r[col(zones, "level")] !== "class") continue;
    const id = num(r[col(zones, "id")]) ?? 0;
    classes.push({ id, label: String(r[col(zones, "zone")] ?? `class ${id}`), mean: num(r[meanCol]) ?? NaN,
      std: num(r[col(zones, "std")]) ?? NaN, min: num(r[col(zones, "min")]) ?? NaN, max: num(r[col(zones, "max")]) ?? NaN,
      cells: num(r[col(zones, "cells")]) ?? 0, volume: num(r[col(zones, "volume_m3")]) ?? NaN,
      volFrac: num(r[col(zones, "volume_fraction")]) ?? NaN, contribution: w.get(id) ?? null, upper: up.get(id) ?? null });
  }
  classes.sort((a, b) => a.id - b.id);
  const h: Record<string, number> = {};
  if (het) for (const r of het.rows) { const v = r[1]; h[String(r[0])] = typeof v === "number" ? v : v === "True" ? 1 : v === "False" ? 0 : NaN; }
  const vf = classes.reduce((s, c) => s + c.volFrac, 0);
  const globalMean = h.mstar_global_mean ?? h.global_mean ?? (vf ? classes.reduce((s, c) => s + c.volFrac * c.mean, 0) / vf : NaN);
  let alias = "", tSel: number | null = null, tSteady: number | null = null;
  if (summary?.rows.length) {
    const r = summary.rows[0];
    summary.columns.forEach((c, i) => {
      const m = c.match(/^(analysis time|steady start) \((.*)\) \[s\]$/);
      if (m) { alias = m[2]; if (m[1] === "analysis time") tSel = num(r[i]); else tSteady = num(r[i]); }
    });
  }
  return { caseId, run, dir, variable, unit: unitOfVar(variable), alias: alias || variable, classes, globalMean, het: h, tSel, tSteady };
}

// Every (case, variable) of the project's finished zoner runs; the newest run wins per pair.
export async function loadZonerCases(project: Project, runs: Run[]): Promise<ZoneCase[]> {
  const seen = new Set<string>();
  const jobs: Promise<ZoneCase | null>[] = [];
  for (const run of zonerRuns(runs)) {
    for (const { caseId, dir } of zonerDirsOf(project, run)) {
      const sub = dir.slice(caseId.length + 1);  // variable slug when the job had several variables
      const key = `${caseId}|${sub}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(loadZoneCase(project, run, caseId, dir));
    }
  }
  const all = (await Promise.all(jobs)).filter((z): z is ZoneCase => z !== null);
  // same variable from a flat and a nested layout: keep the newest only
  const best = new Map<string, ZoneCase>();
  for (const z of all) { const k = `${z.caseId}|${z.variable}`; if (!best.has(k)) best.set(k, z); }
  return [...best.values()];
}

const sliceCache = new Map<string, Promise<ZoneSlice[]>>();

// The stored cross-sections (side, side2, top) of one zoner output folder.
export function loadZoneSlices(project: Project, z: ZoneCase): Promise<ZoneSlice[]> {
  const key = `${project.id}|${z.run.name}|${z.dir}`;
  let p = sliceCache.get(key);
  if (!p) {
    p = (async () => {
      const meta = await api.csv(project.id, `${z.run.path}/${z.dir}/zone_slices.csv`).catch(() => null);
      if (!meta) return [];
      const metas: ZoneSliceMeta[] = meta.rows.map((r) => ({
        view: String(r[col(meta, "view")]), title: String(r[col(meta, "title")]),
        uLabel: String(r[col(meta, "u_label")]), vLabel: String(r[col(meta, "v_label")]),
        u0: num(r[col(meta, "u0 [m]")]) ?? 0, du: num(r[col(meta, "du [m]")]) ?? 1, nu: num(r[col(meta, "nu [count]")]) ?? 0,
        v0: num(r[col(meta, "v0 [m]")]) ?? 0, dv: num(r[col(meta, "dv [m]")]) ?? 1, nv: num(r[col(meta, "nv [count]")]) ?? 0,
        coord: num(r[col(meta, "plane_coordinate [m]")]) ?? 0 }));
      const tables = await Promise.all(metas.map((m) => api.csv(project.id, `${z.run.path}/${z.dir}/zone_slice_${m.view}.csv`).catch(() => null)));
      const out: ZoneSlice[] = [];
      metas.forEach((m, i) => {
        const t = tables[i];
        if (!t || !t.rows.length) return;
        const nu = t.columns.length - 1, nv = t.rows.length;
        const cls = new Int16Array(nu * nv);
        for (let j = 0; j < nv; j++) { const r = t.rows[j]; for (let k = 0; k < nu; k++) cls[j * nu + k] = Number(r[k + 1]) || 0; }
        out.push({ ...m, nu, nv, u: t.columns.slice(1).map(Number), v: t.rows.map((r) => Number(r[0])), cls });
      });
      return out;
    })();
    p.catch(() => sliceCache.delete(key));
    sliceCache.set(key, p);
  }
  return p;
}

export const clearZonerCache = () => sliceCache.clear();

// Turbo colors ranked by zone mean (red = highest, blue = lowest), darkened like the
// script's zone_colors; `means` keyed by class id (or any key).
export async function zoneColors<K>(means: Map<K, number>): Promise<Map<K, string>> {
  const lut = await cmapLut("turbo");
  const order = [...means.keys()].sort((a, b) => means.get(a)! - means.get(b)!);
  const n = order.length, dim = 0.75;
  const out = new Map<K, string>();
  order.forEach((k, i) => {
    const idx = Math.round(255 * (0.05 + 0.9 * i / Math.max(n - 1, 1))) * 4;
    const h = (c: number) => Math.round(dim * lut[idx + c]).toString(16).padStart(2, "0");
    out.set(k, `#${h(0)}${h(1)}${h(2)}`);
  });
  return out;
}

export const turboScale = async (): Promise<[number, string][]> => {
  const lut = await cmapLut("turbo");
  return Array.from({ length: 16 }, (_, i) => {
    const k = Math.round(255 * i / 15) * 4;
    return [i / 15, `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`] as [number, string];
  });
};

// Bounding box (u0, u1, v0, v1) of the labelled cells with a margin, so a subplot shows the
// vessel instead of the whole simulation domain.
export function sliceBounds(s: ZoneSlice, margin = 0.03): [number, number, number, number] {
  let i0 = s.nv, i1 = -1, j0 = s.nu, j1 = -1;
  for (let i = 0; i < s.nv; i++) for (let j = 0; j < s.nu; j++) if (s.cls[i * s.nu + j] >= 1) {
    if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
  }
  if (i1 < 0) return [s.u0 - s.du / 2, s.u0 + (s.nu - 0.5) * s.du, s.v0 - s.dv / 2, s.v0 + (s.nv - 0.5) * s.dv];
  const u0 = s.u0 + (j0 - 0.5) * s.du, u1 = s.u0 + (j1 + 0.5) * s.du;
  const v0 = s.v0 + (i0 - 0.5) * s.dv, v1 = s.v0 + (i1 + 0.5) * s.dv;
  const mu = margin * (u1 - u0), mv = margin * (v1 - v0);
  return [u0 - mu, u1 + mu, v0 - mv, v1 + mv];
}

// Per-slice axis limits and one common box aspect: vessels of the same width (5 mm bins)
// share identical limits so equal reactors render at the same displayed size.
export function groupedLimits(slices: ZoneSlice[]): { limits: [number, number, number, number][]; aspect: number } {
  const b = slices.map((s) => sliceBounds(s));
  const key = b.map((x) => Math.round((x[1] - x[0]) / 0.005));
  const g = new Map<number, [number, number, number, number]>();
  key.forEach((k, i) => {
    const x = b[i], cur = g.get(k);
    g.set(k, cur ? [Math.min(cur[0], x[0]), Math.max(cur[1], x[1]), Math.min(cur[2], x[2]), Math.max(cur[3], x[3])] : [...x]);
  });
  const aspect = Math.max(...[...g.values()].map(([u0, u1, v0, v1]) => (v1 - v0) / (u1 - u0)), 0.1);
  const limits = key.map((k) => { const [u0, u1, v0] = g.get(k)!; return [u0, u1, v0, v0 + (u1 - u0) * aspect] as [number, number, number, number]; });
  return { limits, aspect };
}

export const fmtG = (v: number, d = 3) => (Number.isFinite(v) ? Number(v.toPrecision(d)).toString() : "");
