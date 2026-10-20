import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { cmapLut, colorize } from "./cmap";
import type { Plane } from "./plane";

export type MeshLayer = {
  key: string;      // stable id (url changes reload the geometry)
  url: string;
  color: string;
  opacity: number;
  visible: boolean;
};

const PALETTE = ["#8aa2c8", "#c8a97f", "#93c47f", "#c47f9f", "#7fc4bb", "#a37fc4", "#c4c07f"];
export const layerColor = (i: number) => PALETTE[i % PALETTE.length];

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

// Interactive 3D scene in metres: STL/surface layers plus one textured plane.
export default function Viewer3D({ layers, plane, cmap, range, log, height = 560 }: {
  layers: MeshLayer[];
  plane: Plane | null;
  cmap: string;
  range: [number, number];
  log: boolean;
  height?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer;
    controls: OrbitControls; meshes: Map<string, THREE.Mesh>; plane: THREE.Mesh | null;
    fitted: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
    three.current = { scene, camera, renderer, controls, meshes: new Map(), plane: null, fitted: false };
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
    const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      three.current = null;
    };
  }, []);

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
      (t.plane.material as THREE.MeshBasicMaterial).map?.dispose();
      t.plane.geometry.dispose();
      t.plane = null;
    }
    if (!plane) return;
    let live = true;
    cmapLut(cmap).then((lut) => {
      if (!live || !three.current) return;
      const px = colorize(plane.data, plane.w, plane.h, lut, range[0], range[1], log, false);
      const tex = new THREE.DataTexture(px, plane.w, plane.h, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      const W = plane.w * plane.du, H = plane.h * plane.dv;
      const geo = new THREE.PlaneGeometry(W, H);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      // PlaneGeometry spans local x (u) and y (v); orient into world axes
      const u = new THREE.Vector3().setComponent(plane.uAxis, 1);
      const v = new THREE.Vector3().setComponent(plane.vAxis, 1);
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, u.clone().cross(v)));
      const c = [0, 0, 0];
      c[plane.axis] = plane.pos;
      c[plane.uAxis] = plane.u0 - plane.du / 2 + W / 2;
      c[plane.vAxis] = plane.v0 - plane.dv / 2 + H / 2;
      m.position.set(c[0], c[1], c[2]);
      three.current.scene.add(m);
      three.current.plane = m;
      if (!three.current.fitted) fit();
    });
    return () => { live = false; };
  }, [plane, cmap, range, log]); // eslint-disable-line react-hooks/exhaustive-deps

  function fit() {
    const t = three.current;
    if (!t) return;
    const box = new THREE.Box3();
    t.meshes.forEach((m) => box.expandByObject(m));
    if (t.plane) box.expandByObject(t.plane);
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

  function snapshot() {
    const t = three.current;
    if (!t) return;
    t.renderer.render(t.scene, t.camera);
    const a = document.createElement("a");
    a.href = t.renderer.domElement.toDataURL("image/png");
    a.download = "view3d.png";
    a.click();
  }

  return (
    <div className="viewer3d">
      <div className="row small">
        <button onClick={fit}>Fit</button>
        <button onClick={() => view([0, 0, 1])}>Front (+z)</button>
        <button onClick={() => view([1, 0, 0])}>Side (+x)</button>
        <button onClick={() => view([0, 1, 0], [0, 0, -1])}>Top (+y)</button>
        <button onClick={snapshot}>PNG</button>
        {loading > 0 && <span className="muted">loading {loading} mesh(es)...</span>}
        {error && <span className="error">{error}</span>}
      </div>
      <div ref={host} className="viewer3d-canvas" style={{ height }} />
    </div>
  );
}
