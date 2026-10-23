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
    const lay = themed(style ? styleLayout(style, base) : base, theme) as Partial<Plotly.Layout>;
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
