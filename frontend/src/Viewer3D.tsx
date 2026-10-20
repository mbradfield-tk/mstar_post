import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import ColorLegend, { drawLegend, savePng, type LegendInfo } from "./ColorLegend";
import { cmapLut, colorize, hexRgb, luminance, shadeLic } from "./cmap";
import type { Plane } from "./plane";
import type { Overlay } from "./SliceCanvas";

export type MeshLayer = {
  key: string;      // stable id (url changes reload the geometry)
  url: string;
  color: string;
  opacity: number;
  visible: boolean;
};

// streamlines from /api/case/streamlines; color null = by speed with cmap/range
export type LineLayer = {
  key: string;
  url: string;
  color: string | null;
  cmap: string;
  range: [number, number];
  log: boolean;
};

const NO_PLANES: Plane[] = [];
const PALETTE = ["#8aa2c8", "#c8a97f", "#93c47f", "#c47f9f", "#7fc4bb", "#a37fc4", "#c4c07f"];
export const layerColor = (i: number) => PALETTE[i % PALETTE.length];

export type CamState = { pos: number[]; target: number[]; up: number[] };

// Shares the camera between viewers without React re-renders.
export class CameraSync {
  last: CamState | null = null;
  private subs = new Set<(s: CamState, from: object) => void>();
  subscribe(f: (s: CamState, from: object) => void) {
    this.subs.add(f);
    return () => { this.subs.delete(f); };
  }
  publish(s: CamState, from: object) {
    this.last = s;
    this.subs.forEach((f) => f(s, from));
  }
}

const stlCache = new Map<string, Promise<THREE.BufferGeometry>>();
function loadStl(url: string): Promise<THREE.BufferGeometry> {
  let p = stlCache.get(url);
  if (!p) {
    p = new STLLoader().loadAsync(url).then((g) => { g.computeVertexNormals(); return g; });
    p.catch(() => stlCache.delete(url));
    stlCache.set(url, p);
    if (stlCache.size > 64) stlCache.delete(stlCache.keys().next().value!);
  }
  return p;
}

type Lines = { pts: Float32Array; speed: Float32Array; offsets: Uint32Array };
const lineCache = new Map<string, Promise<Lines>>();
function loadLines(url: string): Promise<Lines> {
  let p = lineCache.get(url);
  if (!p) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status}`);
      const buf = await r.arrayBuffer();
      const [n, m] = new Uint32Array(buf, 0, 2);
      return { pts: new Float32Array(buf, 8, n * 3), speed: new Float32Array(buf, 8 + n * 12, n),
               offsets: new Uint32Array(buf, 8 + n * 16, m + 1) };
    });
    p.catch(() => lineCache.delete(url));
    lineCache.set(url, p);
    if (lineCache.size > 16) lineCache.delete(lineCache.keys().next().value!);
  }
  return p;
}

// Textured quad of a plane in world coordinates; px is RGBA at scale s x the plane grid (rows = v up).
function planeMesh(plane: Plane, px: Uint8ClampedArray<ArrayBuffer>, s = 1): THREE.Mesh {
  const tex = new THREE.DataTexture(px, plane.w * s, plane.h * s, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  const W = plane.w * plane.du, H = plane.h * plane.dv;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H),
                           new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  // PlaneGeometry spans local x (u) and y (v); orient into world axes
  const u = new THREE.Vector3().setComponent(plane.uAxis, 1);
  const v = new THREE.Vector3().setComponent(plane.vAxis, 1);
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, u.clone().cross(v)));
  const c = [0, 0, 0];
  c[plane.axis] = plane.pos;
  c[plane.uAxis] = plane.u0 - plane.du / 2 + W / 2;
  c[plane.vAxis] = plane.v0 - plane.dv / 2 + H / 2;
  m.position.set(c[0], c[1], c[2]);
  return m;
}

function disposeMesh(m: THREE.Mesh) {
  (m.material as THREE.MeshBasicMaterial).map?.dispose();
  (m.material as THREE.Material).dispose();
  m.geometry.dispose();
}

// XYZ orientation gizmo: unit arrows with labels, drawn in a corner with the main camera's rotation.
function makeAxes() {
  const scene = new THREE.Scene();
  const cols = ["#e53935", "#43a047", "#1e88e5"];
  "XYZ".split("").forEach((name, i) => {
    const dir = new THREE.Vector3().setComponent(i, 1);
    scene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, cols[i], 0.25, 0.12));
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const ctx = cv.getContext("2d")!;
    ctx.font = "bold 48px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = cols[i];
    ctx.fillText(name, 32, 34);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
    sp.position.copy(dir.multiplyScalar(1.35));
    sp.scale.setScalar(0.45);
    scene.add(sp);
  });
  const cam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10);
  return { scene, cam };
}

async function linesObject(l: Lines, layer: LineLayer): Promise<THREE.LineSegments> {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(l.pts, 3));
  const idx: number[] = [];
  for (let k = 0; k + 1 < l.offsets.length; k++)
    for (let i = l.offsets[k]; i + 1 < l.offsets[k + 1]; i++) idx.push(i, i + 1);
  g.setIndex(idx);
  let mat: THREE.LineBasicMaterial;
  if (layer.color) {
    mat = new THREE.LineBasicMaterial({ color: layer.color });
  } else {
    const lut = await cmapLut(layer.cmap);
    const rgba = colorize(l.speed, l.speed.length, 1, lut, layer.range[0], layer.range[1], layer.log, false);
    const col = new Float32Array(l.speed.length * 3);
    for (let i = 0; i < l.speed.length; i++) {
      col[3 * i] = rgba[4 * i] / 255; col[3 * i + 1] = rgba[4 * i + 1] / 255; col[3 * i + 2] = rgba[4 * i + 2] / 255;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    mat = new THREE.LineBasicMaterial({ vertexColors: true });
  }
  return new THREE.LineSegments(g, mat);
}

// Interactive 3D scene in metres: STL/surface layers, streamlines and one
// textured plane (optionally LIC-shaded), with an in-view legend.
export default function Viewer3D({ layers, plane, cmap, range, log, height = 560, sync, lines = [],
                                   background = "#f4f6f9", legend, overlay, exportName = "view3d",
                                   extraPlanes = NO_PLANES }: {
  layers: MeshLayer[];
  plane: Plane | null;
  cmap: string;
  range: [number, number];
  log: boolean;
  height?: number;
  sync?: CameraSync;
  lines?: LineLayer[];
  background?: string;
  legend?: LegendInfo;
  overlay?: Overlay;
  exportName?: string;
  extraPlanes?: Plane[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer;
    controls: OrbitControls; meshes: Map<string, THREE.Mesh>; plane: THREE.Mesh | null;
    lines: Map<string, THREE.LineSegments>; extra: THREE.Mesh[]; fitted: boolean; draw: () => void;
  } | null>(null);
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const me = useRef({});
  const applying = useRef(false);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0xf4f6f9);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 1e-4, 1e3);
    camera.position.set(1, 0.8, 1);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 2, 1.5);
    camera.add(sun);
    scene.add(camera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.zoomToCursor = true;
    const onDbl = (e: MouseEvent) => {
      const t = three.current;
      if (!t) return;
      const r = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1,
                                          -(e.clientY - r.top) / r.height * 2 + 1), camera);
      const objs: THREE.Object3D[] = [...t.meshes.values(), ...(t.plane ? [t.plane] : []), ...t.extra];
      const hit = ray.intersectObjects(objs, false)[0];
      if (hit) controls.target.copy(hit.point);
    };
    renderer.domElement.addEventListener("dblclick", onDbl);
    const onChange = () => {
      if (applying.current || !syncRef.current) return;
      syncRef.current.publish({ pos: camera.position.toArray(), target: controls.target.toArray(),
                                up: camera.up.toArray() }, me.current);
    };
    controls.addEventListener("change", onChange);
    const axes = makeAxes();
    renderer.autoClear = false;
    const draw = () => {
      const w = el.clientWidth, h = el.clientHeight, g = Math.min(96, Math.round(Math.min(w, h) * 0.22));
      renderer.setViewport(0, 0, w, h);
      renderer.clear();
      renderer.render(scene, camera);
      axes.cam.position.copy(camera.position).sub(controls.target).setLength(5);
      axes.cam.quaternion.copy(camera.quaternion);
      renderer.clearDepth();
      renderer.setScissorTest(true);
      renderer.setScissor(4, 4, g, g);
      renderer.setViewport(4, 4, g, g);
      renderer.render(axes.scene, axes.cam);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
    };
    three.current = { scene, camera, renderer, controls, meshes: new Map(), plane: null,
                      lines: new Map(), extra: [], fitted: false, draw };
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    let raf = 0;
    const loop = () => { controls.update(); draw(); raf = requestAnimationFrame(loop); };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.removeEventListener("change", onChange);
      renderer.domElement.removeEventListener("dblclick", onDbl);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      three.current = null;
    };
  }, []);

  useEffect(() => {
    if (!sync) return;
    const apply = (s: CamState) => {
      const t = three.current;
      if (!t) return;
      applying.current = true;
      t.camera.position.fromArray(s.pos);
      t.camera.up.fromArray(s.up);
      t.controls.target.fromArray(s.target);
      t.controls.update();
      applying.current = false;
      t.fitted = true;
    };
    if (sync.last) apply(sync.last);
    return sync.subscribe((s, from) => { if (from !== me.current) apply(s); });
  }, [sync]);

  useEffect(() => { three.current?.renderer.setClearColor(background); }, [background]);

  const [mode, setMode] = useState<"rotate" | "pan" | "box">("rotate");
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    t.controls.enabled = mode !== "box";
    t.controls.mouseButtons = mode === "pan"
      ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  }, [mode]);

  // streamline layers (rebuilt when url or coloring changes)
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const sig = (l: LineLayer) => JSON.stringify([l.key, l.url, l.color, l.cmap, l.range, l.log]);
    const want = new Map(lines.map((l) => [sig(l), l]));
    for (const [k, o] of t.lines) {
      if (!want.has(k)) {
        t.scene.remove(o);
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
        t.lines.delete(k);
      }
    }
    let live = true;
    for (const [k, l] of want) {
      if (t.lines.has(k)) continue;
      setLoading((n) => n + 1);
      loadLines(l.url).then((d) => linesObject(d, l)).then((o) => {
        const tt = three.current;
        if (!live || !tt || tt.lines.has(k)) { o.geometry.dispose(); return; }
        tt.scene.add(o);
        tt.lines.set(k, o);
      }).catch((e) => setError(`streamlines: ${e.message ?? e}`))
        .finally(() => setLoading((n) => n - 1));
    }
    return () => { live = false; };
  }, [lines]);

  // mesh layers
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const want = new Set(layers.filter((l) => l.visible).map((l) => l.key + l.url));
    for (const [k, m] of t.meshes) {
      if (!want.has(k)) {
        t.scene.remove(m);
        (m.material as THREE.Material).dispose();
        t.meshes.delete(k);
      }
    }
    for (const l of layers) {
      if (!l.visible) continue;
      const k = l.key + l.url;
      const existing = t.meshes.get(k);
      if (existing) {
        const mat = existing.material as THREE.MeshStandardMaterial;
        mat.color.set(l.color);
        mat.opacity = l.opacity;
        mat.transparent = l.opacity < 1;
        mat.depthWrite = l.opacity >= 1;
        continue;
      }
      setLoading((n) => n + 1);
      loadStl(l.url).then((g) => {
        if (!three.current || three.current.meshes.has(k)) return;
        const mat = new THREE.MeshStandardMaterial({
          color: l.color, opacity: l.opacity, transparent: l.opacity < 1,
          depthWrite: l.opacity >= 1, side: THREE.DoubleSide, metalness: 0.1, roughness: 0.7,
        });
        const m = new THREE.Mesh(g, mat);
        three.current.scene.add(m);
        three.current.meshes.set(k, m);
        // drop stale versions of this layer (e.g. previous time step)
        for (const [kk, mm] of three.current.meshes) {
          if (kk !== k && kk.startsWith(l.key) && !want.has(kk)) {
            three.current.scene.remove(mm);
            three.current.meshes.delete(kk);
          }
        }
        if (!three.current.fitted) fit();
      }).catch((e) => setError(`${l.key}: ${e.message ?? e}`))
        .finally(() => setLoading((n) => n - 1));
    }
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  // textured plane
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    if (t.plane) {
      t.scene.remove(t.plane);
      disposeMesh(t.plane);
      t.plane = null;
    }
    if (!plane) return;
    let live = true;
    const lic = overlay?.lic && overlay.lic.length === plane.w * plane.h * overlay.licScale ** 2
      ? overlay.lic : null;
    cmapLut(cmap).then((lut) => {
      if (!live || !three.current) return;
      const base = colorize(plane.data, plane.w, plane.h, lut, range[0], range[1], log, false, hexRgb(background));
      const s = lic ? overlay!.licScale : 1;
      const px = lic ? shadeLic(base, plane.w, plane.h, lic, s, overlay!.licMode, false) : base;
      const m = planeMesh(plane, px, s);
      three.current.scene.add(m);
      three.current.plane = m;
      if (!three.current.fitted) fit();
    });
    return () => { live = false; };
  }, [plane, cmap, range, log, overlay?.lic, overlay?.licMode, background]); // eslint-disable-line react-hooks/exhaustive-deps

  // additional planes (e.g. the three center planes), colored like the main plane
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    t.extra.forEach((m) => { t.scene.remove(m); disposeMesh(m); });
    t.extra = [];
    if (!extraPlanes.length) return;
    let live = true;
    cmapLut(cmap).then((lut) => {
      const tt = three.current;
      if (!live || !tt) return;
      for (const p of extraPlanes) {
        const m = planeMesh(p, colorize(p.data, p.w, p.h, lut, range[0], range[1], log, false, hexRgb(background)));
        tt.scene.add(m);
        tt.extra.push(m);
      }
      if (!tt.fitted) fit();
    });
    return () => { live = false; };
  }, [extraPlanes, cmap, range, log, background]); // eslint-disable-line react-hooks/exhaustive-deps

  function fit() {
    const t = three.current;
    if (!t) return;
    const box = new THREE.Box3();
    t.meshes.forEach((m) => box.expandByObject(m));
    if (t.plane) box.expandByObject(t.plane);
    t.extra.forEach((m) => box.expandByObject(m));
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    t.controls.target.copy(c);
    t.camera.position.copy(c).add(new THREE.Vector3(1.2, 0.8, 1.6).normalize().multiplyScalar(r * 2.6));
    t.camera.near = r / 200;
    t.camera.far = r * 50;
    t.camera.updateProjectionMatrix();
    t.fitted = true;
  }

  function view(dir: [number, number, number], up: [number, number, number] = [0, 1, 0]) {
    const t = three.current;
    if (!t) return;
    const d = t.camera.position.distanceTo(t.controls.target);
    t.camera.up.set(...up);
    t.camera.position.copy(t.controls.target).add(new THREE.Vector3(...dir).multiplyScalar(d));
  }

  function zoom(f: number) {
    const t = three.current;
    if (!t) return;
    const off = t.camera.position.clone().sub(t.controls.target).multiplyScalar(f);
    t.camera.position.copy(t.controls.target).add(off);
    keepNear();
  }

  function keepNear() {
    const t = three.current!;
    const d = t.camera.position.distanceTo(t.controls.target);
    if (t.camera.near > d / 20) {
      t.camera.near = d / 20;
      t.camera.updateProjectionMatrix();
    }
  }

  // zoom so the dragged rectangle (CSS px in the canvas) fills the view
  function zoomBox(r: { x0: number; y0: number; x1: number; y1: number }) {
    const t = three.current;
    const el = host.current;
    if (!t || !el) return;
    const W = el.clientWidth, H = el.clientHeight;
    const f = Math.max(Math.abs(r.x1 - r.x0) / W, Math.abs(r.y1 - r.y0) / H);
    if (f < 0.01) return;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((r.x0 + r.x1) / W - 1, 1 - (r.y0 + r.y1) / H), t.camera);
    const focal = new THREE.Plane().setFromNormalAndCoplanarPoint(
      t.camera.getWorldDirection(new THREE.Vector3()), t.controls.target);
    const hit = ray.ray.intersectPlane(focal, new THREE.Vector3());
    if (!hit) return;
    const off = t.camera.position.clone().sub(t.controls.target).multiplyScalar(f);
    t.controls.target.copy(hit);
    t.camera.position.copy(hit).add(off);
    keepNear();
  }

  // look straight at the slice plane (u to the right, v up) with the target on it
  function facePlane() {
    const t = three.current;
    if (!t || !plane) return;
    const d = t.camera.position.distanceTo(t.controls.target);
    const n = new THREE.Vector3().setComponent(plane.axis, 1);
    const u = new THREE.Vector3().setComponent(plane.uAxis, 1);
    const v = new THREE.Vector3().setComponent(plane.vAxis, 1);
    const s = -n.clone().cross(v).dot(u);
    t.controls.target.setComponent(plane.axis, plane.pos);
    t.camera.up.copy(v);
    t.camera.position.copy(t.controls.target).add(n.multiplyScalar(s * d));
  }

  const showLegend = !!legend && (!!plane || extraPlanes.length > 0 || lines.some((l) => !l.color));

  async function snapshot() {
    const t = three.current;
    if (!t) return;
    t.draw();
    const src = t.renderer.domElement;
    const k = src.height / 500;
    const legW = showLegend ? Math.round(170 * k) : 0;
    const out = document.createElement("canvas");
    out.width = src.width + legW;
    out.height = src.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    const ink = luminance(background) > 0.5 ? "#111" : "#eee";
    ctx.fillStyle = ink;
    ctx.font = `600 ${Math.round(15 * k)}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(exportName + (plane?.time != null ? `   t = ${plane.time.toPrecision(4)} s` : ""), 10 * k, 8 * k);
    if (showLegend) {
      drawLegend(ctx, { x: src.width + 10 * k, y: 30 * k, w: legW - 20 * k, h: src.height - 60 * k },
                 await cmapLut(cmap), range, log, legend!, ink);
    }
    savePng(out, exportName);
  }

  const dark = luminance(background) < 0.5;
  const tips = { rotate: "left-drag rotates, right-drag pans", pan: "left-drag pans (use Plane view to move along the slice), right-drag rotates",
                 box: "drag a rectangle to zoom into it" };
  return (
    <div className="viewer3d">
      <div className="pane-bar small">
        <span className="seg">
          {(["rotate", "pan", "box"] as const).map((m) => (
            <button key={m} className={mode === m ? "primary" : ""} title={tips[m]} onClick={() => setMode(m)}>
              {{ rotate: "Rotate", pan: "Pan", box: "Box zoom" }[m]}</button>))}
        </span>
        <button onClick={fit}>Fit</button>
        <button onClick={() => zoom(0.8)} title="zoom in (or mouse wheel, toward the cursor)">+</button>
        <button onClick={() => zoom(1.25)} title="zoom out">&minus;</button>
        <button onClick={facePlane} disabled={!plane} title="look straight at the slice plane">Plane</button>
        <button onClick={() => view([0, 0, 1])}>Front</button>
        <button onClick={() => view([1, 0, 0])}>Side</button>
        <button onClick={() => view([0, 1, 0], [0, 0, -1])}>Top</button>
        <button onClick={snapshot} title="PNG with legend">PNG</button>
        {loading > 0 && <span className="muted">loading {loading}...</span>}
        {error && <span className="error">{error}</span>}
      </div>
      <div className="viewer3d-wrap" title={`${tips[mode]}; wheel: zoom; double-click: set rotation center`}>
        <div ref={host} className="viewer3d-canvas" style={{ height }} />
        {mode === "box" && (
          <div className="boxzoom"
               onPointerDown={(e) => {
                 const r = e.currentTarget.getBoundingClientRect();
                 const x = e.clientX - r.left, y = e.clientY - r.top;
                 setRect({ x0: x, y0: y, x1: x, y1: y });
                 e.currentTarget.setPointerCapture(e.pointerId);
               }}
               onPointerMove={(e) => {
                 if (!rect) return;
                 const r = e.currentTarget.getBoundingClientRect();
                 setRect({ ...rect, x1: e.clientX - r.left, y1: e.clientY - r.top });
               }}
               onPointerUp={() => {
                 if (rect) zoomBox(rect);
                 setRect(null);
                 setMode("rotate");
               }}>
            {rect && <div className="boxzoom-rect" style={{
              left: Math.min(rect.x0, rect.x1), top: Math.min(rect.y0, rect.y1),
              width: Math.abs(rect.x1 - rect.x0), height: Math.abs(rect.y1 - rect.y0) }} />}
          </div>
        )}
        {showLegend && <ColorLegend cmap={cmap} range={range} log={log} dark={dark} {...legend!} />}
      </div>
    </div>
  );
}
