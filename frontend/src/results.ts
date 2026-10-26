import { api, type Project, type Run } from "./api";

// Shared logic for the Results overviews: which columns of a run's outputs are the
// "key results" and how to load one row per case from a run (means tables of the
// stats summary, or the final value of per-case time series for tasks like calc_ua).

// Key metrics in priority order: [column pattern, short label]. The unit comes from the column's "[...]".
export const KEY_METRICS: [RegExp, string][] = [
  [/^Mean Energy Dissipation Rate \[/, "Mean eps"],
  [/^Power per Volume P\/V/, "P/V"],
  [/^Power Number from Torque/, "Po"],
  [/^Impeller Power P \(/, "P"],
  [/^Mean Velocity \[/, "Mean velocity"],
  [/^Blend Time t95/, "t95 blend (correlation)"],
  [/^Kolmogorov Scale at Mean Resolved Dissipation \[/, "Kolmogorov"],
  [/^Mixing Time/i, "Mixing time"],
  [/^Specific Interfacial Area \[/, "a"],
  [/^Interface Enhancement E/, "E = a/a0"],
  [/^Sauter Diameter d32 \(/, "d32"],
  [/^Dispersion Time t95/, "t95 disp"],
  [/^Number of Drops/, "Drops"],
  [/^Zonal CoV of Phase Fraction \(Fluid 1/, "Zonal CoV"],
  [/^Segregation Index S \(Fluid 1/, "S"],
  [/^Homogeneity Time t_S \(Fluid 1/, "t_S"],
  [/^Continuous Phase/, "Continuous phase"],
  [/^UA overall energy balance \[/, "UA (energy balance)"],
  [/^U overall energy balance \[/, "U (energy balance)"],
  [/^UA overall least-squares \[/, "UA (least squares)"],
  [/^UA film energy balance \[/, "UA film"],
  [/^Energy closure \[/, "Energy closure"],
  [/^UA \[/, "UA"],
  [/^U \[/, "U"],
  [/^Q_wall \[/, "Q wall"],
];
export const MAX_METRICS = 10;
// case operating conditions (keys of case_info.settings) shown in front of the results
export const COND = [{ key: "Volume [L]", label: "Volume", unit: "L" }, { key: "Agitator speed [rpm]", label: "Speed", unit: "rpm" }];

export type Cell = string | number | null;
export type Column = { col: string; source: string; group?: string };
export type Metric = Column & { label: string; unit: string };
export type RunResults = {
  columns: Column[];                       // every per-case column the run offers, in file order
  rows: Map<string, Record<string, Cell>>; // case id -> values
  std?: Map<string, Record<string, number>>; // case id -> std of the steady-state mean, where known
  valueNote: string;
};

export const unitOf = (col: string) => col.match(/\[([^\]]*)\]\s*$/)?.[1] ?? "";
export const shortName = (col: string) => col.replace(/\s*\[[^\]]*\]\s*$/, "");
export const pct = (v: Cell, r: Cell) =>
  typeof v === "number" && typeof r === "number" && r !== 0 ? ((v - r) / Math.abs(r)) * 100 : null;
export const fmtPct = (p: number) => `${p > 0 ? "+" : ""}${p.toFixed(Math.abs(p) < 10 ? 1 : 0)}%`;

export const condOf = (project: Project, c: string, key: string): number | string | null => {
  const v = project.cases.find((x) => x.id === c)?.info?.settings?.[key];
  return typeof v === "number" || typeof v === "string" ? v : null;
};

export function pickMetrics(columns: Column[], max = MAX_METRICS): Metric[] {
  const out: Metric[] = [];
  for (const [re, label] of KEY_METRICS) {
    const hit = columns.find((c) => re.test(c.col) && !out.some((m) => m.col === c.col));
    if (hit) out.push({ ...hit, label, unit: unitOf(hit.col) });
    if (out.length >= max) break;
  }
  if (!out.length) columns.slice(0, max).forEach((c) => out.push({ ...c, label: shortName(c.col), unit: unitOf(c.col) }));
  return out;
}

export const meansFilesOf = (run: Run) => run.csvs.filter((f) => !f.includes("/") && /_means\.csv$/.test(f));
// per-case scalar results of per-case tasks: <case id>/<tool>_summary.csv with a single "case" row
export const caseSummaryFilesOf = (run: Run) => run.csvs.filter((f) => f.includes("/") && /_summary\.csv$/.test(f));

// case id of a per-case output path (<case id>/<file>)
const caseOfPath = (f: string) => f.slice(0, f.lastIndexOf("/"));

// One row per case of a run: merged root *_means.csv (first file wins per column), or
// the final value of every key column of the per-case time series.
export async function loadRunResults(project: Project, run: Run, full = false): Promise<RunResults> {
  const means = meansFilesOf(run);
  const columns: Column[] = [];
  const rows = new Map<string, Record<string, Cell>>();
  if (means.length) {
    const tables = await Promise.all(means.map((f) => api.csv(project.id, `${run.path}/${f}`).then((t) => [f, t] as const)));
    for (const [f, t] of tables) {
      if (t.columns[0] !== "case") continue;
      t.columns.slice(1).forEach((c) => !columns.some((x) => x.col === c) && columns.push({ col: c, source: f, group: "Summary means" }));
      for (const r of t.rows) {
        const row = rows.get(String(r[0])) ?? {};
        t.columns.forEach((c, i) => { if (i && row[c] === undefined) row[c] = r[i]; });
        rows.set(String(r[0]), row);
      }
    }
    return { columns, rows, valueNote: "steady-state means" };
  }
  // per-case tasks: their scalar summaries first (ua_summary.csv), then the final time-series values
  const summaries = caseSummaryFilesOf(run);
  for (const f of summaries) {
    const cid = project.single && !project.cases.some((c) => f.startsWith(`${c.id}/`)) ? project.cases[0]?.id ?? caseOfPath(f) : caseOfPath(f);
    const t = await api.csv(project.id, `${run.path}/${f}`).catch(() => null);
    if (!t || !t.rows.length) continue;
    const name = f.slice(f.lastIndexOf("/") + 1);
    t.columns.forEach((c) => c !== "case" && !columns.some((x) => x.col === c) && columns.push({ col: c, source: name, group: `Script summary: ${name}` }));
    const row = rows.get(cid) ?? {};
    t.columns.forEach((c, i) => { if (c !== "case" && row[c] === undefined) row[c] = t.rows[0][i]; });
    rows.set(cid, row);
  }
  const files = await api.runTimeseries(project.id, run.name);
  for (const f of files) {
    const want = full ? f.columns : pickMetrics(f.columns.map((c) => ({ col: c, source: f.file }))).map((m) => m.col);
    if (!want.length) continue;
    const s = await api.runSeries(project.id, run.name, f.file, want);
    for (const [cid, d] of Object.entries(s)) {
      const row = rows.get(cid) ?? {};
      for (const c of want) {
        const v = (d.columns[c] ?? []).filter((x): x is number => x !== null);
        if (v.length) row[c] = v[v.length - 1];
      }
      rows.set(cid, row);
    }
    want.forEach((c) => columns.push({ col: c, source: f.file, group: `Script output: ${f.file}` }));
  }
  return { columns, rows, valueNote: summaries.length ? "script results (final values for time series)" : files.length ? "final values" : "none" };
}

// the stats summary's long tables: one row per case x Stats file x variable with mean/std
// (batch_summary.csv of the base run; batch_summary_dispersion.csv etc. of add-on runs)
const longTablesOf = (run: Run) => run.csvs.filter((f) => /^(batch_summary|stats_summary)(_[a-z]+)?\.csv$/.test(f)
  && !/_(means|settings)\.csv$/.test(f));

// Everything a run knows per case: the summary means plus every M-Star Stats variable of
// the long table (steady-state mean, with std) grouped by Stats file, and the derived rows.
// Column names follow the means table: Fluid.txt variables bare, other files "<stem>: <variable>".
export async function loadAllResults(project: Project, run: Run): Promise<RunResults> {
  const base = await loadRunResults(project, run, true);
  const longs = longTablesOf(run);
  if (!longs.length) return base;
  const single = project.single ? project.cases[0]?.id : null;
  const std = new Map<string, Record<string, number>>();
  const seen = new Set(base.columns.map((c) => c.col));
  for (const long of longs) {
    const t = await api.csv(project.id, `${run.path}/${long}`);
    const ix = (n: string) => t.columns.indexOf(n);
    const iCase = ix("case"), iFile = ix("file"), iVar = ix("variable"), iMean = ix("mean"), iStd = ix("std");
    if (iFile < 0 || iVar < 0 || iMean < 0) continue;
    for (const r of t.rows) {
      const cid = iCase >= 0 ? String(r[iCase]) : single ?? "";
      const file = String(r[iFile] ?? ""), v = String(r[iVar] ?? "");
      const stem = file.replace(/\.txt$/i, "");
      const derived = file.toLowerCase() === "derived";
      const fromStats = /\.txt$/i.test(file);
      const col = derived || /^fluid$/i.test(stem) || !fromStats ? v : `${stem}: ${v}`;
      const group = derived ? "Derived (power, scales, correlations)" : fromStats ? `M-Star Stats: ${file}` : `Script output: ${file}`;
      if (!seen.has(col)) { seen.add(col); base.columns.push({ col, source: long, group }); }
      const row = base.rows.get(cid) ?? {};
      if (row[col] === undefined || row[col] === null) row[col] = r[iMean];
      base.rows.set(cid, row);
      if (iStd >= 0 && typeof r[iStd] === "number") {
        const s = std.get(cid) ?? {};
        if (s[col] === undefined) s[col] = r[iStd];
        std.set(cid, s);
      }
    }
  }
  return { ...base, std, valueNote: "steady-state means" };
}
