import { useEffect, useRef, useState } from "react";
import { fmt } from "./api";
import ColorLegend, { drawLegend, savePng, type LegendInfo } from "./ColorLegend";
import { cmapLut, colorize, hexRgb, shadeLic } from "./cmap";
import type { Plane } from "./plane";

const AX = "xyz";

export type Overlay = {
  lines?: Float32Array[] | null;   // streamlines in grid coordinates (see flow.ts)
  lic?: Float32Array | null;
  licScale: number;
  licMode: "field" | "grey";
  lineColor: string;
};

// 2D plane on a canvas, colormapped client-side and fitted into a box of the
// given height; legend inside the box, optional LIC shading and streamlines,
// wheel zoom at the cursor and drag to pan, hover readout, two-click line
// selection (world coordinates) and PNG export of the full plane.
export default function SliceCanvas({ plane, cmap, range, log, title, onLine, lineMode, height = 480,
                                      legend, overlay, exportName = "slice", background = "#f8fafc" }: {
  plane: Plane | null;
  cmap: string;
  range: [number, number];
  log: boolean;
  title?: string;
  lineMode?: boolean;
  onLine?: (p0: number[], p1: number[]) => void;
  height?: number;
  legend?: LegendInfo;
  overlay?: Overlay;
  exportName?: string;
  background?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  const [hover, setHover] = useState<string>("");
  const [pick, setPick] = useState<number[] | null>(null);
  const [line, setLine] = useState<[number[], number[]] | null>(null);
  const [zv, setZv] = useState({ s: 1, tx: 0, ty: 0 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => { setPick(null); if (!lineMode) setLine(null); }, [lineMode]);
  useEffect(() => { setZv({ s: 1, tx: 0, ty: 0 }); }, [plane?.w, plane?.h]);

  // zoom by f about point (cx, cy) in the unzoomed image's pixel frame
  const zoomAt = (cx: number, cy: number, f: number) => setZv((v) => {
    const s = Math.min(40, Math.max(0.2, v.s * f));
    if (Math.abs(s - 1) < 1e-6) return { s: 1, tx: 0, ty: 0 };
    const px = (cx - v.tx) / v.s, py = (cy - v.ty) / v.s;
    return { s, tx: cx - s * px, ty: cy - s * py };
  });
  const zoomCenter = (f: number) => {
    const b = box.current, st = stack.current;
    if (b && st) zoomAt(b.clientWidth / 2 - st.offsetLeft, b.clientHeight / 2 - st.offsetTop, f);
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    const onWheel = (e: WheelEvent) => {
      const st = stack.current;
      if (!st) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left - st.offsetLeft, e.clientY - r.top - st.offsetTop,
             e.deltaY < 0 ? 1.2 : 1 / 1.2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener("wheel", onWheel); };
  }, [!plane]); // eslint-disable-line react-hooks/exhaustive-deps

  const lic = overlay?.lic && plane && overlay.lic.length === plane.w * plane.h * overlay.licScale ** 2
    ? overlay.lic : null;
  useEffect(() => {
    let live = true;
    if (!plane || !ref.current) return;
    cmapLut(cmap).then((lut) => {
      if (!live || !ref.current) return;
      const cv = ref.current;
      const px = colorize(plane.data, plane.w, plane.h, lut, range[0], range[1], log, true, hexRgb(background));
      const s = lic ? overlay!.licScale : 1;
      cv.width = plane.w * s;
      cv.height = plane.h * s;
      const img = lic ? shadeLic(px, plane.w, plane.h, lic, s, overlay!.licMode) : px;
      cv.getContext("2d")!.putImageData(new ImageData(img, cv.width, cv.height), 0, 0);
    });
    return () => { live = false; };
  }, [plane, cmap, range, log, lic, overlay?.licMode, background]); // eslint-disable-line react-hooks/exhaustive-deps

  const aspect = plane ? (plane.w * plane.du) / (plane.h * plane.dv) : 1;
  const cw = Math.max(1, Math.min(boxW || height * aspect, height * aspect));
  const ch = cw / aspect;

  useEffect(() => {
    const cv = over.current;
    if (!plane || !cv) return;
    // redraw sharper when zoomed (canvas pixels scale with the zoom, capped)
    const dpr = (window.devicePixelRatio || 1) * Math.min(4, Math.max(1, Math.round(zv.s)));
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    drawOverlay(ctx, plane, cw, ch, overlay, line, 1 / zv.s);
  }, [plane, cw, ch, overlay?.lines, overlay?.lineColor, line, zv.s]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!plane) return <div className="slice empty muted" style={{ height }}>{title ?? "no data"}</div>;

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

  const exportPng = async () => {
    const lut = await cmapLut(cmap);
    const W = Math.max(1200, Math.round(cw)), H = Math.round(W / aspect);
    const k = W / 1200, titleH = Math.round(40 * k), legW = Math.round(170 * k);
    const out = document.createElement("canvas");
    out.width = W + legW;
    out.height = H + titleH;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = "#111";
    ctx.font = `600 ${Math.round(18 * k)}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(`${title ?? exportName}   ${AX[plane.axis]} = ${fmt(plane.pos)} m`
      + (plane.time !== null ? `   t = ${fmt(plane.time)} s` : ""), 10 * k, titleH / 2);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(ref.current!, 0, titleH, W, H);
    ctx.save();
    ctx.translate(0, titleH);
    drawOverlay(ctx, plane, W, H, overlay, line, k);
    ctx.restore();
    if (legend) drawLegend(ctx, { x: W + 16 * k, y: titleH + 10 * k, w: legW - 26 * k, h: H - 20 * k },
                           lut, range, log, legend);
    savePng(out, exportName);
  };

  return (
    <div className="slice">
      {title && <div className="slice-title">{title}</div>}
      <div className="pane-bar small">
        <button onClick={() => zoomCenter(1.5)} title="zoom in (or mouse wheel at the cursor)">+</button>
        <button onClick={() => zoomCenter(1 / 1.5)} title="zoom out (below 1:1 makes the plot smaller)">&minus;</button>
        <button onClick={() => setZv({ s: 1, tx: 0, ty: 0 })} disabled={zv.s === 1 && !zv.tx && !zv.ty}
                title="reset zoom (drag to pan when zoomed)">1:1</button>
        <button onClick={exportPng} title="PNG of the full plane with legend">PNG</button>
        <span className="pane-info muted mono" title={hover}>
          {AX[plane.axis]} = {fmt(plane.pos)} m ({plane.index}/{plane.count})
          {plane.time !== null && <> | t = {fmt(plane.time)} s</>}
          {lineMode ? <> | {pick ? "click the end point" : "click the start point"}</>
            : <> | {hover || "hover for values"}</>}
        </span>
      </div>
      <div ref={box} className="slice-box" style={{ height, background }}>
        <div ref={stack} className="slice-stack"
             style={{ width: cw, height: ch, transform: `translate(${zv.tx}px, ${zv.ty}px) scale(${zv.s})` }}
             onPointerDown={(e) => {
               if (lineMode || (zv.s === 1 && !zv.tx && !zv.ty) || e.button !== 0) return;
               drag.current = { x: e.clientX, y: e.clientY, tx: zv.tx, ty: zv.ty };
               e.currentTarget.setPointerCapture(e.pointerId);
             }}
             onPointerMove={(e) => {
               const d = drag.current;
               if (d) setZv((v) => ({ ...v, tx: d.tx + e.clientX - d.x, ty: d.ty + e.clientY - d.y }));
             }}
             onPointerUp={() => { drag.current = null; }}>
          <canvas ref={ref} className={`slice-canvas${lineMode ? " crosshair" : zv.s !== 1 ? " grab" : ""}`}
                  style={{ width: cw, height: ch }}
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
          <canvas ref={over} className="slice-overlay" style={{ width: cw, height: ch }} />
        </div>
        {legend && <ColorLegend cmap={cmap} range={range} log={log} {...legend} />}
      </div>
    </div>
  );
}

// streamlines (with arrowheads) and the probe line on a W x H display canvas
function drawOverlay(ctx: CanvasRenderingContext2D, plane: Plane, W: number, H: number,
                     overlay: Overlay | undefined, line: [number[], number[]] | null, k = 1) {
  const sx = (x: number) => (x + 0.5) / plane.w * W;
  const sy = (y: number) => (plane.h - (y + 0.5)) / plane.h * H;
  if (overlay?.lines?.length) {
    ctx.strokeStyle = ctx.fillStyle = overlay.lineColor;
    ctx.lineWidth = 1 * k;
    ctx.globalAlpha = 0.85;
    for (const pts of overlay.lines) {
      ctx.beginPath();
      ctx.moveTo(sx(pts[0]), sy(pts[1]));
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(sx(pts[i]), sy(pts[i + 1]));
      ctx.stroke();
      const m = Math.floor(pts.length / 4) * 2;
      if (m >= 2) {
        const x1 = sx(pts[m]), y1 = sy(pts[m + 1]), x0 = sx(pts[m - 2]), y0 = sy(pts[m - 1]);
        const a = Math.atan2(y1 - y0, x1 - x0), s = 5 * k;
        ctx.beginPath();
        ctx.moveTo(x1 + s * Math.cos(a), y1 + s * Math.sin(a));
        ctx.lineTo(x1 + s * Math.cos(a + 2.5), y1 + s * Math.sin(a + 2.5));
        ctx.lineTo(x1 + s * Math.cos(a - 2.5), y1 + s * Math.sin(a - 2.5));
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
  if (line) {
    const [a, b] = line.map((p) => toPix(plane, p));
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(a[0] / plane.w * W, a[1] / plane.h * H);
    ctx.lineTo(b[0] / plane.w * W, b[1] / plane.h * H);
    ctx.stroke();
  }
}

function toPix(plane: Plane, p: number[]): [number, number] {
  return [(p[plane.uAxis] - plane.u0) / plane.du + 0.5,
          plane.h - 1 - (p[plane.vAxis] - plane.v0) / plane.dv + 0.5];
}
