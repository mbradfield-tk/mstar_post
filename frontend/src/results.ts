import { api, type Project, type Run, type RunSeriesFile } from "./api";

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
  [/^Interfacial Area A_int \[/, "A_int"],
  [/^Overall K_oc a, circulating drops/, "K_oc a (circ.)"],
  [/^Extraction Time t90 = ln10\/k, circulating drops/, "t90 extraction (circ.)"],
  [/^Interface Enhancement E/, "E = a/a0"],
  [/^Sauter Diameter d32 \(/, "d32"],
  [/^Dispersion Time t95/, "t95 disp"],
  [/^Number of Drops/, "Drops"],
  [/^Zonal CoV of Phase Fraction \(Fluid 1/, "Zonal CoV"],
  [/^Segregation Index S \(Fluid 1/, "S"],
  [/^Homogeneity Time t_S \(Fluid 1/, "t_S"],
  [/^Continuous Phase/, "Continuous phase"],
  [/^Dispersion State/, "Dispersion state"],
  [/^Drop Resolution/, "Drop resolution"],
  [/^d32 Reference Estimate \[/, "d32 (correlation)"],
  [/^CFD \/ Correlation Specific Area/, "a CFD / a corr."],
  [/^Best-Estimate Specific Area/, "a best estimate"],
  [/^UA overall energy balance \[/, "UA (energy balance)"],
  [/^U overall energy balance \[/, "U (energy balance)"],
  [/^UA overall least-squares \[/, "UA (least squares)"],
  [/^UA film energy balance \[/, "UA film"],
  [/^Energy closure \[/, "Energy closure"],
  [/^UA \[/, "UA"],
  [/^U \[/, "U"],
  [/^Q_wall \[/, "Q wall"],
  [/^global mean \(/, "Zoner global mean"],
  [/^eta2 between zones \(/, "eta2 between zones"],
  [/^CV \(/, "CV"],
  [/^zone contrast \(/, "Zone contrast"],
  [/^gradient index \(/, "Gradient index"],
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
  partial?: boolean;                       // a file could not be read: shown, but not kept in the cache
};

export const unitOf = (col: string) => col.match(/\[([^\]]*)\]\s*$/)?.[1] ?? "";
export const shortName = (col: string) => col.replace(/\s*\[[^\]]*\]\s*$/, "");
// The one "% vs ref" of the app: (value - ref) / ref x 100 = (value / ref - 1) x 100. It does not depend
// on the sign convention of the variable (a torque of -2 against a reference of -1 is +100 %, as
// 2 against 1); null without two numbers or for a reference of 0.
export const pct = (v: unknown, r: unknown) =>
  typeof v === "number" && typeof r === "number" && r !== 0 && Number.isFinite(v) && Number.isFinite(r) ? ((v - r) / r) * 100 : null;
export const PCT_HELP = "% vs ref = (value - ref) / ref x 100 = (value / ref - 1) x 100. With a negative reference "
  + "a value of larger magnitude reads positive (-2 vs -1 = +100 %); blank when the reference is 0 or not a number.";
export const fmtPct = (p: number) => `${p > 0 ? "+" : ""}${p.toFixed(Math.abs(p) < 10 ? 1 : 0)}%`;

// Newest results first: a re-run keeps its folder name but gets new times, so runs are ordered by
// finished_at ?? created_at (runs without a job record: the time stamp of the folder name).
const nameTime = (name: string) => {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000 : 0;
};
export const runTime = (r: Run) => r.finished_at ?? r.created_at ?? nameTime(r.name);
export const newestFirst = (runs: Run[]) => [...runs].sort((a, b) => runTime(b) - runTime(a) || b.name.localeCompare(a.name));
// identity of the outputs of a run: changes when the run is made again
export const runStamp = (r: Run) => `${r.name}@${r.finished_at ?? ""}@${r.created_at ?? ""}@${r.csvs.length}`;
const finished = (r: Run) => r.status !== "queued" && r.status !== "running";

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

// The case a per-case output path (<case id>[/<sub dir>][/<file>]) belongs to. Case ids contain "/"
// and may be nested (a and a/b), so the longest id that is a prefix wins.
export const caseOfDir = (p: Project, f: string): string | undefined => {
  let best: string | undefined;
  for (const c of p.cases) if ((f === c.id || f.startsWith(`${c.id}/`)) && c.id.length > (best?.length ?? -1)) best = c.id;
  return best;
};
const caseOfPath = (project: Project, f: string) =>
  caseOfDir(project, f) ?? (project.single ? project.cases[0]?.id : undefined) ?? f.slice(0, f.lastIndexOf("/"));

// the cases the user works on: the selected ones, or all when none is selected
export const selectedCaseIds = (p: Project) => {
  const s = p.cases.filter((c) => c.included);
  return new Set((s.length ? s : p.cases).map((c) => c.id));
};
export const runCaseIds = (r: Run): string[] | null =>
  Array.isArray(r.params?.cases) && r.params.cases.length ? r.params.cases as string[] : null;
// runs without a case list (old runs) are kept
export const runHasCases = (r: Run, ids: Set<string>) => {
  const rc = runCaseIds(r);
  return !rc || rc.some((id) => ids.has(id));
};
// the case a run file belongs to (longest matching id prefix), null for run-level files
export const fileCase = (p: Project, f: string): string | null => p.single || !f.includes("/") ? null : caseOfDir(p, f) ?? null;
export const fileForCases = (p: Project, f: string, ids: Set<string>) => {
  const c = fileCase(p, f);
  return !c || ids.has(c);
};

// One load per run and state of its outputs, shared by the run overview, the job-type comparisons
// and the plots (runStamp: a run made again is loaded again). Unfinished runs are not cached.
const resultsCache = new Map<string, Promise<RunResults>>();
const runFilesCache = new Map<string, Promise<RunSeriesFile[]>>();
function cached<T>(cache: Map<string, Promise<T>>, key: string, run: Run, load: () => Promise<T>): Promise<T> {
  if (!finished(run)) return load();
  let p = cache.get(key);
  if (!p) {
    if (cache.size > 400) cache.clear();
    p = load();
    cache.set(key, p);
    // failed and incomplete loads (a summary file that could not be read) are asked again next time
    const drop = () => { if (cache.get(key) === p) cache.delete(key); };
    p.then((v) => { if ((v as { partial?: boolean } | null)?.partial) drop(); }, drop);
  }
  return p;
}
// after the result files of finished runs were changed in place (body rename) or on Refresh
export const clearResultsCache = () => { resultsCache.clear(); runFilesCache.clear(); };
// the per-case time-series CSVs of a run with their columns and cases
export const runSeriesFiles = (pid: string, run: Run) =>
  cached(runFilesCache, `${pid}|${runStamp(run)}`, run, () => api.runTimeseries(pid, run.name));

// One row per case of a run: merged root *_means.csv (first file wins per column), or
// the final value of every key column of the per-case time series.
export const loadRunResults = (project: Project, run: Run, full = false): Promise<RunResults> =>
  cached(resultsCache, `${full ? "full" : "key"}|${project.id}|${project.cases.length}|${runStamp(run)}`, run, () => readRunResults(project, run, full));

async function readRunResults(project: Project, run: Run, full: boolean): Promise<RunResults> {
  const means = meansFilesOf(run);
  const columns: Column[] = [];
  const seen = new Set<string>();
  const add = (c: string, source: string, group: string) => { if (!seen.has(c)) { seen.add(c); columns.push({ col: c, source, group }); } };
  const rows = new Map<string, Record<string, Cell>>();
  if (means.length) {
    const tables = await Promise.all(means.map((f) => api.csv(project.id, `${run.path}/${f}`).then((t) => [f, t] as const)));
    for (const [f, t] of tables) {
      if (t.columns[0] !== "case") continue;
      t.columns.slice(1).forEach((c) => add(c, f, "Summary means"));
      for (const r of t.rows) {
        const row = rows.get(String(r[0])) ?? {};
        t.columns.forEach((c, i) => { if (i && row[c] === undefined) row[c] = r[i]; });
        rows.set(String(r[0]), row);
      }
    }
    return { columns, rows, valueNote: "steady-state means" };
  }
  // per-case tasks: their scalar summaries first (ua_summary.csv), then the final time-series values;
  // all files are requested together
  const summaries = caseSummaryFilesOf(run);
  let partial = false;
  const [sums, files] = await Promise.all([
    Promise.all(summaries.map((f) => api.csv(project.id, `${run.path}/${f}`).catch(() => { partial = true; return null; }))),
    runSeriesFiles(project.id, run)]);
  summaries.forEach((f, k) => {
    const t = sums[k];
    if (!t || !t.rows.length) return;
    const cid = caseOfPath(project, f);
    const name = f.slice(f.lastIndexOf("/") + 1);
    t.columns.forEach((c) => c !== "case" && add(c, name, `Script summary: ${name}`));
    const row = rows.get(cid) ?? {};
    t.columns.forEach((c, i) => { if (c !== "case" && row[c] === undefined) row[c] = t.rows[0][i]; });
    rows.set(cid, row);
  });
  const wants = files.map((f) => (full ? f.columns : pickMetrics(f.columns.map((c) => ({ col: c, source: f.file }))).map((m) => m.col)));
  const series = await Promise.all(files.map((f, k) => (wants[k].length ? api.runSeries(project.id, run.name, f.file, wants[k]) : null)));
  files.forEach((f, k) => {
    const s = series[k];
    if (!s) return;
    for (const [cid, d] of Object.entries(s)) {
      const row = rows.get(cid) ?? {};
      for (const c of wants[k]) {
        const v = (d.columns[c] ?? []).filter((x): x is number => x !== null);
        if (v.length && row[c] === undefined) row[c] = v[v.length - 1];
      }
      rows.set(cid, row);
    }
    wants[k].forEach((c) => add(c, f.file, `Script output: ${f.file}`));
  });
  return { columns, rows, partial: partial || undefined,
    valueNote: summaries.length ? "script results (final values for time series)" : files.length ? "final values" : "none" };
}

// the stats summary's long tables: one row per case x Stats file x variable with mean/std
// (batch_summary.csv of the base run; batch_summary_dispersion.csv etc. of add-on runs)
const longTablesOf = (run: Run) => run.csvs.filter((f) => /^(batch_summary|stats_summary)(_[a-z]+)?\.csv$/.test(f)
  && !/_(means|settings)\.csv$/.test(f));

// Everything a run knows per case: the summary means plus every M-Star Stats variable of
// the long table (steady-state mean, with std) grouped by Stats file, and the derived rows.
// Column names follow the means table: Fluid.txt variables bare, other files "<stem>: <variable>".
export const loadAllResults = (project: Project, run: Run): Promise<RunResults> =>
  cached(resultsCache, `all|${project.id}|${project.cases.length}|${runStamp(run)}`, run, () => readAllResults(project, run));

async function readAllResults(project: Project, run: Run): Promise<RunResults> {
  const longs = longTablesOf(run);
  const [full, tables] = await Promise.all([loadRunResults(project, run, true),
    Promise.all(longs.map((long) => api.csv(project.id, `${run.path}/${long}`)))]);
  if (!longs.length) return full;
  // the cached summary result is shared: extend copies
  const base: RunResults = { ...full, columns: [...full.columns], rows: new Map([...full.rows].map(([k, v]) => [k, { ...v }])) };
  const single = project.single ? project.cases[0]?.id : null;
  const std = new Map<string, Record<string, number>>();
  const seen = new Set(base.columns.map((c) => c.col));
  longs.forEach((long, k) => {
    const t = tables[k];
    const ix = (n: string) => t.columns.indexOf(n);
    const iCase = ix("case"), iFile = ix("file"), iVar = ix("variable"), iMean = ix("mean"), iStd = ix("std");
    if (iFile < 0 || iVar < 0 || iMean < 0) return;
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
  });
  return { ...base, std, valueNote: "steady-state means" };
}
