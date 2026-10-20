import Plotly from "plotly.js-dist-min";
import { useEffect, useRef } from "react";

// Thin wrapper over Plotly.react; the mode bar provides PNG export, and
// exportName sets the downloaded file name.
export default function Plot({ data, layout, height = 420, exportName = "plot" }: {
  data: Plotly.Data[];
  layout?: Partial<Plotly.Layout>;
  height?: number;
  exportName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    Plotly.react(el, data, {
      template: "plotly_white" as unknown as Plotly.Template,
      margin: { t: 40, r: 20, b: 50, l: 70 },
      height, autosize: true, ...layout,
    }, {
      responsive: true, displaylogo: false,
      toImageButtonOptions: { filename: exportName, format: "png", scale: 2 },
      modeBarButtonsToAdd: [{
        name: "Download SVG",
        title: "Download plot as SVG",
        icon: Plotly.Icons.camera,
        click: (gd: Plotly.PlotlyHTMLElement) =>
          Plotly.downloadImage(gd, { format: "svg", filename: exportName, width: 1200, height }),
      }],
    });
  }, [data, layout, height, exportName]);
  useEffect(() => {
    const el = ref.current;
    return () => { if (el) Plotly.purge(el); };
  }, []);
  return <div ref={ref} style={{ width: "100%" }} />;
}
