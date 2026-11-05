import { useEffect, useRef, useState } from "react";
import { fmt } from "./api";
import ColorLegend, { drawLegend, savePng, type LegendInfo } from "./ColorLegend";
import { cmapLut, colorize, hexRgb, luminance, shadeLic, upsample } from "./cmap";
import type { Plane } from "./plane";

const AX = "xyz";
const MAX_SMOOTH_PX = 4e6;  // cap on upsampled pixels per plane

export type Overlay = {
  lines?: Float32Array[] | null;   // streamlines in grid coordinates (see flow.ts)
  lic?: Float32Array | null;
  licScale: number;
  licMode: "field" | "grey";
  lineColor: string;
};

export type Tool = "none" | "line" | "region" | "point";
export type Region = { pts: number[][]; closed: boolean };

// 2D plane on a canvas, colormapped client-side and fitted into a box of the
// given height; legend inside the box, optional LIC shading and streamlines,
// wheel zoom at the cursor and drag to pan, hover readout, click tools (two-click
// line, polygon region, probe point; world coordinates) and PNG export of the full plane.
export default function SliceCanvas({ plane, cmap, range, log, title, onLine, tool = "none", height = 480,
                                      legend, overlay, exportName = "slice", background = "#f8fafc", smooth = false,
                                      region, onRegionPoint, onRegionClose, onPoint, marker }: {
  plane: Plane | null;
  cmap: string;
  range: [number, number];
  log: boolean;
  title?: string;
  tool?: Tool;
  onLine?: (p0: number[], p1: number[]) => void;
  height?: number;
  legend?: LegendInfo;
  overlay?: Overlay;
  exportName?: string;
  background?: string;
  smooth?: boolean;  // bilinear between cell centres instead of one flat block per cell
  region?: Region | null;
  onRegionPoint?: (p: number[]) => void;
  onRegionClose?: () => void;
  onPoint?: (p: number[]) => void;
  marker?: number[] | null;
}) {
  const lineMode = tool === "line";
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
    const ro = new ResizeObserver(() => el.clientWidth && setBoxW(el.clientWidth));
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
  // upsample factor: the LIC scale when LIC is shown, else enough to reach the display size (capped)
  const aspect = plane ? (plane.w * plane.du) / (plane.h * plane.dv) : 1;
  const cw = Math.max(1, Math.min(boxW || height * aspect, height * aspect));
  const ch = cw / aspect;
  const smoothScale = !plane || !smooth ? 1 : lic ? overlay!.licScale
    : Math.max(1, Math.min(4, Math.ceil(Math.max(cw / plane.w, ch / plane.h)), Math.floor(Math.sqrt(MAX_SMOOTH_PX / (plane.w * plane.h)))));
  useEffect(() => {
    let live = true;
    if (!plane || !ref.current) return;
    cmapLut(cmap).then((lut) => {
      if (!live || !ref.current) return;
      const cv = ref.current;
      const s = lic ? overlay!.licScale : smoothScale;
      if (smooth) {
        // field colours already at s x the grid; LIC then shades pixel by pixel (scale 1)
        const px = colorize(upsample(plane.data, plane.w, plane.h, s), plane.w * s, plane.h * s, lut, range[0], range[1], log, true, hexRgb(background));
        cv.width = plane.w * s;
        cv.height = plane.h * s;
        const img = lic ? shadeLic(px, plane.w * s, plane.h * s, lic, 1, overlay!.licMode) : px;
        cv.getContext("2d")!.putImageData(new ImageData(img, cv.width, cv.height), 0, 0);
        return;
      }
      const px = colorize(plane.data, plane.w, plane.h, lut, range[0], range[1], log, true, hexRgb(background));
      cv.width = plane.w * s;
      cv.height = plane.h * s;
      const img = lic ? shadeLic(px, plane.w, plane.h, lic, s, overlay!.licMode) : px;
      cv.getContext("2d")!.putImageData(new ImageData(img, cv.width, cv.height), 0, 0);
    });
    return () => { live = false; };
  }, [plane, cmap, range, log, lic, overlay?.licMode, background, smooth, smoothScale]); // eslint-disable-line react-hooks/exhaustive-deps

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
    drawOverlay(ctx, plane, cw, ch, overlay, line, 1 / zv.s, region, marker);
  }, [plane, cw, ch, overlay?.lines, overlay?.lineColor, line, zv.s, region, marker]); // eslint-disable-line react-hooks/exhaustive-deps

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
    ctx.imageSmoothingEnabled = smooth;
    ctx.drawImage(ref.current!, 0, titleH, W, H);
    ctx.save();
    ctx.translate(0, titleH);
    drawOverlay(ctx, plane, W, H, overlay, line, k, region, marker);
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
            : tool === "region" ? <> | {region?.closed ? `region: ${region.pts.length} corners (click to start a new one)` : "click corners, double-click to close"}</>
            : tool === "point" ? <> | click to set the probe point</>
            : <> | {hover || "hover for values"}</>}
        </span>
      </div>
      <div ref={box} className="slice-box" style={{ height, background }}>
        <div ref={stack} className="slice-stack"
             style={{ width: cw, height: ch, transform: `translate(${zv.tx}px, ${zv.ty}px) scale(${zv.s})` }}
             onPointerDown={(e) => {
               if (tool !== "none" || (zv.s === 1 && !zv.tx && !zv.ty) || e.button !== 0) return;
               drag.current = { x: e.clientX, y: e.clientY, tx: zv.tx, ty: zv.ty };
               e.currentTarget.setPointerCapture(e.pointerId);
             }}
             onPointerMove={(e) => {
               const d = drag.current;
               if (d) setZv((v) => ({ ...v, tx: d.tx + e.clientX - d.x, ty: d.ty + e.clientY - d.y }));
             }}
             onPointerUp={() => { drag.current = null; }}>
          <canvas ref={ref} className={`slice-canvas${smooth ? " smooth" : ""}${tool !== "none" ? " crosshair" : zv.s !== 1 ? " grab" : ""}`}
                  style={{ width: cw, height: ch }}
                  onMouseMove={(e) => {
                    const { c, rr, p } = world(e);
                    if (c < 0 || rr < 0 || c >= plane.w || rr >= plane.h) return;
                    const v = plane.data[rr * plane.w + c];
                    setHover(`${AX[plane.uAxis]}=${fmt(p[plane.uAxis])} ${AX[plane.vAxis]}=${fmt(p[plane.vAxis])} m : ${Number.isFinite(v) ? fmt(v) : "solid"} ${plane.unit}${smooth && Number.isFinite(v) ? " (smoothed)" : ""}`);
                  }}
                  onClick={(e) => {
                    if (tool === "region") { onRegionPoint?.(world(e).p); return; }
                    if (tool === "point") { onPoint?.(world(e).p); return; }
                    if (!lineMode) return;
                    const { p } = world(e);
                    if (!pick) { setPick(p); setLine(null); return; }
                    setLine([pick, p]);
                    setPick(null);
                    onLine?.(pick, p);
                  }}
                  onDoubleClick={() => { if (tool === "region") onRegionClose?.(); }} />
          <canvas ref={over} className="slice-overlay" style={{ width: cw, height: ch }} />
        </div>
        {legend && <ColorLegend cmap={cmap} range={range} log={log} dark={luminance(background) < 0.5} {...legend} />}
      </div>
    </div>
  );
}

// streamlines (with arrowheads), the probe line, the region polygon and the probe point on a W x H display canvas
function drawOverlay(ctx: CanvasRenderingContext2D, plane: Plane, W: number, H: number,
                     overlay: Overlay | undefined, line: [number[], number[]] | null, k = 1,
                     region?: Region | null, marker?: number[] | null) {
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
  const px = (p: number[]) => { const q = toPix(plane, p); return [q[0] / plane.w * W, q[1] / plane.h * H]; };
  if (region?.pts.length) {
    const pts = region.pts.map(px);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (region.closed) {
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fill();
    }
    ctx.setLineDash([6 * k, 4 * k]);
    for (const [c, w] of [["#000", 3], ["#fff", 1.5]] as const) {
      ctx.strokeStyle = c;
      ctx.lineWidth = w * k;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    for (const [x, y] of pts) ctx.fillRect(x - 2 * k, y - 2 * k, 4 * k, 4 * k);
  }
  if (marker) {
    const [x, y] = px(marker), r = 7 * k;
    for (const [c, w] of [["#000", 3.5], ["#fff", 1.5]] as const) {
      ctx.strokeStyle = c;
      ctx.lineWidth = w * k;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.moveTo(x - 1.6 * r, y); ctx.lineTo(x + 1.6 * r, y);
      ctx.moveTo(x, y - 1.6 * r); ctx.lineTo(x, y + 1.6 * r);
      ctx.stroke();
    }
  }
}

function toPix(plane: Plane, p: number[]): [number, number] {
  return [(p[plane.uAxis] - plane.u0) / plane.du + 0.5,
          plane.h - 1 - (p[plane.vAxis] - plane.v0) / plane.dv + 0.5];
}
