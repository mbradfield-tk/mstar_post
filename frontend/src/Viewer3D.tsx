import { memo, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import ColorLegend, { drawLegend, savePng, type LegendInfo } from "./ColorLegend";
import { cmapLut, colorize, hexRgb, luminance, shadeLic, upsample } from "./cmap";
import { isAbort, LoadCache, type Plane } from "./plane";
import { sameProps, type Overlay } from "./SliceCanvas";

export type MeshLayer = {
  key: string;      // stable id (url changes reload the geometry)
  url: string;
  color: string;
  opacity: number;
  visible: boolean;
  smooth?: boolean; // vertex normals across the mesh (free surfaces) instead of flat facets (CAD, impellers)
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
const NO_LINES: LineLayer[] = [];
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

// Decoded meshes (binary STL or the app's indexed "MPM1" format) kept within a byte budget, least
// recently used first. `shown` counts the panes drawing a geometry: such a geometry is never dropped,
// and its GPU buffers are freed as soon as no pane draws it (three uploads it again when it is shown
// again; the arrays stay in the cache), so GPU memory follows what is on screen.
const MESH_CACHE_BYTES = 700 * 1024 * 1024;
const shown = new WeakMap<THREE.BufferGeometry, number>();
const holdGeo = (g: THREE.BufferGeometry) => { shown.set(g, (shown.get(g) ?? 0) + 1); };
const releaseGeo = (g: THREE.BufferGeometry) => {
  const n = (shown.get(g) ?? 1) - 1;
  if (n > 0) shown.set(g, n); else { shown.delete(g); g.dispose(); }
};
function parseMesh(buf: ArrayBuffer): THREE.BufferGeometry {
  const magic = new Uint8Array(buf, 0, 4);
  if (String.fromCharCode(...magic) === "MPM1") {
    const [np, nt] = new Uint32Array(buf, 4, 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buf, 12, np * 3), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, 12 + np * 12, nt * 3), 1));
    return g;
  }
  return new STLLoader().parse(buf);
}
// "no-cache": the files are served with validators only, so the browser must ask whether its copy
// is still the file on disk (a re-run solve writes the same names)
async function fetchBuf(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const r = await fetch(url, { signal, cache: "no-cache" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status}`);
  return r.arrayBuffer();
}
// Vertex normals are not computed here: only smooth layers need them (flat shading derives the
// normals in the shader) and only for the frames that are shown (see the layers effect).
const meshes = new LoadCache<THREE.BufferGeometry>(MESH_CACHE_BYTES,
  async (url, signal) => parseMesh(await fetchBuf(url, signal)),
  (g) => 2 * g.attributes.position.array.byteLength + (g.index ? g.index.array.byteLength : 0),  // + normals
  (g) => shown.has(g), (g) => g.dispose());
export function clearViewerCaches(): void {
  meshes.clear();
  lineCache.clear();
}
/** Fetch and decode a mesh ahead of time (e.g. the next time step); settles when it is there or failed. */
export const prefetchMesh = (url: string): Promise<void> => meshes.get(url).then(() => undefined, () => undefined);

type Lines = { pts: Float32Array; speed: Float32Array; offsets: Uint32Array };
const lineCache = new Map<string, Promise<Lines>>();
function loadLines(url: string): Promise<Lines> {
  let p = lineCache.get(url);
  if (p) lineCache.delete(url);
  else {
    p = fetchBuf(url).then((buf) => {
      const [n, m] = new Uint32Array(buf, 0, 2);
      return { pts: new Float32Array(buf, 8, n * 3), speed: new Float32Array(buf, 8 + n * 12, n),
               offsets: new Uint32Array(buf, 8 + n * 16, m + 1) };
    });
    p.catch(() => lineCache.delete(url));
  }
  lineCache.set(url, p);
  if (lineCache.size > 16) lineCache.delete(lineCache.keys().next().value!);
  return p;
}

// Textured quad of a plane in world coordinates: one unit square and one material per quad, placed
// and textured per plane; px is RGBA at scale s x the plane grid (rows = v up).
const newQuad = (geo: THREE.BufferGeometry) => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
function setQuad(m: THREE.Mesh, plane: Plane, px: Uint8ClampedArray<ArrayBuffer>, s = 1, smooth = false): void {
  const mat = m.material as THREE.MeshBasicMaterial;
  mat.map?.dispose();
  const tex = new THREE.DataTexture(px, plane.w * s, plane.h * s, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
  tex.needsUpdate = true;
  mat.map = tex;
  const W = plane.w * plane.du, H = plane.h * plane.dv;
  m.scale.set(W, H, 1);
  // the unit square spans local x (u) and y (v); orient into world axes
  const u = new THREE.Vector3().setComponent(plane.uAxis, 1);
  const v = new THREE.Vector3().setComponent(plane.vAxis, 1);
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, u.clone().cross(v)));
  const c = [0, 0, 0];
  c[plane.axis] = plane.pos;
  c[plane.uAxis] = plane.u0 - plane.du / 2 + W / 2;
  c[plane.vAxis] = plane.v0 - plane.dv / 2 + H / 2;
  m.position.set(c[0], c[1], c[2]);
}
function dropQuad(m: THREE.Mesh): void {
  (m.material as THREE.MeshBasicMaterial).map?.dispose();
  (m.material as THREE.Material).dispose();
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
  const dispose = () => scene.traverse((o) => {
    const x = o as THREE.Mesh;
    x.geometry?.dispose();
    const m = x.material as (THREE.Material & { map?: THREE.Texture | null }) | undefined;
    m?.map?.dispose();
    m?.dispose();
  });
  return { scene, cam, dispose };
}

// Line segments of the streamlines (uncolored: see colorLines).
function linesObject(l: Lines): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(l.pts, 3));
  let n = 0;
  for (let k = 0; k + 1 < l.offsets.length; k++) n += Math.max(0, l.offsets[k + 1] - l.offsets[k] - 1);
  const idx = new Uint32Array(2 * n);
  for (let k = 0, j = 0; k + 1 < l.offsets.length; k++)
    for (let i = l.offsets[k]; i + 1 < l.offsets[k + 1]; i++) { idx[j++] = i; idx[j++] = i + 1; }
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial());
}
// One color, or by speed with the layer's colormap and range; only the color attribute and the
// material change, so a new range or color does not rebuild the lines.
async function colorLines(o: THREE.LineSegments, l: Lines, layer: LineLayer): Promise<void> {
  const mat = o.material as THREE.LineBasicMaterial;
  if (layer.color) {
    mat.color.set(layer.color);
    if (mat.vertexColors) { mat.vertexColors = false; mat.needsUpdate = true; }
    return;
  }
  const lut = await cmapLut(layer.cmap);
  const rgba = colorize(l.speed, l.speed.length, 1, lut, layer.range[0], layer.range[1], layer.log, false);
  let a = o.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!a) o.geometry.setAttribute("color", a = new THREE.BufferAttribute(new Float32Array(l.speed.length * 3), 3));
  const col = a.array as Float32Array;
  for (let i = 0; i < l.speed.length; i++) {
    col[3 * i] = rgba[4 * i] / 255; col[3 * i + 1] = rgba[4 * i + 1] / 255; col[3 * i + 2] = rgba[4 * i + 2] / 255;
  }
  a.needsUpdate = true;
  mat.color.set("#ffffff");
  if (!mat.vertexColors) { mat.vertexColors = true; mat.needsUpdate = true; }
}

type Slot = { mesh: THREE.Mesh; url: string; reload: number };  // url / reload = the geometry it shows
type LineSlot = { obj: THREE.LineSegments; url: string; reload: number; data: Lines; sig: string };

// color, opacity and shading of a layer on its mesh (the material is kept for the life of the layer,
// so a new time step does not compile a shader)
function styleMesh(m: THREE.Mesh, l: MeshLayer): void {
  const mat = m.material as THREE.MeshStandardMaterial;
  mat.color.set(l.color);
  mat.opacity = l.opacity;
  // opaque materials are compiled with OPAQUE (alpha forced to 1): recompile when it flips
  if (mat.transparent !== (l.opacity < 1)) { mat.transparent = l.opacity < 1; mat.needsUpdate = true; }
  mat.depthWrite = l.opacity >= 1;
  if (mat.flatShading === !!l.smooth) { mat.flatShading = !l.smooth; mat.needsUpdate = true; }
  if (l.smooth && !m.geometry.attributes.normal) m.geometry.computeVertexNormals();
}

// Interactive 3D scene in metres: STL/surface layers, streamlines and one
// textured plane (optionally LIC-shaded), with an in-view legend. Drawn on demand.
function Viewer3D({ layers, plane, cmap, range, log, height = 560, sync, lines = NO_LINES,
                    background = "#f4f6f9", legend, overlay, exportName = "view3d",
                    extraPlanes = NO_PLANES, smooth = false, onLoading, loadKey, reload = 0 }: {
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
  smooth?: boolean;  // bilinear plane texture (2x upsampled, masked cells crisp) instead of flat cells
  onLoading?: (n: number, key?: string) => void;  // meshes / streamlines still loading (playback waits for 0)
  loadKey?: string;  // passed back to onLoading (so one stable callback serves every pane)
  reload?: number;   // a new value loads every mesh and streamline again (Refresh: files may have changed)
}) {
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer;
    controls: OrbitControls; meshes: Map<string, Slot>; plane: THREE.Mesh; quad: THREE.BufferGeometry;
    lines: Map<string, LineSlot>; extra: THREE.Mesh[]; draw: () => void;
    invalidate: () => void;  // ask for one frame (the scene, the camera or the size changed)
    userMoved: boolean;   // the user (or a linked camera) has positioned the camera: stop auto-fitting
    seen: Set<string>;    // layer keys / plane kinds already fitted once
  } | null>(null);
  const [loading, setLoading] = useState(0);
  const onLoadingRef = useRef(onLoading);
  onLoadingRef.current = onLoading;
  const loadKeyRef = useRef(loadKey);
  loadKeyRef.current = loadKey;
  useEffect(() => { onLoadingRef.current?.(loading, loadKeyRef.current); }, [loading]);
  useEffect(() => () => onLoadingRef.current?.(0, loadKeyRef.current), []);
  const [meshErr, setMeshErr] = useState<string | null>(null);
  const [lineErr, setLineErr] = useState<string | null>(null);
  const me = useRef({});
  const applying = useRef(false);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    const el = host.current!;
    // no preserveDrawingBuffer: snapshot() draws and copies in one task
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setClearColor(0xf4f6f9);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 1e-4, 1e3);
    camera.position.set(1, 1, 1);  // isometric until the first fit
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 2, 1.5);
    camera.add(sun);
    scene.add(camera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.zoomToCursor = true;
    const quad = new THREE.PlaneGeometry(1, 1);
    const planeQuad = newQuad(quad);
    planeQuad.visible = false;
    scene.add(planeQuad);
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
    // Drawn on demand: invalidate() asks for one frame; frames only follow each other while the
    // damping of the controls still moves the camera.
    let raf = 0, dirty = true;
    const frame = () => {
      raf = 0;
      if (!el.clientWidth) return;  // hidden tab: the resize when it is shown again asks for a frame
      const moving = controls.update();
      if (dirty || moving) { dirty = false; draw(); }
      if (moving && !raf) raf = requestAnimationFrame(frame);
    };
    const invalidate = () => { dirty = true; if (!raf) raf = requestAnimationFrame(frame); };
    const t = three.current = { scene, camera, renderer, controls, meshes: new Map<string, Slot>(), plane: planeQuad, quad,
                                lines: new Map<string, LineSlot>(), extra: [] as THREE.Mesh[], draw, invalidate,
                                userMoved: false as boolean, seen: new Set<string>() };
    const onDbl = (e: MouseEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1,
                                          -(e.clientY - r.top) / r.height * 2 + 1), camera);
      const objs: THREE.Object3D[] = [...[...t.meshes.values()].map((s) => s.mesh), ...(t.plane.visible ? [t.plane] : []), ...t.extra];
      const hit = ray.intersectObjects(objs, false)[0];
      if (hit) { controls.target.copy(hit.point); invalidate(); }
    };
    renderer.domElement.addEventListener("dblclick", onDbl);
    // every camera move (drag, wheel, buttons, a linked camera): keep the clip planes around the
    // distance to the target, so zooming in does not cut the geometry open, and draw
    const onChange = () => {
      const d = camera.position.distanceTo(controls.target);
      if (d > 0 && (camera.near > d / 20 || camera.near < d / 400 || camera.far < d * 4)) {
        camera.near = d / 20;
        camera.far = Math.max(camera.far, d * 10);
        camera.updateProjectionMatrix();
      }
      invalidate();
      if (applying.current || !syncRef.current) return;
      syncRef.current.publish({ pos: camera.position.toArray(), target: controls.target.toArray(),
                                up: camera.up.toArray() }, me.current);
    };
    controls.addEventListener("change", onChange);
    const onStart = () => { t.userMoved = true; };
    controls.addEventListener("start", onStart);
    renderer.domElement.addEventListener("wheel", onStart, { passive: true });
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;  // hidden tab
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
      invalidate();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    invalidate();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.removeEventListener("change", onChange);
      controls.removeEventListener("start", onStart);
      renderer.domElement.removeEventListener("wheel", onStart);
      renderer.domElement.removeEventListener("dblclick", onDbl);
      // free what this pane holds: shared geometries (their GPU copies go when no pane shows them),
      // materials, plane textures, lines, the gizmo, and the WebGL context itself
      t.meshes.forEach((s) => { releaseGeo(s.mesh.geometry); (s.mesh.material as THREE.Material).dispose(); });
      t.lines.forEach((s) => { s.obj.geometry.dispose(); (s.obj.material as THREE.Material).dispose(); });
      [t.plane, ...t.extra].forEach(dropQuad);
      quad.dispose();
      axes.dispose();
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
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
      t.userMoved = true;
      t.invalidate();
    };
    if (sync.last) apply(sync.last);
    return sync.subscribe((s, from) => { if (from !== me.current) apply(s); });
  }, [sync]);

  useEffect(() => {
    const t = three.current;
    if (!t) return;
    t.renderer.setClearColor(background);
    t.invalidate();
  }, [background]);

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

  // streamline layers: one object per layer key; the lines of a new url replace it when they have
  // arrived, a new color or range only recolors it
  const wantLines = useRef(new Map<string, LineLayer>());
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    setLineErr(null);
    wantLines.current = new Map(lines.map((l) => [l.key, l]));
    const sigOf = (l: LineLayer) => JSON.stringify(l.color ? [l.color] : [l.cmap, l.range, l.log]);
    const drop = (s: LineSlot) => { t.scene.remove(s.obj); s.obj.geometry.dispose(); (s.obj.material as THREE.Material).dispose(); };
    for (const [k, s] of t.lines) {
      if (!wantLines.current.has(k)) { drop(s); t.lines.delete(k); t.invalidate(); }
    }
    for (const l of lines) {
      const s = t.lines.get(l.key);
      if (s && s.url === l.url && s.reload === reload) {
        if (s.sig !== sigOf(l)) { s.sig = sigOf(l); colorLines(s.obj, s.data, l).then(() => three.current?.invalidate()); }
        continue;
      }
      setLoading((n) => n + 1);
      loadLines(l.url).then(async (d) => {
        const here = () => three.current === t && wantLines.current.get(l.key)?.url === l.url;
        const has = () => { const x = t.lines.get(l.key); return !!x && x.url === l.url && x.reload === reload; };
        if (!here() || has()) return;
        const obj = linesObject(d), cur = wantLines.current.get(l.key)!;
        await colorLines(obj, d, cur);
        if (!here() || has()) { obj.geometry.dispose(); (obj.material as THREE.Material).dispose(); return; }
        const old = t.lines.get(l.key);
        if (old) drop(old);
        t.scene.add(obj);
        const slot: LineSlot = { obj, url: l.url, reload, data: d, sig: sigOf(cur) };
        t.lines.set(l.key, slot);
        const now = wantLines.current.get(l.key)!;  // the coloring may have changed while it loaded
        if (sigOf(now) !== slot.sig) { slot.sig = sigOf(now); colorLines(obj, d, now).then(() => t.invalidate()); }
        t.invalidate();
      }).catch((e) => setLineErr(`streamlines: ${e.message ?? e}`))
        .finally(() => setLoading((n) => n - 1));
    }
  }, [lines, reload]);

  // mesh layers: one mesh and material per layer key. The geometry of a new url (time step) is
  // swapped in when it has been decoded, so the previous one stays on screen meanwhile; a geometry
  // that is no longer wanted when it arrives (newer time step, layer switched off) is not used,
  // and its download is given up unless a prefetch asked for it too
  const wanted = useRef(new Map<string, MeshLayer>());
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    setMeshErr(null);
    const visible = layers.filter((l) => l.visible);
    wanted.current = new Map(visible.map((l) => [l.key, l]));
    for (const [k, s] of t.meshes) {
      if (wanted.current.has(k)) continue;
      t.scene.remove(s.mesh);
      releaseGeo(s.mesh.geometry);
      (s.mesh.material as THREE.Material).dispose();
      t.meshes.delete(k);
      t.invalidate();
    }
    const ac = new AbortController();
    for (const l of visible) {
      const s = t.meshes.get(l.key);
      if (s) {
        styleMesh(s.mesh, l);
        t.invalidate();
        if (s.url === l.url && s.reload === reload) continue;
      }
      setLoading((n) => n + 1);
      meshes.get(l.url, ac.signal).then((g) => {
        const cur = wanted.current.get(l.key);
        if (three.current !== t || !cur || cur.url !== l.url) return;
        const slot = t.meshes.get(l.key);
        if (slot && slot.url === l.url && slot.reload === reload) return;
        holdGeo(g);
        if (slot) {
          releaseGeo(slot.mesh.geometry);
          slot.mesh.geometry = g;
          slot.url = l.url;
          slot.reload = reload;
          styleMesh(slot.mesh, cur);
        } else {
          const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, metalness: 0.1, roughness: 0.7 }));
          styleMesh(mesh, cur);
          t.scene.add(mesh);
          t.meshes.set(l.key, { mesh, url: l.url, reload });
        }
        if (!t.userMoved && !t.seen.has(l.key)) { t.seen.add(l.key); fit(ISO); }
        t.invalidate();
      }).catch((e) => { if (!isAbort(e)) setMeshErr(`${l.key}: ${e.message ?? e}`); })
        .finally(() => setLoading((n) => n - 1));
    }
    return () => ac.abort();
  }, [layers, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // textured plane: one quad and material, a new texture per plane / coloring
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    if (!plane) {
      if (t.plane.visible) { t.plane.visible = false; t.invalidate(); }
      return;
    }
    let live = true;
    const lic = overlay?.lic && overlay.lic.length === plane.w * plane.h * overlay.licScale ** 2
      ? overlay.lic : null;
    cmapLut(cmap).then((lut) => {
      if (!live || three.current !== t) return;
      const s = lic ? overlay!.licScale : smooth ? 2 : 1;
      let px: Uint8ClampedArray<ArrayBuffer>;
      if (smooth) {
        px = colorize(upsample(plane.data, plane.w, plane.h, s), plane.w * s, plane.h * s, lut, range[0], range[1], log, false, hexRgb(background));
        if (lic) px = shadeLic(px, plane.w * s, plane.h * s, lic, 1, overlay!.licMode, false);
      } else {
        const base = colorize(plane.data, plane.w, plane.h, lut, range[0], range[1], log, false, hexRgb(background));
        px = lic ? shadeLic(base, plane.w, plane.h, lic, s, overlay!.licMode, false) : base;
      }
      setQuad(t.plane, plane, px, s, smooth);
      t.plane.visible = true;
      if (!t.userMoved && !t.seen.has("plane")) { t.seen.add("plane"); fit(ISO); }
      t.invalidate();
    });
    return () => { live = false; };
  }, [plane, cmap, range[0], range[1], log, overlay?.lic, overlay?.licMode, overlay?.licScale, background, smooth]); // eslint-disable-line react-hooks/exhaustive-deps

  // additional planes (e.g. the three center planes), colored like the main plane; quads are reused
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const trim = (n: number) => {
      while (t.extra.length > n) { const m = t.extra.pop()!; t.scene.remove(m); dropQuad(m); t.invalidate(); }
    };
    if (!extraPlanes.length) { trim(0); return; }
    let live = true;
    cmapLut(cmap).then((lut) => {
      if (!live || three.current !== t) return;
      extraPlanes.forEach((p, i) => {
        if (!t.extra[i]) { t.extra[i] = newQuad(t.quad); t.scene.add(t.extra[i]); }
        const s = smooth ? 2 : 1;
        const d = smooth ? upsample(p.data, p.w, p.h, s) : p.data;
        setQuad(t.extra[i], p, colorize(d, p.w * s, p.h * s, lut, range[0], range[1], log, false, hexRgb(background)), s, smooth);
      });
      trim(extraPlanes.length);
      if (!t.userMoved && !t.seen.has("extra")) { t.seen.add("extra"); fit(ISO); }
      t.invalidate();
    });
    return () => { live = false; };
  }, [extraPlanes, cmap, range[0], range[1], log, background, smooth]); // eslint-disable-line react-hooks/exhaustive-deps

  const ISO: [number, number, number] = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];

  // Frame the whole scene in the viewport: the box corners projected on the camera's right/up
  // axes set the distance from the vertical and horizontal field of view. Default direction is
  // isometric (the Fit button keeps the current direction).
  function fit(dir?: [number, number, number]) {
    const t = three.current;
    if (!t) return;
    const box = new THREE.Box3();
    t.meshes.forEach((s) => box.expandByObject(s.mesh));
    if (t.plane.visible) box.expandByObject(t.plane);
    t.extra.forEach((m) => box.expandByObject(m));
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const d = dir ? new THREE.Vector3(...dir).normalize()
      : t.camera.position.clone().sub(t.controls.target).normalize();
    if (!d.lengthSq()) d.set(...ISO);
    const up = Math.abs(d.dot(t.camera.up)) > 0.999 ? new THREE.Vector3(0, 0, -1) : t.camera.up.clone();
    const right = new THREE.Vector3().crossVectors(up, d).normalize();
    const upv = new THREE.Vector3().crossVectors(d, right).normalize();
    let hw = 0, hh = 0, hd = 0;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      hw = Math.max(hw, Math.abs(v.dot(right)));
      hh = Math.max(hh, Math.abs(v.dot(upv)));
      hd = Math.max(hd, Math.abs(v.dot(d)));
    }
    const fovV = (t.camera.fov * Math.PI) / 180, fovH = 2 * Math.atan(Math.tan(fovV / 2) * t.camera.aspect);
    const dist = Math.max(hw / Math.tan(fovH / 2), hh / Math.tan(fovV / 2)) * 1.06 + hd;
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    t.controls.target.copy(c);
    t.camera.position.copy(c).add(d.multiplyScalar(dist));
    t.camera.near = Math.max(1e-5, (dist - r) / 10);
    t.camera.far = (dist + r) * 10;
    t.camera.updateProjectionMatrix();
    t.invalidate();
  }

  // camera.up stays +y, the orbit axis of the controls (they fix it when they are created), so
  // rotating after any of these views behaves; a view along y is tilted by 0.06 degrees instead
  function view(dir: [number, number, number]) {
    const t = three.current;
    if (!t) return;
    t.userMoved = true;
    const d = t.camera.position.distanceTo(t.controls.target);
    t.camera.position.copy(t.controls.target).add(new THREE.Vector3(...dir).normalize().multiplyScalar(d));
    t.invalidate();
  }

  function zoom(f: number) {
    const t = three.current;
    if (!t) return;
    const off = t.camera.position.clone().sub(t.controls.target).multiplyScalar(f);
    t.camera.position.copy(t.controls.target).add(off);
    t.invalidate();
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
    t.invalidate();
  }

  // look straight at the slice plane (u to the right, v up) with the target on it. A y-normal
  // plane (v = z) is seen from below with a tilt of 0.06 degrees towards z: with up = +y that
  // puts z up on screen (see view)
  function facePlane() {
    const t = three.current;
    if (!t || !plane) return;
    t.userMoved = true;
    const d = t.camera.position.distanceTo(t.controls.target);
    const n = new THREE.Vector3().setComponent(plane.axis, 1);
    const u = new THREE.Vector3().setComponent(plane.uAxis, 1);
    const v = new THREE.Vector3().setComponent(plane.vAxis, 1);
    const s = -n.clone().cross(v).dot(u);
    t.controls.target.setComponent(plane.axis, plane.pos);
    const dir = n.multiplyScalar(s);
    if (plane.axis === 1) dir.addScaledVector(v, -s * 1e-3).normalize();
    t.camera.position.copy(t.controls.target).add(dir.multiplyScalar(d));
    t.invalidate();
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
        <button onClick={() => { if (three.current) three.current.userMoved = true; fit(); }} title="frame everything in the view (keeps the direction)">Fit</button>
        <button onClick={() => zoom(0.8)} title="zoom in (or mouse wheel, toward the cursor)">+</button>
        <button onClick={() => zoom(1.25)} title="zoom out">&minus;</button>
        <button onClick={facePlane} disabled={!plane} title="look straight at the slice plane">Plane</button>
        <button onClick={() => view([0, 0, 1])}>Front</button>
        <button onClick={() => view([1, 0, 0])}>Side</button>
        <button onClick={() => view([0, 1, 1e-3])}>Top</button>
        <button onClick={() => view(ISO)}
                title="isometric: equal angles to x, y and z, y up">Iso</button>
        <button onClick={snapshot} title="PNG with legend">PNG</button>
        {loading > 0 && <span className="muted">loading {loading}...</span>}
        {(meshErr || lineErr) && <span className="error">{[meshErr, lineErr].filter(Boolean).join("; ")}</span>}
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

// re-rendered only when a prop really changes (ranges, legends and overlays are compared by value)
export default memo(Viewer3D, sameProps);
