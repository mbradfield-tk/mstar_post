import Plotly from "plotly.js-dist-min";
import { useEffect, useRef } from "react";
import { styleLayout, type PlotStyle } from "./PlotStyle";

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
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const lay = style ? styleLayout(style, (layout ?? {}) as Record<string, unknown>) as Partial<Plotly.Layout> : layout;
    Plotly.react(el, data, {
      template: "plotly_white" as unknown as Plotly.Template,
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
  }, [data, layout, height, exportName, style]);
  useEffect(() => {
    const el = ref.current;
    return () => { if (el) Plotly.purge(el); };
  }, []);
  return <div ref={ref} style={{ width: "100%" }} />;
}
