import { useEffect, useMemo, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, caseName, download, fmt, toCsv, type CsvTable, type Project, type Run } from "./api";
import Plot from "./Plot";
import { caseColor, type PlotStyle } from "./PlotStyle";
import { fmtPct, pct } from "./results";
import { fmtG, groupedLimits, loadZonerCases, loadZoneSlices, turboScale, zoneColors, zonerRuns,
         type ZoneCase, type ZoneSlice } from "./zoner";

// Plots > Zones: the cfd_zoner cross-case comparison drawn by the app from the per-case
// CSVs of all finished CFD zoner runs (newest run per case and variable).

type Section = "maps" | "bars" | "cdf" | "diag" | "table";
type ColorMode = "ranks" | "common" | "continuous" | "pct";
const SECTIONS: [Section, string, string][] = [
  ["maps", "Zone maps", "cross-sections of the zones of every case side by side"],
  ["bars", "Zone bars", "zone means, zone mean / case mean, zone volumes and heterogeneity indices per case"],
  ["cdf", "Exposure CDF", "fraction of the fluid volume at or below a value, one curve per case"],
  ["diag", "Diagnostics", "value histograms with the class boundaries, zone weights and axial / radial profiles"],
  ["table", "Tables", "zone statistics and heterogeneity metrics of every case, CSV export"],
];
const COLOR_MODES: [ColorMode, string, string][] = [
  ["ranks", "per case", "each case's zones ranked by their mean (red = highest of that case)"],
  ["common", "common scale", "zones with the same mean share one color across cases"],
  ["continuous", "zone mean", "zones colored by their mean on one continuous (log) scale"],
  ["pct", "% of case mean", "zone mean as % of the case's global mean"],
];
const HET: [string, string][] = [
  ["eta2_between_zone", "eta2 between zones (variance fraction)"], ["cv", "coefficient of variation"],
  ["zone_contrast", "zone contrast (max / min zone mean)"], ["grad_index", "normalized gradient index"],
];
const shortZone = (label: string) => label.replace(/\s*\(mean .*\)\s*$/, "");
const sameRuns = (a: Run[], b: Run[]) => JSON.stringify(a) === JSON.stringify(b);

export default function ZonesPlot({ project, style, active, refCase }: {
  project: Project; style: PlotStyle; active: boolean; refCase: string;
}) {
  const store = `mstar_post.zones.${project.id}`;
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(store) ?? "{}"); } catch { return {}; } }, [store]);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [zcases, setZcases] = useState<ZoneCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variable, setVariable] = useState<string>(saved.variable ?? "");
  const [section, setSection] = useState<Section>(saved.section ?? "maps");
  const [view, setView] = useState<string>(saved.view ?? "side");
  const [colorMode, setColorMode] = useState<ColorMode>(saved.colorMode ?? "ranks");
  const [excluded, setExcluded] = useState<string[]>(saved.excluded ?? []);

  useEffect(() => { api.runs(project.id).then(setRuns).catch((e) => setError(e.message)); }, [project.id]);
  useEffect(() => {
    if (active) api.runs(project.id).then((rs) => setRuns((old) => (old && sameRuns(old, rs) ? old : rs))).catch(() => undefined);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    localStorage.setItem(store, JSON.stringify({ variable, section, view, colorMode, excluded }));
  }, [store, variable, section, view, colorMode, excluded]);
  useEffect(() => {
    if (!runs) return;
    let stale = false;
    loadZonerCases(project, runs).then((z) => { if (!stale) { setZcases(z); setError(null); } })
      .catch((e) => !stale && setError(e.message));
    return () => { stale = true; };
  }, [project, runs]);

  const variables = useMemo(() => {
    const m = new Map<string, string>();
    for (const z of zcases ?? []) if (!m.has(z.variable)) m.set(z.variable, z.alias);
    return [...m.entries()];
  }, [zcases]);
  useEffect(() => {
    if (variables.length && !variables.some(([v]) => v === variable)) setVariable(variables[0][0]);
  }, [variables, variable]);

  // cases of the chosen variable in project order; deselected cases (Cases tab) are left out
  const order = new Map(project.cases.map((c, i) => [c.id, i]));
  const ofVar = (zcases ?? []).filter((z) => z.variable === variable).sort((a, b) => (order.get(a.caseId) ?? 1e9) - (order.get(b.caseId) ?? 1e9));
  const deselected = new Set(project.cases.filter((c) => !c.included).map((c) => c.id));
  const avail = ofVar.filter((z) => !deselected.has(z.caseId));
  const nHidden = ofVar.length - avail.length;
  const sel = avail.filter((z) => !excluded.includes(z.caseId));
  const refZ = ofVar.find((z) => z.caseId === refCase) ?? null;
  const unit = sel[0]?.unit ?? ofVar[0]?.unit ?? "";
  const nZoner = runs ? zonerRuns(runs).length : 0;

  if (error) return <div className="error">{error}</div>;
  if (runs && !nZoner) return <div className="muted">No finished CFD zoner run yet: run the add-on "CFD zoner" on the Run tab to compare the zones of the selected cases here.</div>;
  if (!zcases) return <div className="muted">Loading zoner results...</div>;
  if (!ofVar.length) return <div className="muted">The CFD zoner runs of this project have no zone tables (zones.csv) yet.</div>;

  return (
    <>
      <div className="row small">
        <span className="seg">
          {SECTIONS.map(([s, label, help]) => (
            <button key={s} className={section === s ? "primary" : ""} title={help} onClick={() => setSection(s)}>{label}</button>))}
        </span>
        {variables.length > 1 && (
          <label>Variable <select value={variable} onChange={(e) => setVariable(e.target.value)}>
            {variables.map(([v, a]) => <option key={v} value={v}>{a === v ? v : `${a}: ${v}`}</option>)}</select></label>)}
        {variables.length === 1 && <span className="muted">Variable: {variable}</span>}
        <details className="inline">
          <summary>Cases shown: {sel.length} of {avail.length}{nHidden ? ` (${nHidden} not selected on the Cases tab)` : ""}</summary>
          <div className="row small">
            <button onClick={() => setExcluded([])}>all</button>
            <button onClick={() => setExcluded(avail.map((z) => z.caseId))}>none</button>
          </div>
          <div className="checklist">
            {avail.map((z) => (
              <label key={z.caseId} className="small" title={`${z.caseId}\nrun: ${z.run.label ?? z.run.name}${z.tSel !== null ? `\nanalysis time ${fmtG(z.tSel)} s` : ""}`}>
                <input type="checkbox" checked={!excluded.includes(z.caseId)}
                  onChange={(e) => setExcluded(e.target.checked ? excluded.filter((x) => x !== z.caseId) : [...excluded, z.caseId])} />
                {caseName(project, z.caseId)} <span className="muted">{z.classes.length} zones</span></label>))}
          </div>
        </details>
      </div>
      <div className="small muted">{SECTIONS.find(([s]) => s === section)?.[2]}. Each case comes from the newest finished CFD zoner run that includes it.</div>
      {!sel.length ? <div className="muted">No case selected.</div>
        : section === "maps" ? <ZoneMaps project={project} sel={sel} style={style} view={view} setView={setView} colorMode={colorMode} setColorMode={setColorMode} unit={unit} />
        : section === "bars" ? <ZoneBars project={project} sel={sel} style={style} variable={variable} unit={unit} />
        : section === "cdf" ? <ExposureCdf project={project} sel={sel} style={style} variable={variable} />
        : section === "diag" ? <Diagnostics project={project} sel={sel} style={style} variable={variable} unit={unit} />
        : <ZoneTables project={project} sel={sel} refZ={refZ} variable={variable} />}
    </>
  );
}

// ------------------------------------------------------------------ zone maps

// subplot grid: axis domains and the "x2 domain" annotation refs of n panels
function panelGrid(n: number, gapX = 0.05, gapY = 0.14) {
  const ncols = Math.min(3, n), nrows = Math.ceil(n / ncols);
  const w = (1 - gapX * (ncols - 1)) / ncols, h = (1 - gapY * (nrows - 1)) / nrows;
  return { ncols, nrows, cell: (i: number) => {
    const c = i % ncols, r = Math.floor(i / ncols);
    return { xd: [c * (w + gapX), c * (w + gapX) + w], yd: [1 - r * (h + gapY) - h, 1 - r * (h + gapY)], ax: i ? String(i + 1) : "" };
  } };
}

// nice log-axis ticks between two positive values, as [tickvals (log10), ticktext]
function logTicks(lo: number, hi: number): [number[], string[]] {
  const vals: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
    for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= lo && v <= hi) vals.push(v); }
  if (vals.length > 8) for (let i = vals.length - 1; i >= 0; i--) if (!Number.isInteger(Math.log10(vals[i]))) vals.splice(i, 1);
  return [vals.map((v) => Math.log10(v)), vals.map((v) => fmtG(v))];
}

function ZoneMaps({ project, sel, style, view, setView, colorMode, setColorMode, unit }: {
  project: Project; sel: ZoneCase[]; style: PlotStyle; view: string; setView: (v: string) => void;
  colorMode: ColorMode; setColorMode: (m: ColorMode) => void; unit: string;
}) {
  const [slices, setSlices] = useState<ZoneSlice[][] | null>(null);
  const [fig, setFig] = useState<{ data: Plotly.Data[]; layout: Partial<Plotly.Layout>; height: number;
                                   chips: { title: string; items: { color: string; label: string }[] }[] } | null>(null);
  useEffect(() => {
    let stale = false;
    setSlices(null);
    Promise.all(sel.map((z) => loadZoneSlices(project, z))).then((s) => !stale && setSlices(s));
    return () => { stale = true; };
  }, [project, sel.map((z) => `${z.run.name}|${z.dir}`).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const views = useMemo(() => {
    const m = new Map<string, string>();
    for (const ss of slices ?? []) for (const s of ss) if (!m.has(s.view)) m.set(s.view, s.title);
    return [...m.entries()];
  }, [slices]);
  useEffect(() => { if (views.length && !views.some(([v]) => v === view)) setView(views[0][0]); }, [views, view, setView]);

  useEffect(() => {
    if (!slices) return;
    let stale = false;
    (async () => {
      const items = sel.map((z, i) => ({ z, s: slices[i].find((s) => s.view === view) })).filter((x): x is { z: ZoneCase; s: ZoneSlice } => !!x.s);
      if (!items.length) { setFig(null); return; }
      const { limits, aspect } = groupedLimits(items.map((x) => x.s));
      const grid = panelGrid(items.length);
      const data: Plotly.Data[] = [];
      const layout: Record<string, unknown> = { annotations: [] as unknown[], showlegend: false };
      const chips: { title: string; items: { color: string; label: string }[] }[] = [];
      const turbo = await turboScale();
      // common scale: one color per distinct zone mean (3 significant digits) over all shown cases
      const key = (m: number) => Number(m.toPrecision(3));
      const uniq = [...new Set(items.flatMap((x) => x.z.classes.map((c) => key(c.mean))))].sort((a, b) => a - b);
      const common = await zoneColors(new Map(uniq.map((m) => [m, m])));
      const visible = items.flatMap((x) => { const ids = new Set(Array.from(x.s.cls)); return x.z.classes.filter((c) => ids.has(c.id)).map((c) => c.mean); });
      const pos = visible.filter((m) => m > 0);
      const logScale = pos.length === visible.length && pos.length > 0;
      const vmin = Math.min(...(pos.length ? pos : visible)), vmax = Math.max(...visible);
      const pctMax = Math.max(...items.flatMap((x) => x.z.classes.map((c) => (100 * c.mean) / x.z.globalMean)).filter(Number.isFinite), 100);
      for (let i = 0; i < items.length; i++) {
        const { z, s } = items[i];
        const { xd, yd, ax } = grid.cell(i);
        const byId = new Map(z.classes.map((c) => [c.id, c]));
        const ranks = await zoneColors(new Map(z.classes.map((c) => [c.id, c.mean])));
        const nmax = Math.max(...z.classes.map((c) => c.id), 1);
        const value = (id: number): number | null => {
          const c = byId.get(id);
          if (!c) return null;
          if (colorMode === "continuous") return logScale ? Math.log10(Math.max(c.mean, vmin)) : c.mean;
          if (colorMode === "pct") return (100 * c.mean) / z.globalMean;
          return id;
        };
        const zrows: (number | null)[][] = [], hover: string[][] = [];
        for (let r = 0; r < s.nv; r++) {
          const row: (number | null)[] = new Array(s.nu), hrow: string[] = new Array(s.nu);
          for (let k = 0; k < s.nu; k++) {
            const id = s.cls[r * s.nu + k];
            row[k] = id >= 1 ? value(id) : null;
            hrow[k] = id >= 1 ? `${shortZone(byId.get(id)?.label ?? `zone ${id}`)}: mean ${fmtG(byId.get(id)?.mean ?? NaN)} ${unit}` : "";
          }
          zrows.push(row); hover.push(hrow);
        }
        let colorscale: [number, string][];
        if (colorMode === "ranks" || colorMode === "common") {
          colorscale = [];
          for (let id = 1; id <= nmax; id++) {
            const c = byId.get(id);
            const col = c ? (colorMode === "ranks" ? ranks.get(id)! : common.get(key(c.mean))!) : "#808080";
            colorscale.push([(id - 1) / nmax, col], [id / nmax, col]);
          }
        } else colorscale = turbo;
        const last = i === items.length - 1;
        data.push({
          type: "heatmap", x: s.u, y: s.v, z: zrows, text: hover, xaxis: `x${ax}`, yaxis: `y${ax}`,
          zsmooth: false, hoverongaps: false, colorscale, showscale: last && (colorMode === "continuous" || colorMode === "pct"),
          ...(colorMode === "ranks" || colorMode === "common" ? { zmin: 0.5, zmax: nmax + 0.5 }
            : colorMode === "pct" ? { zmin: 0, zmax: pctMax }
            : { zmin: logScale ? Math.log10(vmin) : vmin, zmax: logScale ? Math.log10(vmax) : vmax }),
          hovertemplate: `${caseName(project, z.caseId)}<br>${s.uLabel.split(" ")[0]} = %{x:.4f} m, ${s.vLabel.split(" ")[0]} = %{y:.4f} m<br>%{text}<extra></extra>`,
          colorbar: colorMode === "pct" ? { title: { text: "zone mean [% of case mean]" }, len: 0.8, thickness: 14 }
            : { title: { text: `zone mean [${unit}]` }, len: 0.8, thickness: 14,
                ...(logScale && (() => { const [tv, tt] = logTicks(vmin, vmax); return { tickvals: tv, ticktext: tt }; })()) },
        } as unknown as Plotly.Data);
        const [u0, u1, v0, v1] = limits[i];
        layout[`xaxis${ax}`] = { domain: xd, range: [u0, u1], title: { text: s.uLabel }, constrain: "domain", zeroline: false, showgrid: false };
        layout[`yaxis${ax}`] = { domain: yd, range: [v0, v1], title: { text: s.vLabel }, scaleanchor: `x${ax}`, scaleratio: 1,
                                 constrain: "domain", zeroline: false, showgrid: false };
        (layout.annotations as unknown[]).push({ text: `<b>${caseName(project, z.caseId)}</b>`, xref: `x${ax} domain`, yref: `y${ax} domain`,
          x: 0.5, y: 1, yshift: 6, xanchor: "center", yanchor: "bottom", showarrow: false, font: { size: style.fontSize } });
        if (colorMode === "ranks") chips.push({ title: caseName(project, z.caseId),
          items: [...z.classes].sort((a, b) => b.mean - a.mean).map((c) => ({ color: ranks.get(c.id)!, label: `${shortZone(c.label)}: ${fmtG(c.mean)} ${unit}` })) });
      }
      if (colorMode === "common") chips.push({ title: `zone means [${unit}]`, items: [...uniq].reverse().map((m) => ({ color: common.get(m)!, label: fmtG(m) })) });
      const title = items[0].s.title;
      layout.title = { text: `Zone maps (${title}) — ${sel[0].variable}` };
      layout.margin = { l: 60, r: colorMode === "continuous" || colorMode === "pct" ? 90 : 20, b: 50 };
      const rowH = Math.min(720, Math.max(280, (1100 / grid.ncols) * aspect)) + 60;
      if (!stale) setFig({ data, layout: layout as Partial<Plotly.Layout>, height: Math.round(grid.nrows * rowH * style.heightScale), chips });
    })();
    return () => { stale = true; };
  }, [slices, view, colorMode, unit, style.fontSize, style.heightScale]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="row small">
        <label>View <select value={view} onChange={(e) => setView(e.target.value)}>
          {views.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <label>Colors <span className="seg">
          {COLOR_MODES.map(([m, label, help]) => <button key={m} className={colorMode === m ? "primary" : ""} title={help} onClick={() => setColorMode(m)}>{label}</button>)}
        </span></label>
        <span className="muted">{COLOR_MODES.find(([m]) => m === colorMode)?.[2]}; vessels of the same width share one scale, grey cells are outside the fluid.</span>
      </div>
      {!slices ? <div className="muted">Loading zone slices...</div>
        : !fig ? <div className="muted">These runs have no stored zone slices (zone_slices.csv): re-run the CFD zoner with the current script.</div>
        : <>
            <Plot data={fig.data} layout={fig.layout} height={fig.height} exportName={`zones_${view}_${colorMode}`} style={style} />
            {fig.chips.length > 0 && (
              <div className="row small zone-chips">
                {fig.chips.map((g) => (
                  <div key={g.title} className="card">
                    <b>{g.title}</b>
                    {g.items.map((it, i) => <div key={i}><span className="swatch" style={{ background: it.color }} /> {it.label}</div>)}
                  </div>))}
              </div>)}
          </>}
    </>
  );
}

// ------------------------------------------------------------------ bars

function ZoneBars({ project, sel, style, variable, unit }: { project: Project; sel: ZoneCase[]; style: PlotStyle; variable: string; unit: string }) {
  const ids = [...new Set(sel.flatMap((z) => z.classes.map((c) => c.id)))].sort((a, b) => a - b);
  const label = (id: number) => shortZone(sel.flatMap((z) => z.classes).find((c) => c.id === id)?.label ?? `class ${id}`);
  const names = sel.map((z) => caseName(project, z.caseId));
  const idx = (z: ZoneCase) => project.cases.findIndex((c) => c.id === z.caseId);
  const counts = new Set(sel.map((z) => z.classes.length));
  const grouped = (metric: (c: { mean: number; volFrac: number }, z: ZoneCase) => number): Plotly.Data[] =>
    sel.map((z, i) => ({
      type: "bar", name: names[i], x: ids.map(label), marker: { color: caseColor(style, z.caseId, idx(z)) },
      y: ids.map((id) => { const c = z.classes.find((x) => x.id === id); return c ? metric(c, z) : null; }),
      hovertemplate: `${names[i]}<br>%{x}: %{y:.4g}<extra></extra>`,
    } as Plotly.Data));
  const perCase = (y: (z: ZoneCase) => number | null): Plotly.Data[] => [{
    type: "bar", x: names, y: sel.map(y), showlegend: false,
    marker: { color: sel.map((z) => (style.barsByCase ? caseColor(style, z.caseId, idx(z)) : style.barColor)) },
    hovertemplate: "%{x}: %{y:.4g}<extra></extra>",
  } as Plotly.Data];
  const h = Math.round(360 * style.heightScale);
  return (
    <>
      {counts.size > 1 && <div className="small muted">Zone counts differ between the cases ({[...counts].join(", ")}): classes are aligned by rank where present.</div>}
      <Plot data={grouped((c) => c.mean)} height={h} exportName="zone_means" style={style}
            layout={{ title: { text: `Zone means of ${variable} (per-case zoning, rank-aligned)` }, barmode: "group",
                      yaxis: { type: "log", title: { text: `zone mean [${unit}]` } } }} />
      <Plot data={grouped((c, z) => c.mean / z.globalMean)} height={h} exportName="zone_ratios" style={style}
            layout={{ title: { text: `Local vs global ${variable} (1 = case average)` }, barmode: "group",
                      yaxis: { title: { text: "zone mean / case global mean" } },
                      shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 1, y1: 1, line: { dash: "dash", width: 1 } }] }} />
      <Plot data={grouped((c) => 100 * c.volFrac)} height={h} exportName="zone_volfrac" style={style}
            layout={{ title: { text: "Zone volume fractions" }, barmode: "group", yaxis: { title: { text: "volume fraction [%]" } } }} />
      <Plot data={perCase((z) => z.globalMean)} height={h} exportName="global_means" style={style}
            layout={{ title: { text: `Global fluid mean of ${variable}` }, yaxis: { title: { text: `[${unit}]` } } }} />
      <div className="plot-grid2">
        {HET.map(([k, title]) => (
          <Plot key={k} data={perCase((z) => (Number.isFinite(z.het[k]) ? z.het[k] : null))} height={Math.round(300 * style.heightScale)}
                exportName={`heterogeneity_${k}`} style={style} layout={{ title: { text: title }, yaxis: { title: { text: k } } }} />))}
      </div>
      <div className="small muted">Significant local-vs-global gradients (eta2 and contrast above the run's thresholds):{" "}
        {sel.map((z, i) => <span key={z.caseId}>{i ? ", " : ""}{names[i]}: <b>{z.het.significant_gradients ? "yes" : "no"}</b></span>)}</div>
    </>
  );
}

// ------------------------------------------------------------------ exposure CDF

function useCaseCsv(project: Project, sel: ZoneCase[], file: string) {
  const [tables, setTables] = useState<(CsvTable | null)[] | null>(null);
  const key = sel.map((z) => `${z.run.name}|${z.dir}`).join(",");
  useEffect(() => {
    let stale = false;
    setTables(null);
    Promise.all(sel.map((z) => api.csv(project.id, `${z.run.path}/${z.dir}/${file}`).catch(() => null)))
      .then((t) => !stale && setTables(t));
    return () => { stale = true; };
  }, [project.id, key, file]); // eslint-disable-line react-hooks/exhaustive-deps
  return tables;
}

function ExposureCdf({ project, sel, style, variable }: { project: Project; sel: ZoneCase[]; style: PlotStyle; variable: string }) {
  const tables = useCaseCsv(project, sel, "exposure_cdf.csv");
  if (!tables) return <div className="muted">Loading exposure curves...</div>;
  const data: Plotly.Data[] = [];
  let anyPos = false;
  sel.forEach((z, i) => {
    const t = tables[i];
    if (!t) return;
    const name = caseName(project, z.caseId), color = caseColor(style, z.caseId, project.cases.findIndex((c) => c.id === z.caseId));
    const x = t.rows.map((r) => r[0] as number), y = t.rows.map((r) => 100 * (r[1] as number));
    anyPos ||= x.some((v) => v > 0);
    data.push({ type: "scatter", mode: "lines", x, y, name, legendgroup: name, line: { color, width: style.lineWidth + 0.7 } });
    data.push({ type: "scatter", mode: "lines", x: [z.globalMean, z.globalMean], y: [0, 100], legendgroup: name, showlegend: false,
                name: `${name} global mean (${fmtG(z.globalMean)})`, line: { color, dash: "dash", width: 1 }, hovertemplate: `${name} global mean %{x:.4g}<extra></extra>` });
  });
  return (
    <Plot data={data} height={Math.round(520 * style.heightScale)} exportName="exposure_cdf" style={style}
          layout={{ title: { text: "Volume exposure by case (dashed: case global means)" },
                    xaxis: { title: { text: variable }, type: anyPos ? "log" : "linear" },
                    yaxis: { title: { text: "cumulative fluid volume [%]" }, range: [0, 100] } }} />
  );
}

// ------------------------------------------------------------------ diagnostics

function Diagnostics({ project, sel, style, variable, unit }: { project: Project; sel: ZoneCase[]; style: PlotStyle; variable: string; unit: string }) {
  const hist = useCaseCsv(project, sel, "histogram.csv");
  const prof = useCaseCsv(project, sel, "profiles.csv");
  const [colors, setColors] = useState<Map<string, string>[] | null>(null);
  useEffect(() => {
    let stale = false;
    Promise.all(sel.map((z) => zoneColors(new Map(z.classes.map((c) => [c.id, c.mean])))))
      .then((m) => !stale && setColors(m.map((x) => new Map([...x].map(([k, v]) => [String(k), v])))));
    return () => { stale = true; };
  }, [sel.map((z) => `${z.run.name}|${z.dir}`).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = sel.map((z) => caseName(project, z.caseId));
  const cc = (z: ZoneCase) => caseColor(style, z.caseId, project.cases.findIndex((c) => c.id === z.caseId));

  // histograms: one panel per case, stepped outline with class boundaries (dashed) and zone means (dotted)
  let histFig: { data: Plotly.Data[]; layout: Record<string, unknown>; height: number } | null = null;
  if (hist && colors) {
    const grid = panelGrid(sel.length, 0.07, 0.2);
    const data: Plotly.Data[] = [];
    const layout: Record<string, unknown> = { annotations: [] as unknown[], showlegend: false };
    sel.forEach((z, i) => {
      const t = hist[i];
      const { xd, yd, ax } = grid.cell(i);
      let ymax = 1;
      if (t) {
        const lo = t.rows.map((r) => r[0] as number), hi = t.rows.map((r) => r[1] as number), n = t.rows.map((r) => 100 * (r[3] as number));
        ymax = Math.max(...n, 1e-9);
        data.push({ type: "scatter", mode: "lines", line: { shape: "hv", color: cc(z), width: style.lineWidth }, fill: "tozeroy",
                    x: [...lo, hi[hi.length - 1]], y: [...n, 0], xaxis: `x${ax}`, yaxis: `y${ax}`, name: names[i],
                    hovertemplate: "%{x:.4g}: %{y:.3g} %<extra></extra>" } as Plotly.Data);
      }
      for (const c of z.classes) {
        if (c.upper !== null && Number.isFinite(c.upper))
          data.push({ type: "scatter", mode: "lines", x: [c.upper, c.upper], y: [0, ymax], xaxis: `x${ax}`, yaxis: `y${ax}`,
                      line: { color: "#888", dash: "dash", width: 1 }, hovertemplate: `boundary %{x:.4g}<extra></extra>` } as Plotly.Data);
        data.push({ type: "scatter", mode: "lines", x: [c.mean, c.mean], y: [0, ymax], xaxis: `x${ax}`, yaxis: `y${ax}`,
                    line: { color: colors[i].get(String(c.id)), dash: "dot", width: 1.5 }, hovertemplate: `${shortZone(c.label)} mean %{x:.4g}<extra></extra>` } as Plotly.Data);
      }
      layout[`xaxis${ax}`] = { domain: xd, type: "log", title: { text: `${variable}` } };
      layout[`yaxis${ax}`] = { domain: yd, title: { text: "fluid volume [%]" } };
      (layout.annotations as unknown[]).push({ text: `<b>${names[i]}</b>`, xref: `x${ax} domain`, yref: `y${ax} domain`, x: 0.5, y: 1, yshift: 4,
        xanchor: "center", yanchor: "bottom", showarrow: false, font: { size: style.fontSize } });
    });
    layout.title = { text: `Distribution of ${variable} with class boundaries (dashed) and zone means (dotted)` };
    histFig = { data, layout, height: Math.round(grid.nrows * 300 * style.heightScale + 60) };
  }

  // zone weights: volume fraction (solid) vs contribution to the case mean (hatched), grouped by case
  const ids = [...new Set(sel.flatMap((z) => z.classes.map((c) => c.id)))].sort((a, b) => a - b);
  const label = (id: number) => shortZone(sel.flatMap((z) => z.classes).find((c) => c.id === id)?.label ?? `class ${id}`);
  const weights: Plotly.Data[] = sel.flatMap((z, i) => [
    { type: "bar", name: `${names[i]} volume`, legendgroup: names[i], x: ids.map(label), marker: { color: cc(z) },
      y: ids.map((id) => { const c = z.classes.find((x) => x.id === id); return c ? 100 * c.volFrac : null; }),
      hovertemplate: `${names[i]}<br>%{x}: %{y:.1f} % of the volume<extra></extra>` },
    { type: "bar", name: `${names[i]} contribution`, legendgroup: names[i], x: ids.map(label),
      marker: { color: cc(z), pattern: { shape: "/", fgcolor: "#ffffff", fgopacity: 0.6 } },
      y: ids.map((id) => { const c = z.classes.find((x) => x.id === id); return c?.contribution !== null && c?.contribution !== undefined ? 100 * c.contribution : null; }),
      hovertemplate: `${names[i]}<br>%{x}: %{y:.1f} % of the mean<extra></extra>` },
  ] as Plotly.Data[]);

  // axial and radial profiles overlaid across cases
  let profFig: { data: Plotly.Data[]; layout: Record<string, unknown> } | null = null;
  if (prof) {
    const data: Plotly.Data[] = [];
    let anyPos = false;
    const xl: string[] = ["", ""];
    sel.forEach((z, i) => {
      const t = prof[i];
      if (!t) return;
      const kinds = [...new Set(t.rows.map((r) => String(r[0])))];
      kinds.slice(0, 2).forEach((k, j) => {
        const rows = t.rows.filter((r) => r[0] === k && typeof r[2] === "number");
        const y = rows.map((r) => r[2] as number);
        anyPos ||= y.some((v) => v > 0);
        xl[j] = k.startsWith("axial") ? `${k.replace("axial ", "").replace(/[()]/g, "")} [m] (along the shaft axis)` : "radius from the tank axis [m]";
        data.push({ type: "scatter", mode: "lines", x: rows.map((r) => r[1] as number), y, name: names[i], legendgroup: names[i], showlegend: j === 0,
                    line: { color: cc(z), width: style.lineWidth + 0.5 }, xaxis: j ? "x2" : "x", yaxis: j ? "y2" : "y",
                    hovertemplate: `${names[i]}<br>%{x:.4f} m: %{y:.4g}<extra></extra>` } as Plotly.Data);
        data.push({ type: "scatter", mode: "lines", x: [Math.min(...rows.map((r) => r[1] as number)), Math.max(...rows.map((r) => r[1] as number))],
                    y: [z.globalMean, z.globalMean], legendgroup: names[i], showlegend: false, name: `${names[i]} global mean`,
                    line: { color: cc(z), dash: "dash", width: 1 }, xaxis: j ? "x2" : "x", yaxis: j ? "y2" : "y", hoverinfo: "skip" } as Plotly.Data);
      });
    });
    profFig = { data, layout: {
      title: { text: `Volume-averaged profiles of ${variable} (dashed: case global means)` },
      xaxis: { domain: [0, 0.46], title: { text: xl[0] } }, yaxis: { title: { text: `[${unit}]` }, type: anyPos ? "log" : "linear" },
      xaxis2: { domain: [0.54, 1], title: { text: xl[1] } }, yaxis2: { anchor: "x2", title: { text: `[${unit}]` }, type: anyPos ? "log" : "linear" },
    } };
  }

  return (
    <>
      {histFig ? <Plot data={histFig.data} layout={histFig.layout as Partial<Plotly.Layout>} height={histFig.height} exportName="zone_histograms" style={style} />
        : <div className="muted">Loading histograms...</div>}
      <Plot data={weights} height={Math.round(380 * style.heightScale)} exportName="zone_weights" style={style}
            layout={{ title: { text: "Zone volume fractions (solid) and contributions to the case mean (hatched)" }, barmode: "group",
                      yaxis: { title: { text: "percent [%]" } } }} />
      {profFig ? <Plot data={profFig.data} layout={profFig.layout as Partial<Plotly.Layout>} height={Math.round(400 * style.heightScale)} exportName="zone_profiles" style={style} />
        : <div className="muted">Loading profiles...</div>}
      <div className="small muted">The steady-state detection trace of each case (time_trace.csv) is available under Plots &gt; Case time series and Time series (source "App script outputs").</div>
    </>
  );
}

// ------------------------------------------------------------------ tables

function ZoneTables({ project, sel, refZ, variable }: { project: Project; sel: ZoneCase[]; refZ: ZoneCase | null; variable: string }) {
  const names = sel.map((z) => caseName(project, z.caseId));
  const cmpCols = ["case", "zone", "class", "cells [count]", "volume [m^3]", "volume fraction [m^3/m^3]", `mean ${variable}`, "std", "min", "max",
                   "case global mean", "mean / global mean", "run"];
  const cmpRows = sel.flatMap((z, i) => z.classes.map((c) => [names[i], shortZone(c.label), c.id, c.cells, c.volume, c.volFrac, c.mean, c.std, c.min, c.max,
                                                            z.globalMean, c.mean / z.globalMean, z.run.label ?? z.run.name]));
  const hetKeys = [...new Set(sel.flatMap((z) => Object.keys(z.het)))];
  const refName = refZ ? caseName(project, refZ.caseId) : "";
  const hetRows = sel.map((z, i) => [names[i], ...hetKeys.map((k) => (Number.isFinite(z.het[k]) ? z.het[k] : null))]);
  const cell = (v: number | null, k: string) => {
    if (v === null) return "";
    if (k === "significant_gradients") return v ? "yes" : "no";
    const r = refZ && refZ.het[k];
    const p = typeof r === "number" && k !== "significant_gradients" ? pct(v, r) : null;
    return <>{fmt(v)}{p !== null && <span className="muted small"> {fmtPct(p)}</span>}</>;
  };
  return (
    <>
      <div className="row small"><b>Zone statistics by case</b>
        <button onClick={() => download("zone_comparison.csv", toCsv(cmpCols, cmpRows))}>Export CSV</button></div>
      <div className="tablewrap">
        <table className="grid small">
          <thead><tr>{cmpCols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{cmpRows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? "num" : ""}>{typeof v === "number" ? fmt(v) : String(v)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <div className="row small"><b>Heterogeneity by case</b>
        {refZ && <span className="muted">% vs {refName}</span>}
        <button onClick={() => download("heterogeneity_by_case.csv", toCsv(["case", ...hetKeys], hetRows))}>Export CSV</button></div>
      <div className="tablewrap">
        <table className="grid small">
          <thead><tr><th>case</th>{hetKeys.map((k) => <th key={k}>{k}</th>)}</tr></thead>
          <tbody>{sel.map((z, i) => (
            <tr key={z.caseId} className={refZ?.caseId === z.caseId ? "refrow" : ""}>
              <td>{names[i]}</td>{hetKeys.map((k) => <td key={k} className="num">{cell(Number.isFinite(z.het[k]) ? z.het[k] : null, k)}</td>)}
            </tr>))}</tbody>
        </table>
      </div>
    </>
  );
}
