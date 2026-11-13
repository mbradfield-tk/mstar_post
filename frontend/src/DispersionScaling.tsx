import { useEffect, useMemo, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, caseName, copyText, download, fmt, toCsv, type Project, type Run } from "./api";
import Plot from "./Plot";
import { caseColor, type PlotStyle } from "./PlotStyle";
import { loadRunResults, newestFirst, runStamp, selectedCaseIds, type Cell, type RunResults } from "./results";

// Interfacial area and transfer-coefficient scaling between cases of a liquid-liquid dispersion
// (Theory: "Estimate A", "Estimate B" and "case-to-case scaling"). Inputs come from the newest
// finished Liquid-liquid dispersion run of each case (dispersion assessment rows) and, for the
// power, from the newest Stats summary run; everything is a ratio against the reference case.

const COL = {
  aRef: "Specific Area at d32 Reference a = 6 phi/d32 [1/m]",
  dRef: "d32 Reference Estimate [m]",
  cells: "d32 Reference / Voxel Size [m/m]",
  aSS: "Plateau Specific Interfacial Area a_ss [1/m]",
  a0: "Initial Specific Interfacial Area a0 [1/m]",
  epsDisp: "Mean Dissipation for k_c, power-based P/M [W/kg]",
  eps: "Power-based Mean Dissipation P/M [W/kg]",
  pv: "Power per Volume P/V (all impellers) [W/m^3]",
  share: "Continuous-Film Resistance Share at d32 Reference, rigid drops [(s/m)/(s/m)]",
};
const S_COL = /^Segregation Index S \(/;

type Inputs = {
  S: number | null; phi: number | null; aRef: number | null; dRef: number | null; aSS: number | null;
  a0: number | null; dx: number | null; eps: number | null; epsScaled: string | null; nu: number | null;
  share: number | null; run: string | null;
};
type Variant = { key: string; est: "A" | "B"; k: "area" | "kc" | "kd" | "series"; label: string };
const VARIANTS: Variant[] = (["A", "B"] as const).flatMap((est) => ([
  ["area", "area only"], ["kc", "with k_c"], ["kd", "with k_d"], ["series", "series K"]] as const)
  .map(([k, l]) => ({ key: `${est}_${k}`, est, k, label: `${est}: ${l}` })));

const num = (v: Cell | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0 ? a / b : null);
const setting = (p: Project, id: string, key: string | RegExp): number | string | null => {
  const s = p.cases.find((c) => c.id === id)?.info?.settings ?? {};
  const k = typeof key === "string" ? key : Object.keys(s).find((x) => key.test(x));
  const v = k ? s[k] : null;
  return typeof v === "number" || typeof v === "string" ? v : null;
};
const numSetting = (p: Project, id: string, key: string | RegExp) => {
  const v = setting(p, id, key);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const fx = (v: number | null, d = 3) => (v === null ? "" : `${fmt(v, d)}x`);

// newest run per case of one task wins
function mergeNewest(runs: Run[], loaded: Record<string, RunResults>) {
  const rows = new Map<string, Record<string, Cell>>(), origin = new Map<string, string>();
  for (const r of runs) {
    const res = loaded[runStamp(r)];
    if (!res) continue;
    for (const [cid, row] of res.rows) if (!rows.has(cid)) { rows.set(cid, row); origin.set(cid, r.label ?? r.name); }
  }
  return { rows, origin };
}

export default function DispersionScaling({ project, style, active, refCase }: {
  project: Project; style: PlotStyle; active: boolean; refCase: string;
}) {
  const store = `mstar_post.dispk.${project.id}`;
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(store) ?? "{}"); } catch { return {}; } }, [store]);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [loaded, setLoaded] = useState<Record<string, RunResults>>({});
  const [error, setError] = useState<string | null>(null);
  const [wInput, setWInput] = useState<string>(saved.w ?? "");
  const [minusA0, setMinusA0] = useState<boolean>(!!saved.minusA0);
  const [view, setView] = useState<"hold" | "rate">(saved.view ?? "hold");
  useEffect(() => localStorage.setItem(store, JSON.stringify({ w: wInput, minusA0, view })), [store, wInput, minusA0, view]);

  useEffect(() => {
    if (!active && runs) return;
    api.runs(project.id).then(setRuns).catch((e) => { if (!runs) setError(e.message); });
  }, [project.id, active]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (task: string) => newestFirst((runs ?? []).filter((r) => r.task === task && (r.status === "done" || r.status === "unknown")));
  const dispRuns = done("dispersion"), baseRuns = done("stats_summary");
  const stamps = [...dispRuns, ...baseRuns].map(runStamp).join("|");
  useEffect(() => {
    let live = true;
    [...dispRuns, ...baseRuns].filter((r) => !loaded[runStamp(r)]).forEach((r) =>
      loadRunResults(project, r).then((res) => live && setLoaded((m) => ({ ...m, [runStamp(r)]: res })))
        .catch((e) => live && setError(e.message)));
    return () => { live = false; };
  }, [stamps]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = [...dispRuns, ...baseRuns].filter((r) => !loaded[runStamp(r)]).length;

  const sel = selectedCaseIds(project);
  const inputs = useMemo(() => {
    const disp = mergeNewest(dispRuns, loaded), base = mergeNewest(baseRuns, loaded);
    const out = new Map<string, Inputs>();
    for (const c of project.cases) {
      const d = disp.rows.get(c.id);
      if (!d || !sel.has(c.id)) continue;
      const b = base.rows.get(c.id) ?? {};
      const sCol = Object.keys(d).find((k) => S_COL.test(k));
      const aRef = num(d[COL.aRef]), dRef = num(d[COL.dRef]), cells = num(d[COL.cells]);
      const cont = String(setting(project, c.id, "Continuous phase (largest initial volume)") ?? "").match(/Fluid (\d+)/)?.[1];
      const dFluid = cont === "1" ? "2" : "1";
      const phi = aRef !== null && dRef !== null ? aRef * dRef / 6 : null;  // the phi the script used: a_ref = 6 phi/d32_ref
      // P/M; the base means table has only P/V: divided by the liquid density phi rho_d + (1 - phi) rho_c
      const rhoC = cont ? numSetting(project, c.id, `Fluid ${cont} density [kg/m^3]`) : null;
      const rhoD = cont ? numSetting(project, c.id, `Fluid ${dFluid} density [kg/m^3]`) : null;
      const pv = num(b[COL.pv]);
      const epsPV = pv !== null && rhoC && rhoD && phi !== null ? pv / (phi * rhoD + (1 - phi) * rhoC) : null;
      out.set(c.id, {
        S: sCol ? num(d[sCol]) : null,
        phi, aRef, dRef, aSS: num(d[COL.aSS]), a0: num(d[COL.a0]),
        dx: dRef !== null && cells ? dRef / cells : numSetting(project, c.id, "dx [m]"),
        eps: num(d[COL.epsDisp]) ?? num(b[COL.eps]) ?? epsPV, epsScaled: null,
        nu: cont ? numSetting(project, c.id, `Fluid ${cont} kinematic viscosity [m^2/s]`) : null,
        share: num(d[COL.share]), run: disp.origin.get(c.id) ?? null,
      });
    }
    // no torque (no power) for a case: eps from a case with the same impeller and volume as N^3
    const imp = (id: string) => numSetting(project, id, /^Impeller diameter \(/);
    const vol = (id: string) => numSetting(project, id, "Volume [L]");
    const rpm = (id: string) => numSetting(project, id, "Agitator speed [rpm]");
    const near = (a: number | null, b: number | null, tol: number) => a !== null && b !== null && Math.abs(a - b) <= tol * Math.abs(b);
    for (const [id, v] of out) {
      if (v.eps !== null) continue;
      const donor = [...out].find(([o, w]) => o !== id && w.eps !== null && !w.epsScaled && near(imp(id), imp(o), 0.01)
        && near(vol(id), vol(o), 0.05) && rpm(id) && rpm(o));
      if (donor) {
        v.eps = donor[1].eps! * (Math.abs(rpm(id)!) / Math.abs(rpm(donor[0])!)) ** 3;
        v.epsScaled = caseName(project, donor[0]);
      }
    }
    return out;
  }, [loaded, stamps, project, [...sel].join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const cases = [...inputs.keys()];
  const ref = inputs.has(refCase) ? refCase : cases[0] ?? null;
  const R = ref ? inputs.get(ref)! : null;
  const wDefault = R?.share ?? 0.5;
  const wParsed = parseFloat(wInput);
  const w = Number.isFinite(wParsed) && wParsed >= 0 && wParsed <= 1 ? wParsed : wDefault;

  const calc = useMemo(() => {
    const per = new Map<string, Record<string, number | null>>();
    const estA = (v: Inputs) => {
      if (v.S === null || v.phi === null || v.aRef === null || v.phi <= 0 || v.phi >= 1) return { x: null, fd: null, aEff: null };
      const r = Math.min(v.S, 1) ** 2 * v.phi / (1 - v.phi);
      const x = r / (1 + r);
      const fd = Math.min(Math.max(1 - x / v.phi, 0), 1);
      return { x, fd, aEff: fd * v.aRef };
    };
    const ext = (v: Inputs) => (v.aSS !== null && v.dx !== null ? (minusA0 && v.a0 !== null ? v.aSS - v.a0 : v.aSS) * v.dx : null);
    const kcScale = (v: Inputs, useNu: boolean) => (v.eps !== null ? (v.eps * (useNu ? v.nu! : 1)) ** 0.25 : null);
    if (!R) return per;
    const aR = estA(R), eR = ext(R);
    for (const [id, v] of inputs) {
      const a = estA(v), e = ext(v);
      const useNu = v.nu !== null && R.nu !== null;
      const areaA = ratio(a.aEff, aR.aEff), extent = ratio(e, eR), fine = ratio(v.aRef, R.aRef);
      const areaB = extent !== null && fine !== null ? extent * fine : null;
      const kc = ratio(kcScale(v, useNu), kcScale(R, useNu)), kd = ratio(R.dRef, v.dRef);
      const ks = kc !== null && kd !== null ? 1 / (w / kc + (1 - w) / kd) : null;
      const row: Record<string, number | null> = { x: a.x, fd: a.fd, aEff: a.aEff, areaA, ext: e, extent, fine, areaB,
        pv: ratio(v.eps, R.eps), kc, kd, ks };
      for (const vr of VARIANTS) {
        const area = vr.est === "A" ? areaA : areaB;
        const k = vr.k === "area" ? 1 : vr.k === "kc" ? kc : vr.k === "kd" ? kd : ks;
        row[vr.key] = area !== null && k !== null && area > 0 && k > 0 ? area * k : null;  // rate factor (K a)_x/(K a)_ref
      }
      const rates = VARIANTS.map((vr) => row[vr.key]).filter((r): r is number => r !== null);
      row.rateMin = rates.length ? Math.min(...rates) : null;
      row.rateMax = rates.length ? Math.max(...rates) : null;
      per.set(id, row);
    }
    return per;
  }, [inputs, R, w, minusA0]);

  const factor = (r: number | null) => (r === null ? null : view === "hold" ? 1 / r : r);
  const names = cases.map((c) => caseName(project, c));
  const colors = cases.map((c) => caseColor(style, c, project.cases.findIndex((x) => x.id === c)));

  const fig = useMemo(() => {
    const others = cases.filter((c) => c !== ref);
    const data: Plotly.Data[] = others.map((c) => ({
      type: "bar", name: caseName(project, c), x: VARIANTS.map((v) => v.label),
      y: VARIANTS.map((v) => factor(calc.get(c)?.[v.key] ?? null)),
      marker: { color: colors[cases.indexOf(c)] },
      text: VARIANTS.map((v) => fx(factor(calc.get(c)?.[v.key] ?? null), 2)), textposition: "outside",
    } as Plotly.Data));
    const layout: Partial<Plotly.Layout> = {
      barmode: "group", yaxis: { type: "log", title: { text: view === "hold" ? "hold-time factor t_x / t_ref" : "rate factor (K a)_x / (K a)_ref" } },
      shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 1, y1: 1, line: { dash: "dot", width: 1 } }],
      margin: { t: 30, b: 80 },
    };
    return { data, layout };
  }, [calc, view, cases.join("|"), ref, style]); // eslint-disable-line react-hooks/exhaustive-deps

  // tables: one row per quantity, one column per case (as on the report slides)
  type TRow = { label: string; title?: string; vals: (string)[]; head?: boolean };
  const vals = (f: (id: string) => string) => cases.map(f);
  const g = (id: string, k: string) => calc.get(id)?.[k] ?? null;
  const inp = (id: string) => inputs.get(id)!;
  const inputRows: TRow[] = [
    { label: "Segregation index S [m^3/m^3]", vals: vals((c) => fmt(inp(c).S, 3)) },
    { label: "Dispersed fraction phi [m^3/m^3]", title: "phi = a_ref d32_ref / 6 (the value the script used)", vals: vals((c) => fmt(inp(c).phi, 3)) },
    { label: "d32 reference [m]", vals: vals((c) => fmt(inp(c).dRef, 3)) },
    { label: "a_ref = 6 phi/d32_ref [1/m]", vals: vals((c) => fmt(inp(c).aRef, 4)) },
    { label: "CFD plateau a_ss [1/m]", vals: vals((c) => fmt(inp(c).aSS, 4)) },
    { label: "Lattice spacing dx [m]", vals: vals((c) => fmt(inp(c).dx, 3)) },
    { label: "Power-based dissipation P/M [W/kg]", title: "P/M from the dispersion run, else the newest Stats summary run (P/V divided by the liquid density); * = scaled as N^3 from another case",
      vals: vals((c) => `${fmt(inp(c).eps, 3)}${inp(c).epsScaled ? " *" : ""}`) },
    { label: "Dispersion run", vals: vals((c) => inp(c).run ?? "") },
  ];
  const aRows: TRow[] = [
    { label: "Free-layer share x [m^3/m^3]", vals: vals((c) => fmt(g(c, "x"), 3)) },
    { label: "Dispersed share f_d [m^3/m^3]", vals: vals((c) => fmt(g(c, "fd"), 2)) },
    { label: "a_eff = f_d a_ref [1/m]", vals: vals((c) => fmt(g(c, "aEff"), 3)) },
    { label: "Area vs ref", head: true, vals: vals((c) => fmt(g(c, "areaA"), 2)) },
  ];
  const bRows: TRow[] = [
    { label: minusA0 ? "(a_ss - a0) dx [m/m]" : "a_ss dx [m/m]", vals: vals((c) => fmt(g(c, "ext"), 3)) },
    { label: "Extent vs ref", vals: vals((c) => fmt(g(c, "extent"), 2)) },
    { label: "Fineness F vs ref (a_ref ratio)", vals: vals((c) => fmt(g(c, "fine"), 3)) },
    { label: "Area vs ref", head: true, vals: vals((c) => fmt(g(c, "areaB"), 2)) },
  ];
  const kRows: TRow[] = [
    { label: "eps ratio (P/M; = P/V ratio at equal density)", vals: vals((c) => fmt(g(c, "pv"), 3)) },
    { label: "k_c ratio = ((eps nu_c) ratio)^(1/4)", title: "Lamont-Scott eddy-cell model; nu_c from input.xml when known for both cases", vals: vals((c) => fmt(g(c, "kc"), 3)) },
    { label: "k_d ratio = d32_ref,ref / d32_ref,x", title: "constant drop Sherwood number (Newman / Kronig-Brink)", vals: vals((c) => fmt(g(c, "kd"), 3)) },
    { label: `K ratio, films in series (w = ${fmt(w, 2)})`, head: true, vals: vals((c) => fmt(g(c, "ks"), 3)) },
  ];
  const fRows: TRow[] = [
    ...VARIANTS.map((v) => ({ label: v.label, head: v.k === "series", vals: vals((c) => fx(factor(g(c, v.key)), 2)) })),
    { label: "Range (all variants)", head: true, vals: vals((c) => {
      const lo = factor(g(c, view === "hold" ? "rateMax" : "rateMin")), hi = factor(g(c, view === "hold" ? "rateMin" : "rateMax"));
      return lo === null || hi === null ? "" : `${fmt(lo, 2)} - ${fmt(hi, 2)}x`;
    }) },
  ];
  const table = (rows: TRow[]) => (
    <div className="scroll-x"><table className="grid">
      <thead><tr><th></th>{cases.map((c, i) => <th key={c} title={c} className={c === ref ? "refrow" : ""}>{names[i]}{c === ref ? " (ref)" : ""}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.label}><td title={r.title} className={r.head ? "strong" : ""}>{r.head ? <b>{r.label}</b> : r.label}</td>
        {r.vals.map((v, i) => <td key={cases[i]} className="num">{r.head ? <b>{v}</b> : v}</td>)}</tr>)}</tbody>
    </table></div>);

  const allRows = [...inputRows, ...aRows.map((r) => ({ ...r, label: `A: ${r.label}` })), ...bRows.map((r) => ({ ...r, label: `B: ${r.label}` })),
    ...kRows, ...fRows.map((r) => ({ ...r, label: `${view === "hold" ? "hold-time factor" : "rate factor"} ${r.label}` }))];
  const csv = () => toCsv(["quantity", ...cases], allRows.map((r) => [r.label, ...r.vals]));
  const missingA = cases.filter((c) => g(c, "areaA") === null), missingB = cases.filter((c) => g(c, "areaB") === null);
  const missingK = cases.filter((c) => g(c, "kc") === null);
  const noRun = project.cases.filter((c) => sel.has(c.id) && !inputs.has(c.id));

  if (error) return <div className="error">{error}</div>;
  if (!runs || (pending > 0 && !cases.length)) return <div className="muted">Loading dispersion results...</div>;
  if (!cases.length) return <div className="card muted">No finished Liquid-liquid dispersion run for the selected cases. Run the add-on (with phase uniformity) from the Run tab.</div>;
  return (
    <div className="overview">
      <div className="card">
        <div className="row">
          <h3 className="grow">Interfacial area and mass-transfer scaling vs <b>{ref ? caseName(project, ref) : "?"}</b></h3>
          <label className="small" title="continuous-film share of the total resistance 1/K = 1/k_c + 1/(m k_d) in the reference case: 1 = k_c controls, 0 = k_d controls">
            continuous-film share w{" "}
            <input style={{ width: 60 }} placeholder={fmt(wDefault, 2)} value={wInput} onChange={(e) => setWInput(e.target.value)} />
          </label>
          <label className="small" title="Estimate B with the initial flat interface subtracted"><input type="checkbox" checked={minusA0} onChange={(e) => setMinusA0(e.target.checked)} /> B: subtract a0</label>
          <select value={view} onChange={(e) => setView(e.target.value as "hold" | "rate")}>
            <option value="hold">hold-time factor t_x / t_ref</option>
            <option value="rate">rate factor (K a)_x / (K a)_ref</option>
          </select>
          <button onClick={() => download(`${project.id}_dispersion_scaling.csv`, csv())}>Export CSV</button>
          <button onClick={() => copyText([["quantity", ...cases.map((c) => caseName(project, c))], ...allRows.map((r) => [r.label, ...r.vals])]
            .map((r) => r.join("\t")).join("\n"))}>Copy table</button>
        </div>
        <div className="small muted">
          Each case from its newest finished dispersion run; % and ratios against the Plots reference case. w = {fmt(w, 2)}
          {wInput ? "" : R?.share !== null && R?.share !== undefined ? " (from the reference case's mass-transfer rows)" : " (default; run the dispersion task with diffusivities and m for the computed share)"}.
          {pending > 0 && ` Loading ${pending} run(s)...`}
          {noRun.length > 0 && ` No dispersion results yet: ${noRun.map((c) => caseName(project, c.id)).join(", ")}.`}
        </div>
      </div>

      <div className="card"><h3>Inputs per case</h3>{table(inputRows)}
        {cases.some((c) => inp(c).epsScaled) && <div className="small muted">* no impeller torque for this case: P/M scaled as N^3 from {[...new Set(cases.map((c) => inp(c).epsScaled).filter(Boolean))].join(", ")} (same impeller and volume).</div>}
      </div>

      <div className="card"><h3>Estimate A: dispersed fraction from S</h3>
        <div className="small muted">Free layer of the dispersed phase (share x) plus a uniform dispersion: r = S^2 phi/(1 - phi), x = r/(1 + r), f_d = 1 - x/phi, a_eff = f_d a_ref.
          A graded dispersion reads as partly layered (f_d low for well-mixed cases, largely cancels in ratios); very sensitive near S = 0.7.</div>
        {table(aRows)}{missingA.length > 0 && <div className="small muted">No S or a_ref for {missingA.map((c) => caseName(project, c)).join(", ")} (run the dispersion add-on with phase uniformity).</div>}
      </div>

      <div className="card"><h3>Estimate B: extent from the grid-normalised area</h3>
        <div className="small muted">Unresolved structures are about c = 6-7 cells across in every case, so a_ss dx ~ 6 phi_b/c measures how much liquid is torn apart.
          Area ratio = extent ratio (CFD) x fineness ratio (correlation). Ratios only; CFD over-separates, so weakly stirred cases are biased low.</div>
        {table(bRows)}{missingB.length > 0 && <div className="small muted">No a_ss or dx for {missingB.map((c) => caseName(project, c)).join(", ")}.</div>}
      </div>

      <div className="card"><h3>Transfer-coefficient ratios K_x / K_ref</h3>
        <div className="small muted">k_c ~ (eps nu_c)^(1/4) Sc^-1/2 (Lamont-Scott; same solute: Sc cancels), k_d ~ 1/d32 (constant drop Sherwood number),
          in series 1/K = 1/k_c + 1/(m k_d): K_x/K_ref = 1/(w/k_c ratio + (1 - w)/k_d ratio).</div>
        {table(kRows)}{missingK.length > 0 && <div className="small muted">No power for {missingK.map((c) => caseName(project, c)).join(", ")}: run the Stats summary (impeller torque needed).</div>}
      </div>

      <div className="card"><h3>{view === "hold" ? "Hold-time factor t_x / t_ref = (area ratio x K ratio)^-1" : "Rate factor (K a)_x / (K a)_ref = area ratio x K ratio"}</h3>
        {table(fRows)}
        <div className="small muted">Each k_c / k_d row assumes one film controls; with both in series the true value lies between them, so the range spans all variants.</div>
        <Plot data={fig.data} layout={fig.layout} height={Math.round(420 * style.heightScale)} exportName={`dispersion_${view}_factors`} style={style} />
      </div>

      <div className="card"><h3>Impact on the reaction rate</h3>
        <ul className="small">
          <li><b>Kinetic regime</b> (slow reaction, Hatta number Ha &lt; 0.3, both phases near equilibrium): the rate does not depend on a or K, factor about 1.</li>
          <li><b>Transfer-limited</b> (slow reaction in the bulk of one phase, transfer slower than reaction): rate ~ K a, use the <i>with k_c</i> rows when the
            reaction is in the continuous phase (external film controls), <i>with k_d</i> when it is inside the drops (internal resistance controls), <i>series K</i> otherwise.</li>
          <li><b>Fast reaction in the film</b> (Ha &gt; 3): rate ~ a C* (D k_r)^(1/2), independent of the film coefficients: use the <i>area only</i> rows.</li>
          <li>Ha = (D k_r)^(1/2) / k with k the film coefficient of the reacting phase. Between regimes the factor lies between 1 and the transfer-limited value. Details: Theory &gt; case-to-case scaling.</li>
        </ul>
      </div>
    </div>
  );
}
