import { useEffect, useMemo, useRef, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { api, caseName, download, fmt, toCsv, type CsvTable, type Project, type Run } from "./api";
import Plot from "./Plot";
import { caseColor, type PlotStyle } from "./PlotStyle";
import { fmtPct, pct, PCT_HELP, runStamp, selectedCaseIds } from "./results";
import { fmtG, groupedLimits, loadZonerCases, loadZoneSlice, loadZoneSliceMetas, turboScale, zoneColors, zoneKey, zonerRuns,
         type ZoneCase, type ZoneSlice, type ZoneSliceMeta } from "./zoner";

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
// per-case data (slices, tables, colors) is keyed by the zoner output folder and the state of its run,
// never by the position in the shown list: a render with a changed case list must not read the data
// of another case, and a run made again is read again
const zKey = zoneKey;
const hasAll = (m: Map<string, unknown> | null, sel: ZoneCase[]): boolean => !!m && sel.every((z) => m.has(zKey(z)));
const sameRuns = (a: Run[], b: Run[]) => JSON.stringify(a) === JSON.stringify(b);
// display names and plot colors of the shown cases, handed to every section (they keep their identity
// while cases, names and style stay the same, so the figures are not rebuilt on other updates)
type Shown = { sel: ZoneCase[]; names: Map<string, string>; colors: Map<string, string> };

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

  // the run list: on the first show and whenever the mode or tab is shown again
  useEffect(() => {
    if (!active && runs) return;
    api.runs(project.id).then((rs) => setRuns((old) => (old && sameRuns(old, rs) ? old : rs)))
      .catch((e) => { if (!runs) setError(e.message); });  // a failed refresh keeps what is shown
  }, [project.id, active]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    localStorage.setItem(store, JSON.stringify({ variable, section, view, colorMode, excluded }));
  }, [store, variable, section, view, colorMode, excluded]);
  // The zoner results are read again only when the zoner runs or the cases of the project change, not
  // on every project update (case selection, names) nor when another job finishes.
  const caseIds = project.cases.map((c) => c.id).join("|");
  const zonerKey = runs ? zonerRuns(runs).map(runStamp).join("|") : null;
  useEffect(() => {
    if (!runs) return;
    let stale = false;
    loadZonerCases(project, runs).then((z) => { if (!stale) { setZcases(z); setError(null); } })
      .catch((e) => !stale && setError(e.message));
    return () => { stale = true; };
  }, [project.id, caseIds, zonerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const variables = useMemo(() => {
    const m = new Map<string, string>();
    for (const z of zcases ?? []) if (!m.has(z.variable)) m.set(z.variable, z.alias);
    return [...m.entries()];
  }, [zcases]);
  useEffect(() => {
    if (variables.length && !variables.some(([v]) => v === variable)) setVariable(variables[0][0]);
  }, [variables, variable]);

  // cases of the chosen variable in project order; cases not selected (Cases tab; none selected = all) are left out
  const selIds = selectedCaseIds(project);
  const selCases = [...selIds].join("|");
  const lastSel = useRef<ZoneCase[]>([]);
  const { ofVar, avail, sel } = useMemo(() => {
    const order = new Map(project.cases.map((c, i) => [c.id, i]));
    const ofVar = (zcases ?? []).filter((z) => z.variable === variable).sort((a, b) => (order.get(a.caseId) ?? 1e9) - (order.get(b.caseId) ?? 1e9));
    const avail = ofVar.filter((z) => selIds.has(z.caseId) || !order.has(z.caseId));
    // the same cases as before keep the array, so ticking a case without zoner results redraws nothing
    const now = avail.filter((z) => !excluded.includes(z.caseId)), old = lastSel.current;
    const sel = now.length === old.length && now.every((z, i) => z === old[i]) ? old : now;
    lastSel.current = sel;
    return { ofVar, avail, sel };
  }, [zcases, variable, excluded, selCases, caseIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const aliases = JSON.stringify(project.aliases ?? {});
  const names = useMemo(() => new Map(sel.map((z) => [z.caseId, caseName(project, z.caseId)])), [sel, aliases]); // eslint-disable-line react-hooks/exhaustive-deps
  const colors = useMemo(() => new Map(sel.map((z) => [z.caseId, caseColor(style, z.caseId, project.cases.findIndex((c) => c.id === z.caseId))])),
    [sel, style, caseIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown: Shown = useMemo(() => ({ sel, names, colors }), [sel, names, colors]);
  const nHidden = ofVar.length - avail.length;
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
              <label key={z.caseId} className="small" title={`${z.caseId}\nrun: ${z.run.label ?? z.run.name}${z.source ? `\n${z.source}` : ""}`}>
                <input type="checkbox" checked={!excluded.includes(z.caseId)}
                  onChange={(e) => setExcluded(e.target.checked ? excluded.filter((x) => x !== z.caseId) : [...excluded, z.caseId])} />
                {caseName(project, z.caseId)} <span className="muted">{z.classes.length} zones</span></label>))}
          </div>
        </details>
      </div>
      <div className="small muted">{SECTIONS.find(([s]) => s === section)?.[2]}. Each case comes from the newest finished CFD zoner run that includes it.</div>
      {!sel.length ? <div className="muted">No case selected.</div>
        : section === "maps" ? <ZoneMaps project={project} shown={shown} style={style} view={view} setView={setView} colorMode={colorMode} setColorMode={setColorMode} unit={unit} />
        : section === "bars" ? <ZoneBars shown={shown} style={style} variable={variable} unit={unit} />
        : section === "cdf" ? <ExposureCdf project={project} shown={shown} style={style} variable={variable} />
        : section === "diag" ? <Diagnostics project={project} shown={shown} style={style} variable={variable} unit={unit} />
        : <ZoneTables shown={shown} refZ={refZ} refName={refZ ? caseName(project, refZ.caseId) : ""} variable={variable} />}
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

type MapFig = { data: Plotly.Data[]; layout: Partial<Plotly.Layout>; height: number;
                chips: { title: string; items: { color: string; label: string }[] }[] };

function ZoneMaps({ project, shown: { sel, names }, style, view, setView, colorMode, setColorMode, unit }: {
  project: Project; shown: Shown; style: PlotStyle; view: string; setView: (v: string) => void;
  colorMode: ColorMode; setColorMode: (m: ColorMode) => void; unit: string;
}) {
  // the views every case offers (zone_slices.csv, small) and the cross-sections of the shown view only
  const [metas, setMetas] = useState<Map<string, ZoneSliceMeta[]> | null>(null);
  const [slices, setSlices] = useState<{ view: string; of: Map<string, ZoneSlice | null> } | null>(null);
  // undefined = not built yet, null = no cross-section of this view
  const [fig, setFig] = useState<MapFig | null | undefined>(undefined);
  useEffect(() => {
    let stale = false;
    setMetas(null);
    Promise.all(sel.map((z) => loadZoneSliceMetas(project, z).then((m) => [zKey(z), m] as const)))
      .then((m) => !stale && setMetas(new Map(m)));
    return () => { stale = true; };
  }, [project.id, sel]); // eslint-disable-line react-hooks/exhaustive-deps

  const views = useMemo(() => {
    const m = new Map<string, string>();
    for (const ss of metas?.values() ?? []) for (const s of ss) if (!m.has(s.view)) m.set(s.view, s.title);
    return [...m.entries()];
  }, [metas]);
  useEffect(() => { if (views.length && !views.some(([v]) => v === view)) setView(views[0][0]); }, [views, view, setView]);
  const viewOk = views.some(([v]) => v === view);
  useEffect(() => {
    if (!metas || !hasAll(metas, sel) || !viewOk) return;
    let stale = false;
    Promise.all(sel.map((z) => loadZoneSlice(project, z, view).then((s) => [zKey(z), s] as const)))
      .then((s) => !stale && setSlices({ view, of: new Map(s) }));
    return () => { stale = true; };
  }, [project.id, metas, view, viewOk]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // slices of an earlier case list or view (they are reloaded when those change): wait for the matching ones
    if (!slices || slices.view !== view || !hasAll(slices.of, sel)) return;
    let stale = false;
    (async () => {
      const items = sel.map((z) => ({ z, s: slices.of.get(zKey(z)) })).filter((x): x is { z: ZoneCase; s: ZoneSlice } => !!x.s);
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
        // value and hover text once per class: the cells only look them up
        const val = new Map(z.classes.map((c) => [c.id, value(c.id)]));
        const lab = new Map(z.classes.map((c) => [c.id, `${shortZone(c.label)}: mean ${fmtG(c.mean)} ${unit}`]));
        for (let r = 0; r < s.nv; r++) {
          const row: (number | null)[] = new Array(s.nu), hrow: string[] = new Array(s.nu);
          for (let k = 0; k < s.nu; k++) {
            const id = s.cls[r * s.nu + k];
            row[k] = id >= 1 ? val.get(id) ?? null : null;
            hrow[k] = id >= 1 ? lab.get(id) ?? `zone ${id}` : "";
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
          hovertemplate: `${names.get(z.caseId) ?? z.caseId}<br>${s.uLabel.split(" ")[0]} = %{x:.4f} m, ${s.vLabel.split(" ")[0]} = %{y:.4f} m<br>%{text}<extra></extra>`,
          colorbar: colorMode === "pct" ? { title: { text: "zone mean [% of case mean]" }, len: 0.8, thickness: 14 }
            : { title: { text: `zone mean [${unit}]` }, len: 0.8, thickness: 14,
                ...(logScale && (() => { const [tv, tt] = logTicks(vmin, vmax); return { tickvals: tv, ticktext: tt }; })()) },
        } as unknown as Plotly.Data);
        const [u0, u1, v0, v1] = limits[i];
        // every panel anchors its own pair of axes: without it Plotly draws the ticks of all y axes at
        // the first x axis and the x labels of the lower rows under the first row
        layout[`xaxis${ax}`] = { domain: xd, anchor: `y${ax}`, range: [u0, u1], title: { text: s.uLabel }, constrain: "domain", zeroline: false, showgrid: false };
        layout[`yaxis${ax}`] = { domain: yd, anchor: `x${ax}`, range: [v0, v1], title: { text: s.vLabel }, scaleanchor: `x${ax}`, scaleratio: 1,
                                 constrain: "domain", zeroline: false, showgrid: false };
        (layout.annotations as unknown[]).push({ text: `<b>${names.get(z.caseId) ?? z.caseId}</b>`, xref: `x${ax} domain`, yref: `y${ax} domain`,
          x: 0.5, y: 1, yshift: 6, xanchor: "center", yanchor: "bottom", showarrow: false, font: { size: style.fontSize } });
        if (colorMode === "ranks") chips.push({ title: names.get(z.caseId) ?? z.caseId,
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
  }, [slices, view, colorMode, unit, style.fontSize, style.heightScale, names]); // eslint-disable-line react-hooks/exhaustive-deps
  const loading = !metas || (views.length > 0 && (!viewOk || !slices || slices.view !== view || !hasAll(slices.of, sel) || fig === undefined));

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
      {loading ? <div className="muted">Loading zone slices...</div>
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

function ZoneBars({ shown: { sel, names, colors }, style, variable, unit }: { shown: Shown; style: PlotStyle; variable: string; unit: string }) {
  const counts = new Set(sel.map((z) => z.classes.length));
  const nm = (z: ZoneCase) => names.get(z.caseId) ?? z.caseId;
  // figures built once per set of shown cases, names and style
  const figs = useMemo(() => {
    const ids = [...new Set(sel.flatMap((z) => z.classes.map((c) => c.id)))].sort((a, b) => a - b);
    const first = new Map<number, string>();
    for (const z of sel) for (const c of z.classes) if (!first.has(c.id)) first.set(c.id, c.label);
    const labels = ids.map((id) => shortZone(first.get(id) ?? `class ${id}`));
    const grouped = (metric: (c: { mean: number; volFrac: number }, z: ZoneCase) => number): Plotly.Data[] =>
      sel.map((z) => {
        const byId = new Map(z.classes.map((c) => [c.id, c]));
        return {
          type: "bar", name: nm(z), x: labels, marker: { color: colors.get(z.caseId) },
          y: ids.map((id) => { const c = byId.get(id); return c ? metric(c, z) : null; }),
          hovertemplate: `${nm(z)}<br>%{x}: %{y:.4g}<extra></extra>`,
        } as Plotly.Data;
      });
    const perCase = (y: (z: ZoneCase) => number | null): Plotly.Data[] => [{
      type: "bar", x: sel.map(nm), y: sel.map(y), showlegend: false,
      marker: { color: sel.map((z) => (style.barsByCase ? colors.get(z.caseId) : style.barColor)) },
      hovertemplate: "%{x}: %{y:.4g}<extra></extra>",
    } as Plotly.Data];
    // a log axis only when every zone mean is positive (signed or zero means would not be drawn), like the zone maps
    const logY = sel.every((z) => z.classes.every((c) => c.mean > 0));
    const bars: [string, Plotly.Data[], Partial<Plotly.Layout>][] = [
      ["zone_means", grouped((c) => c.mean), { title: { text: `Zone means of ${variable} (per-case zoning, rank-aligned)` }, barmode: "group",
        yaxis: { type: logY ? "log" : "linear", title: { text: `zone mean [${unit}]` } } }],
      ["zone_ratios", grouped((c, z) => c.mean / z.globalMean), { title: { text: `Local vs global ${variable} (1 = case average)` }, barmode: "group",
        yaxis: { title: { text: "zone mean / case global mean" } },
        shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 1, y1: 1, line: { dash: "dash", width: 1 } }] }],
      ["zone_volfrac", grouped((c) => 100 * c.volFrac), { title: { text: "Zone volume fractions" }, barmode: "group", yaxis: { title: { text: "volume fraction [%]" } } }],
      ["global_means", perCase((z) => z.globalMean), { title: { text: `Global fluid mean of ${variable}` }, yaxis: { title: { text: `[${unit}]` } } }],
    ];
    const het = HET.map(([k, title]) => [k, perCase((z) => (Number.isFinite(z.het[k]) ? z.het[k] : null)),
      { title: { text: title }, yaxis: { title: { text: k } } }] as [string, Plotly.Data[], Partial<Plotly.Layout>]);
    return { bars, het };
  }, [sel, names, colors, style.barsByCase, style.barColor, variable, unit]); // eslint-disable-line react-hooks/exhaustive-deps
  const h = Math.round(360 * style.heightScale);
  return (
    <>
      {counts.size > 1 && <div className="small muted">Zone counts differ between the cases ({[...counts].join(", ")}): classes are aligned by rank where present.</div>}
      {figs.bars.map(([name, data, layout]) => <Plot key={name} data={data} layout={layout} height={h} exportName={name} style={style} />)}
      <div className="plot-grid2">
        {figs.het.map(([k, data, layout]) => (
          <Plot key={k} data={data} layout={layout} height={Math.round(300 * style.heightScale)} exportName={`heterogeneity_${k}`} style={style} />))}
      </div>
      <div className="small muted">Significant local-vs-global gradients (eta2 and contrast above the run's thresholds):{" "}
        {sel.map((z, i) => <span key={z.caseId}>{i ? ", " : ""}{nm(z)}: <b>{z.het.significant_gradients ? "yes" : "no"}</b></span>)}</div>
    </>
  );
}

// ------------------------------------------------------------------ exposure CDF

// One CSV of every shown case, keyed by zKey; null until the tables of all shown cases are there
// (also during the render in which the case list changed and the state still holds the old tables).
function useCaseCsv(project: Project, sel: ZoneCase[], file: string): Map<string, CsvTable | null> | null {
  const [tables, setTables] = useState<Map<string, CsvTable | null> | null>(null);
  const key = sel.map(zKey).join(",");
  useEffect(() => {
    let stale = false;
    setTables(null);
    Promise.all(sel.map((z) => api.csv(project.id, `${z.run.path}/${z.dir}/${file}`).catch(() => null).then((t) => [zKey(z), t] as const)))
      .then((t) => !stale && setTables(new Map(t)));
    return () => { stale = true; };
  }, [project.id, key, file]); // eslint-disable-line react-hooks/exhaustive-deps
  return hasAll(tables, sel) ? tables : null;
}

function ExposureCdf({ project, shown: { sel, names, colors }, style, variable }: { project: Project; shown: Shown; style: PlotStyle; variable: string }) {
  const tables = useCaseCsv(project, sel, "exposure_cdf.csv");
  const fig = useMemo(() => {
    if (!tables) return null;
    const data: Plotly.Data[] = [];
    let anyPos = false;
    sel.forEach((z) => {
      const t = tables.get(zKey(z));
      if (!t) return;
      const name = names.get(z.caseId) ?? z.caseId, color = colors.get(z.caseId);
      const x = t.rows.map((r) => r[0] as number), y = t.rows.map((r) => 100 * (r[1] as number));
      anyPos ||= x.some((v) => v > 0);
      data.push({ type: "scatter", mode: "lines", x, y, name, legendgroup: name, line: { color, width: style.lineWidth + 0.7 } });
      data.push({ type: "scatter", mode: "lines", x: [z.globalMean, z.globalMean], y: [0, 100], legendgroup: name, showlegend: false,
                  name: `${name} global mean (${fmtG(z.globalMean)})`, line: { color, dash: "dash", width: 1 }, hovertemplate: `${name} global mean %{x:.4g}<extra></extra>` });
    });
    const layout: Partial<Plotly.Layout> = { title: { text: "Volume exposure by case (dashed: case global means)" },
      xaxis: { title: { text: variable }, type: anyPos ? "log" : "linear" },
      yaxis: { title: { text: "cumulative fluid volume [%]" }, range: [0, 100] } };
    return { data, layout };
  }, [tables, sel, names, colors, style.lineWidth, variable]);
  if (!fig) return <div className="muted">Loading exposure curves...</div>;
  return <Plot data={fig.data} layout={fig.layout} height={Math.round(520 * style.heightScale)} exportName="exposure_cdf" style={style} />;
}

// ------------------------------------------------------------------ diagnostics

function Diagnostics({ project, shown: { sel, names, colors }, style, variable, unit }: { project: Project; shown: Shown; style: PlotStyle; variable: string; unit: string }) {
  const hist = useCaseCsv(project, sel, "histogram.csv");
  const prof = useCaseCsv(project, sel, "profiles.csv");
  // zone colors per case: zKey -> class id -> color
  const [zcol, setZcol] = useState<Map<string, Map<number, string>> | null>(null);
  useEffect(() => {
    let stale = false;
    Promise.all(sel.map((z) => zoneColors(new Map(z.classes.map((c) => [c.id, c.mean]))).then((m) => [zKey(z), m] as const)))
      .then((m) => !stale && setZcol(new Map(m)));
    return () => { stale = true; };
  }, [sel]);
  const nm = (z: ZoneCase) => names.get(z.caseId) ?? z.caseId;
  const cc = (z: ZoneCase) => colors.get(z.caseId);

  // histograms: one panel per case, stepped outline with class boundaries (dashed) and zone means (dotted)
  const histFig = useMemo(() => {
    if (!hist || !zcol || !hasAll(zcol, sel)) return null;
    const grid = panelGrid(sel.length, 0.07, 0.2);
    const data: Plotly.Data[] = [];
    const layout: Record<string, unknown> = { annotations: [] as unknown[], showlegend: false };
    sel.forEach((z, i) => {
      const t = hist.get(zKey(z));
      const { xd, yd, ax } = grid.cell(i);
      let ymax = 1;
      if (t) {
        const lo = t.rows.map((r) => r[0] as number), hi = t.rows.map((r) => r[1] as number), n = t.rows.map((r) => 100 * (r[3] as number));
        ymax = Math.max(...n, 1e-9);
        data.push({ type: "scatter", mode: "lines", line: { shape: "hv", color: cc(z), width: style.lineWidth }, fill: "tozeroy",
                    x: [...lo, hi[hi.length - 1]], y: [...n, 0], xaxis: `x${ax}`, yaxis: `y${ax}`, name: nm(z),
                    hovertemplate: "%{x:.4g}: %{y:.3g} %<extra></extra>" } as Plotly.Data);
      }
      for (const c of z.classes) {
        if (c.upper !== null && Number.isFinite(c.upper))
          data.push({ type: "scatter", mode: "lines", x: [c.upper, c.upper], y: [0, ymax], xaxis: `x${ax}`, yaxis: `y${ax}`,
                      line: { color: "#888", dash: "dash", width: 1 }, hovertemplate: `boundary %{x:.4g}<extra></extra>` } as Plotly.Data);
        data.push({ type: "scatter", mode: "lines", x: [c.mean, c.mean], y: [0, ymax], xaxis: `x${ax}`, yaxis: `y${ax}`,
                    line: { color: zcol.get(zKey(z))?.get(c.id), dash: "dot", width: 1.5 }, hovertemplate: `${shortZone(c.label)} mean %{x:.4g}<extra></extra>` } as Plotly.Data);
      }
      // each panel anchors its own axes (else all y ticks land on the first panel and the x labels of lower rows under the first row)
      layout[`xaxis${ax}`] = { domain: xd, anchor: `y${ax}`, type: "log", title: { text: `${variable}` } };
      layout[`yaxis${ax}`] = { domain: yd, anchor: `x${ax}`, title: { text: "fluid volume [%]" } };
      (layout.annotations as unknown[]).push({ text: `<b>${nm(z)}</b>`, xref: `x${ax} domain`, yref: `y${ax} domain`, x: 0.5, y: 1, yshift: 4,
        xanchor: "center", yanchor: "bottom", showarrow: false, font: { size: style.fontSize } });
    });
    layout.title = { text: `Distribution of ${variable} with class boundaries (dashed) and zone means (dotted)` };
    return { data, layout: layout as Partial<Plotly.Layout>, height: Math.round(grid.nrows * 300 * style.heightScale + 60) };
  }, [hist, zcol, sel, names, colors, style.lineWidth, style.fontSize, style.heightScale, variable]); // eslint-disable-line react-hooks/exhaustive-deps

  // zone weights: volume fraction (solid) vs contribution to the case mean (hatched), grouped by case
  const weights = useMemo(() => {
    const ids = [...new Set(sel.flatMap((z) => z.classes.map((c) => c.id)))].sort((a, b) => a - b);
    const first = new Map<number, string>();
    for (const z of sel) for (const c of z.classes) if (!first.has(c.id)) first.set(c.id, c.label);
    const labels = ids.map((id) => shortZone(first.get(id) ?? `class ${id}`));
    const data = sel.flatMap((z) => {
      const byId = new Map(z.classes.map((c) => [c.id, c]));
      return [
        { type: "bar", name: `${nm(z)} volume`, legendgroup: nm(z), x: labels, marker: { color: cc(z) },
          y: ids.map((id) => { const c = byId.get(id); return c ? 100 * c.volFrac : null; }),
          hovertemplate: `${nm(z)}<br>%{x}: %{y:.1f} % of the volume<extra></extra>` },
        { type: "bar", name: `${nm(z)} contribution`, legendgroup: nm(z), x: labels,
          marker: { color: cc(z), pattern: { shape: "/", fgcolor: "#ffffff", fgopacity: 0.6 } },
          y: ids.map((id) => { const c = byId.get(id); return c?.contribution !== null && c?.contribution !== undefined ? 100 * c.contribution : null; }),
          hovertemplate: `${nm(z)}<br>%{x}: %{y:.1f} % of the mean<extra></extra>` },
      ] as Plotly.Data[];
    });
    const layout: Partial<Plotly.Layout> = { title: { text: "Zone volume fractions (solid) and contributions to the case mean (hatched)" }, barmode: "group",
      yaxis: { title: { text: "percent [%]" } } };
    return { data, layout };
  }, [sel, names, colors]); // eslint-disable-line react-hooks/exhaustive-deps

  // axial and radial profiles overlaid across cases
  const profFig = useMemo(() => {
    if (!prof) return null;
    const data: Plotly.Data[] = [];
    let anyPos = false;
    const xl: string[] = ["", ""];
    sel.forEach((z) => {
      const t = prof.get(zKey(z));
      if (!t) return;
      const kinds = [...new Set(t.rows.map((r) => String(r[0])))];
      kinds.slice(0, 2).forEach((k, j) => {
        const rows = t.rows.filter((r) => r[0] === k && typeof r[2] === "number");
        const y = rows.map((r) => r[2] as number);
        anyPos ||= y.some((v) => v > 0);
        xl[j] = k.startsWith("axial") ? `${k.replace("axial ", "").replace(/[()]/g, "")} [m] (along the shaft axis)` : "radius from the tank axis [m]";
        data.push({ type: "scatter", mode: "lines", x: rows.map((r) => r[1] as number), y, name: nm(z), legendgroup: nm(z), showlegend: j === 0,
                    line: { color: cc(z), width: style.lineWidth + 0.5 }, xaxis: j ? "x2" : "x", yaxis: j ? "y2" : "y",
                    hovertemplate: `${nm(z)}<br>%{x:.4f} m: %{y:.4g}<extra></extra>` } as Plotly.Data);
        data.push({ type: "scatter", mode: "lines", x: [Math.min(...rows.map((r) => r[1] as number)), Math.max(...rows.map((r) => r[1] as number))],
                    y: [z.globalMean, z.globalMean], legendgroup: nm(z), showlegend: false, name: `${nm(z)} global mean`,
                    line: { color: cc(z), dash: "dash", width: 1 }, xaxis: j ? "x2" : "x", yaxis: j ? "y2" : "y", hoverinfo: "skip" } as Plotly.Data);
      });
    });
    return { data, layout: {
      title: { text: `Volume-averaged profiles of ${variable} (dashed: case global means)` },
      xaxis: { domain: [0, 0.46], anchor: "y", title: { text: xl[0] } }, yaxis: { anchor: "x", title: { text: `[${unit}]` }, type: anyPos ? "log" : "linear" },
      xaxis2: { domain: [0.54, 1], anchor: "y2", title: { text: xl[1] } }, yaxis2: { anchor: "x2", title: { text: `[${unit}]` }, type: anyPos ? "log" : "linear" },
    } as Partial<Plotly.Layout> };
  }, [prof, sel, names, colors, style.lineWidth, variable, unit]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {histFig ? <Plot data={histFig.data} layout={histFig.layout} height={histFig.height} exportName="zone_histograms" style={style} />
        : <div className="muted">Loading histograms...</div>}
      <Plot data={weights.data} layout={weights.layout} height={Math.round(380 * style.heightScale)} exportName="zone_weights" style={style} />
      {profFig ? <Plot data={profFig.data} layout={profFig.layout} height={Math.round(400 * style.heightScale)} exportName="zone_profiles" style={style} />
        : <div className="muted">Loading profiles...</div>}
      <div className="small muted">The steady-state detection trace of each case (time_trace.csv) is available under Plots &gt; Case time series and Time series (source "App script outputs").</div>
    </>
  );
}

// ------------------------------------------------------------------ tables

function ZoneTables({ shown: { sel, names: nameOf }, refZ, refName, variable }: { shown: Shown; refZ: ZoneCase | null; refName: string; variable: string }) {
  const names = sel.map((z) => nameOf.get(z.caseId) ?? z.caseId);
  const cmpCols = ["case", "zone", "class", "cells [count]", "volume [m^3]", "volume fraction [m^3/m^3]", `mean ${variable}`, "std", "min", "max",
                   "case global mean", "mean / global mean", "run"];
  const cmpRows = sel.flatMap((z, i) => z.classes.map((c) => [names[i], shortZone(c.label), c.id, c.cells, c.volume, c.volFrac, c.mean, c.std, c.min, c.max,
                                                            z.globalMean, c.mean / z.globalMean, z.run.label ?? z.run.name]));
  const hetKeys = [...new Set(sel.flatMap((z) => Object.keys(z.het)))];
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
        {refZ && <span className="muted" title={PCT_HELP}>% vs {refName}</span>}
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
