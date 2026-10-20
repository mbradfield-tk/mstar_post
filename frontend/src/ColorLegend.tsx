import { useEffect, useRef } from "react";
import { fmt } from "./api";
import { cmapLut, legendTicks } from "./cmap";

export type LegendInfo = { label: string; unit: string };

const lutStrip = (cv: HTMLCanvasElement, lut: Uint8ClampedArray) => {
  cv.width = 1;
  cv.height = 256;
  const img = new ImageData(1, 256);
  for (let i = 0; i < 256; i++) img.data.set(lut.subarray((255 - i) * 4, (255 - i) * 4 + 4), i * 4);
  cv.getContext("2d")!.putImageData(img, 0, 0);
};

// Compact vertical colorbar overlaid inside a 2D/3D pane (top = max).
export default function ColorLegend({ cmap, range, log, label, unit, dark = false }: LegendInfo & {
  cmap: string;
  range: [number, number];
  log: boolean;
  dark?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    cmapLut(cmap).then((lut) => { if (live && ref.current) lutStrip(ref.current, lut); });
    return () => { live = false; };
  }, [cmap]);
  return (
    <div className={`legend${dark ? " dark" : ""}`}>
      <div className="legend-title" title={label}>{label}</div>
      <div className="legend-unit">[{unit || "-"}]{log ? " log" : ""}</div>
      <div className="legend-body">
        <canvas ref={ref} />
        <div className="legend-ticks">{legendTicks(range, log).map((v, i) => <span key={i}>{fmt(v, 3)}</span>)}</div>
      </div>
    </div>
  );
}

/** Draw the colorbar with ticks, label and unit into box on a 2D context (for exports). */
export function drawLegend(ctx: CanvasRenderingContext2D, box: { x: number; y: number; w: number; h: number },
                           lut: Uint8ClampedArray, range: [number, number], log: boolean,
                           info: LegendInfo, color = "#111") {
  const fs = Math.max(11, Math.round(box.w / 8));
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  const words = info.label.split(" ");
  const rows: string[] = [];
  for (const wd of words) {
    const cur = rows[rows.length - 1];
    if (cur && ctx.measureText(`${cur} ${wd}`).width <= box.w) rows[rows.length - 1] = `${cur} ${wd}`;
    else rows.push(wd);
  }
  let y = box.y;
  for (const r of rows.slice(0, 3)) { ctx.fillText(r, box.x, y); y += fs * 1.2; }
  ctx.font = `${fs}px system-ui, sans-serif`;
  ctx.fillText(`[${info.unit || "-"}]${log ? " log" : ""}`, box.x, y);
  y += fs * 1.6;
  const barW = Math.max(12, box.w * 0.22), barH = Math.max(40, box.y + box.h - y - fs / 2);
  const strip = document.createElement("canvas");
  lutStrip(strip, lut);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(strip, box.x, y, barW, barH);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, y + 0.5, barW, barH);
  ctx.textBaseline = "middle";
  legendTicks(range, log).forEach((v, i, a) => {
    const ty = y + (barH * i) / (a.length - 1);
    ctx.fillRect(box.x + barW, ty, 4, 1);
    ctx.fillText(fmt(v, 3), box.x + barW + 7, ty);
  });
  ctx.restore();
}

export function savePng(cv: HTMLCanvasElement, name: string) {
  const a = document.createElement("a");
  a.href = cv.toDataURL("image/png");
  a.download = `${name.replace(/[^\w.-]+/g, "_")}.png`;
  a.click();
}
