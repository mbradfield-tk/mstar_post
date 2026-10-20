import { useEffect, useRef, useState } from "react";
import { fmt } from "./api";
import { cmapLut, colorize } from "./cmap";
import type { Plane } from "./plane";

const AX = "xyz";

// 2D plane on a canvas, colormapped client-side; hover readout, colorbar and
// optional two-click line selection (world coordinates).
export default function SliceCanvas({ plane, cmap, range, log, title, onLine, lineMode }: {
  plane: Plane | null;
  cmap: string;
  range: [number, number];
  log: boolean;
  title?: string;
  lineMode?: boolean;
  onLine?: (p0: number[], p1: number[]) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bar = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<string>("");
  const [pick, setPick] = useState<number[] | null>(null);
  const [line, setLine] = useState<[number[], number[]] | null>(null);

  useEffect(() => { setPick(null); if (!lineMode) setLine(null); }, [lineMode]);

  useEffect(() => {
    let live = true;
    if (!plane || !ref.current) return;
    cmapLut(cmap).then((lut) => {
      if (!live || !ref.current) return;
      const cv = ref.current;
      cv.width = plane.w;
      cv.height = plane.h;
      const ctx = cv.getContext("2d")!;
      const px = colorize(plane.data, plane.w, plane.h, lut, range[0], range[1], log);
      ctx.putImageData(new ImageData(px, plane.w, plane.h), 0, 0);
      if (line) {
        const [a, b] = line.map((p) => toPix(plane, p));
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = Math.max(1, plane.w / 300);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      if (bar.current) {
        const b = bar.current;
        b.width = 256;
        b.height = 1;
        const strip = new ImageData(256, 1);
        strip.data.set(lut);
        b.getContext("2d")!.putImageData(strip, 0, 0);
      }
    });
    return () => { live = false; };
  }, [plane, cmap, range, log, line]);

  if (!plane) return <div className="slice empty muted">{title ?? "no data"}</div>;

  const world = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const c = Math.floor((e.clientX - r.left) / r.width * plane.w);
    const rr = plane.h - 1 - Math.floor((e.clientY - r.top) / r.height * plane.h);
    const p = [0, 0, 0];
    p[plane.axis] = plane.pos;
    p[plane.uAxis] = plane.u0 + c * plane.du;
    p[plane.vAxis] = plane.v0 + rr * plane.dv;
    return { c, rr, p };
  };

  return (
    <div className="slice">
      {title && <div className="slice-title">{title}</div>}
      <canvas ref={ref} className={`slice-canvas${lineMode ? " crosshair" : ""}`}
              style={{ aspectRatio: `${plane.w * plane.du} / ${plane.h * plane.dv}` }}
              onMouseMove={(e) => {
                const { c, rr, p } = world(e);
                if (c < 0 || rr < 0 || c >= plane.w || rr >= plane.h) return;
                const v = plane.data[rr * plane.w + c];
                setHover(`${AX[plane.uAxis]}=${fmt(p[plane.uAxis])} ${AX[plane.vAxis]}=${fmt(p[plane.vAxis])} m : ${Number.isFinite(v) ? fmt(v) : "solid"} ${plane.unit}`);
              }}
              onClick={(e) => {
                if (!lineMode) return;
                const { p } = world(e);
                if (!pick) { setPick(p); setLine(null); return; }
                setLine([pick, p]);
                setPick(null);
                onLine?.(pick, p);
              }} />
      <div className="colorbar">
        <span>{fmt(range[0])}</span>
        <canvas ref={bar} />
        <span>{fmt(range[1])} {plane.unit}{log ? " (log)" : ""}</span>
      </div>
      <div className="muted small mono">
        {AX[plane.axis]} = {fmt(plane.pos)} m (index {plane.index}/{plane.count})
        {plane.time !== null && <> | t = {fmt(plane.time)} s</>}
        {" | "}{hover || "hover for values"}
        {lineMode && <> | {pick ? "click the end point" : "click the start point"}</>}
      </div>
    </div>
  );
}

function toPix(plane: Plane, p: number[]): [number, number] {
  return [(p[plane.uAxis] - plane.u0) / plane.du + 0.5,
          plane.h - 1 - (p[plane.vAxis] - plane.v0) / plane.dv + 0.5];
}
