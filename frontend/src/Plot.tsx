import Plotly from "plotly.js-dist-min";
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
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
// y span of the scatter traces per y axis: scanned once per data array, not on every layout change
function ySpans(data: Plotly.Data[]) {
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
  return span;
}
function flatRanges(span: Record<string, [number, number]>, lay: Record<string, unknown>) {
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
// exportName sets the downloaded file name. Callers should pass data and layout that keep
// their identity while nothing changes (useMemo): the plot is only touched when a prop changes.
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
  // The SVG button reads the current name and height through a ref, so its function never changes:
  // Plotly.react compares the config and replots everything from scratch when a function in it differs.
  const live = useRef({ exportName, height });
  live.current = { exportName, height };
  const svg = useCallback((gd: Plotly.PlotlyHTMLElement) =>
    Plotly.downloadImage(gd, { format: "svg", filename: live.current.exportName, width: 1200, height: live.current.height }), []);
  const scale = style?.exportScale ?? 2;
  const config = useMemo(() => ({
    responsive: true, displaylogo: false,
    toImageButtonOptions: { filename: exportName, format: "png" as const, scale },
    modeBarButtonsToAdd: [{ name: "Download SVG", title: "Download plot as SVG", icon: Plotly.Icons.camera, click: svg }],
  }), [exportName, scale, svg]);
  const spans = useMemo(() => ySpans(data), [data]);
  const draw = () => {
    const el = ref.current;
    if (!el) return;
    const base = (layout ?? {}) as Record<string, unknown>;
    const nLegend = (data as Record<string, unknown>[]).filter((tr) => tr.showlegend !== false).length;
    const lay = themed(flatRanges(spans, style ? styleLayout(style, base, nLegend) : base), theme) as Partial<Plotly.Layout>;
    Plotly.react(el, data, { margin: { t: 40, r: 20, b: 50, l: 70 }, height, autosize: true, ...lay }, config);
  };
  const drawNow = useRef(draw);
  drawNow.current = draw;
  // A plot inside a hidden tab, mode or closed <details> (no box) is not drawn until it is shown:
  // no work while hidden, and the right size at once.
  const pending = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    pending.current = el.getClientRects().length === 0;
    if (!pending.current) draw();
  }, [data, layout, height, config, style, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // drawn in the next frame: drawing inside the observer callback resizes the box it observes
    const shown = new ResizeObserver(() => {
      if (!pending.current || !el.getClientRects().length) return;
      pending.current = false;
      requestAnimationFrame(() => {
        if (!el.isConnected) return;
        if (el.getClientRects().length) drawNow.current(); else pending.current = true;
      });
    });
    shown.observe(el);
    return () => { shown.disconnect(); Plotly.purge(el); };
  }, []);
  return <div ref={ref} style={{ width: "100%" }} />;
}
