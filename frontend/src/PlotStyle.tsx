import { useEffect, useState } from "react";
import type { Project } from "./api";
import { caseName } from "./api";

export const PALETTES: Record<string, string[]> = {
  "Plotly": ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
             "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"],
  "Okabe-Ito (colorblind)": ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2",
                             "#D55E00", "#CC79A7", "#000000"],
  "Tableau 10": ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
                 "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"],
  "Dark2": ["#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e", "#e6ab02", "#a6761d", "#666666"],
  "Greys": ["#000000", "#555555", "#888888", "#bbbbbb"],
};
const FONTS = ["Open Sans, sans-serif", "Arial, sans-serif", "Helvetica, sans-serif",
               "Times New Roman, serif", "Courier New, monospace"];

export type PlotStyle = {
  font: string; fontSize: number; titleSize: number; tickSize: number;
  xTickAngle: "auto" | number; yTickAngle: "auto" | number;
  legend: "top" | "right" | "bottom" | "hidden"; grid: boolean;
  palette: string; caseColors: Record<string, string>; barsByCase: boolean;
  barColor: string; pctColor: string; lineWidth: number; markerSize: number;
  heightScale: number; exportScale: number;
};
export const DEFAULT_STYLE: PlotStyle = {
  font: FONTS[0], fontSize: 12, titleSize: 13, tickSize: 11, xTickAngle: "auto", yTickAngle: "auto",
  legend: "top", grid: true, palette: "Plotly", caseColors: {}, barsByCase: false,
  barColor: "#4682b4", pctColor: "#cd5c5c", lineWidth: 1.3, markerSize: 10,
  heightScale: 1, exportScale: 2,
};

export function usePlotStyle(pid: string): [PlotStyle, (s: PlotStyle) => void] {
  const key = `mstar_post.plotstyle.${pid}`;
  const load = () => {
    try { return { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem(key) ?? "{}") }; } catch { return DEFAULT_STYLE; }
  };
  const [style, setStyle] = useState<PlotStyle>(load);
  useEffect(() => setStyle(load()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => localStorage.setItem(key, JSON.stringify(style)), [key, style]);
  return [style, setStyle];
}

// Color of the i-th case: user override, else the palette entry.
export const caseColor = (s: PlotStyle, id: string, i: number) => {
  const pal = PALETTES[s.palette] ?? PALETTES.Plotly;
  return s.caseColors[id] || pal[Math.max(0, i) % pal.length];
};

// Layout overrides from the style; axis keys get fonts, grid and tick angles merged in.
export function styleLayout(s: PlotStyle, layout: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...layout, font: { family: s.font, size: s.fontSize } };
  const keys = Object.keys(layout).filter((k) => /^[xy]axis\d*$/.test(k));
  for (const k of new Set([...keys, "xaxis", "yaxis"])) {
    const ax = (layout[k] ?? {}) as Record<string, unknown>;
    const title = ax.title as { text?: string; font?: object } | undefined;
    const angle = k.startsWith("x") ? s.xTickAngle : s.yTickAngle;
    out[k] = {
      ...ax, automargin: true, showgrid: s.grid, tickfont: { size: s.tickSize },
      ...(angle !== "auto" && { tickangle: angle }),
      ...(title && { title: { ...title, font: { ...(title.font ?? {}), size: s.fontSize } } }),
    };
  }
  // title at the top of the figure, a top legend between it and the plot area
  const t = layout.title as { text?: string; font?: object } | undefined;
  const titleH = t?.text ? Math.round(s.titleSize * 1.5) + 8 : 0;
  const legendH = s.legend === "top" ? Math.round(s.fontSize * 1.6) + 12 : 10;
  if (t) out.title = { ...t, font: { ...(t.font ?? {}), size: s.titleSize },
                       yref: "container", y: 1, yanchor: "top", pad: { t: 8 } };
  const margin = (layout.margin ?? {}) as Record<string, unknown>;
  out.margin = { ...margin, t: Math.max(titleH + legendH, 20) };
  out.showlegend = s.legend !== "hidden";
  const base = (layout.legend ?? {}) as Record<string, unknown>;
  if (s.legend === "right") out.legend = { ...base, orientation: "v", x: 1.02, y: 1, xanchor: "left", yanchor: "top" };
  else if (s.legend === "bottom") out.legend = { ...base, orientation: "h", x: 0, y: -0.2, yanchor: "top" };
  else out.legend = { ...base, orientation: "h", x: 0, y: 1.02, xanchor: "left", yanchor: "bottom" };
  return out;
}

const ANGLES = ["auto", 0, -30, -45, -60, -90] as const;

export function PlotStyleEditor({ style, setStyle, project, caseIds }: {
  style: PlotStyle; setStyle: (s: PlotStyle) => void; project: Project; caseIds: string[];
}) {
  const set = (p: Partial<PlotStyle>) => setStyle({ ...style, ...p });
  const num = (k: keyof PlotStyle, label: string, min: number, max: number, step = 1) => (
    <label>{label} <input type="number" className="short" min={min} max={max} step={step}
      value={style[k] as number} onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v >= min && v <= max) set({ [k]: v } as Partial<PlotStyle>);
      }} /></label>
  );
  const angle = (k: "xTickAngle" | "yTickAngle", label: string) => (
    <label>{label} <select value={String(style[k])}
      onChange={(e) => set({ [k]: e.target.value === "auto" ? "auto" : Number(e.target.value) })}>
      {ANGLES.map((a) => <option key={a} value={String(a)}>{a === "auto" ? "auto" : `${a}\u00b0`}</option>)}
    </select></label>
  );
  return (
    <details className="plotstyle">
      <summary className="small">Plot style</summary>
      <div className="row small">
        <label>Font <select value={style.font} onChange={(e) => set({ font: e.target.value })}>
          {FONTS.map((f) => <option key={f} value={f}>{f.split(",")[0]}</option>)}</select></label>
        {num("fontSize", "Text size", 6, 40)}
        {num("titleSize", "Title size", 6, 40)}
        {num("tickSize", "Tick size", 6, 40)}
        {angle("xTickAngle", "x tick angle")}
        {angle("yTickAngle", "y tick angle")}
        <label>Legend <select value={style.legend} onChange={(e) => set({ legend: e.target.value as PlotStyle["legend"] })}>
          {["top", "right", "bottom", "hidden"].map((l) => <option key={l}>{l}</option>)}</select></label>
        <label><input type="checkbox" checked={style.grid} onChange={(e) => set({ grid: e.target.checked })} /> grid</label>
      </div>
      <div className="row small">
        {num("lineWidth", "Line width", 0.5, 8, 0.1)}
        {num("markerSize", "Marker size", 2, 30)}
        {num("heightScale", "Height x", 0.4, 4, 0.1)}
        {num("exportScale", "PNG scale", 1, 6)}
        <label>Bar color <input type="color" value={style.barColor} onChange={(e) => set({ barColor: e.target.value })} /></label>
        <label>% bar color <input type="color" value={style.pctColor} onChange={(e) => set({ pctColor: e.target.value })} /></label>
        <label><input type="checkbox" checked={style.barsByCase} onChange={(e) => set({ barsByCase: e.target.checked })} /> bars colored by case</label>
        <button onClick={() => setStyle(DEFAULT_STYLE)}>Reset style</button>
      </div>
      <div className="row small">
        <label>Case palette <select value={style.palette} onChange={(e) => set({ palette: e.target.value })}>
          {Object.keys(PALETTES).map((p) => <option key={p}>{p}</option>)}</select></label>
        {caseIds.map((id, i) => (
          <label key={id} title={id}><input type="color" value={caseColor(style, id, i)}
            onChange={(e) => set({ caseColors: { ...style.caseColors, [id]: e.target.value } })} /> {caseName(project, id)}</label>
        ))}
        {Object.keys(style.caseColors).length > 0 && <button onClick={() => set({ caseColors: {} })}>Palette colors</button>}
      </div>
    </details>
  );
}
