import Plotly from "plotly.js-dist-min";
import { useContext, useEffect, useRef } from "react";
import { styleLayout, type PlotStyle } from "./PlotStyle";
import { ThemeContext } from "./theme";

const THEMES = {
  dark: { bg: "#212d44", text: "#e2e8f0", grid: "#34445e", line: "#566a8a", modebar: "#9aa8bd" },
  light: { bg: "#ffffff", text: "#1f2937", grid: "#e5e7eb", line: "#9ca3af", modebar: "#6b7280" },
};

// Background, text and axis colors of the theme merged into the layout.
function themed(lay: Record<string, unknown>, theme: keyof typeof THEMES) {
  const c = THEMES[theme];
  const out: Record<string, unknown> = {
    ...lay, paper_bgcolor: c.bg, plot_bgcolor: c.bg,
    font: { ...(lay.font as object ?? {}), color: c.text },
    legend: { bgcolor: "rgba(0,0,0,0)", ...(lay.legend as object ?? {}) },
    modebar: { bgcolor: "rgba(0,0,0,0)", color: c.modebar, activecolor: c.text },
  };
  for (const k of new Set([...Object.keys(lay).filter((x) => /^[xy]axis\d*$/.test(x)), "xaxis", "yaxis"]))
    out[k] = { gridcolor: c.grid, zerolinecolor: c.line, linecolor: c.line, ...(lay[k] as object ?? {}) };
  return out;
}

// series varying by < 0.1% of their value get a +-0.1% y range and short ticks (Plotly would zoom into the noise)
const FLAT_REL = 1e-3;
function flatRanges(data: Plotly.Data[], lay: Record<string, unknown>) {
  const span: Record<string, [number, number]> = {};
  for (const tr of data as Record<string, unknown>[]) {
    if (tr.type !== "scatter" && tr.type !== "scattergl") continue;
    const key = `yaxis${String(tr.yaxis ?? "y").slice(1)}`;
    for (const v of (tr.y as unknown[] | undefined) ?? []) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const s = span[key] ?? [v, v];
      span[key] = [Math.min(s[0], v), Math.max(s[1], v)];
    }
  }
  const out = { ...lay };
  for (const [k, [lo, hi]] of Object.entries(span)) {
    const ax = (out[k] ?? {}) as Record<string, unknown>;
    if (ax.range || ax.type === "log" || hi - lo >= FLAT_REL * Math.max(Math.abs(lo), Math.abs(hi))) continue;
    const c = (lo + hi) / 2, d = FLAT_REL * Math.abs(c) || 1;
    out[k] = { ...ax, range: [c - d, c + d], tickformat: ".6~g" };
  }
  return out;
}

// Thin wrapper over Plotly.react; the mode bar provides PNG export, and
// exportName sets the downloaded file name.
export default function Plot({ data, layout, height = 420, exportName = "plot", style }: {
  data: Plotly.Data[];
  layout?: Partial<Plotly.Layout>;
  height?: number;
  exportName?: string;
  style?: PlotStyle;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const appTheme = useContext(ThemeContext);
  const theme = !style || style.plotTheme === "app" ? appTheme : style.plotTheme;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const base = (layout ?? {}) as Record<string, unknown>;
    const lay = themed(flatRanges(data, style ? styleLayout(style, base) : base), theme) as Partial<Plotly.Layout>;
    Plotly.react(el, data, {
      margin: { t: 40, r: 20, b: 50, l: 70 },
      height, autosize: true, ...lay,
    }, {
      responsive: true, displaylogo: false,
      toImageButtonOptions: { filename: exportName, format: "png", scale: style?.exportScale ?? 2 },
      modeBarButtonsToAdd: [{
        name: "Download SVG",
        title: "Download plot as SVG",
        icon: Plotly.Icons.camera,
        click: (gd: Plotly.PlotlyHTMLElement) =>
          Plotly.downloadImage(gd, { format: "svg", filename: exportName, width: 1200, height }),
      }],
    });
  }, [data, layout, height, exportName, style, theme]);
  useEffect(() => {
    const el = ref.current;
    return () => { if (el) Plotly.purge(el); };
  }, []);
  return <div ref={ref} style={{ width: "100%" }} />;
}
