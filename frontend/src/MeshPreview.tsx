import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { fmtBytes } from "./FilesView";

// 3D preview of a CAD file (STL directly; STEP/IGES tessellated by the server).
export default function MeshPreview({ url, name }: { url: string; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<{ tris: number; size: [number, number, number]; bytes: number; source: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [wire, setWire] = useState(false);
  const sceneRef = useRef<{ mesh: THREE.Mesh; edges: THREE.LineSegments; controls: OrbitControls; camera: THREE.PerspectiveCamera; fit: () => void } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let live = true;
    setBusy(true);
    setError(null);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setClearColor(0x1e293b);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, el.clientWidth / el.clientHeight, 0.01, 1e6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(1, 1.5, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-2, -1, -1);
    scene.add(fill);
    let frame = 0;
    const draw = () => { controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(draw); };
    draw();
    const onResize = () => {
      if (!el.clientWidth) return;
      renderer.setSize(el.clientWidth, el.clientHeight);
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    fetch(url, { credentials: "same-origin" }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status} ${r.statusText}`);
      const source = r.headers.get("X-Mesh-Source") ?? "stl";
      const buf = await r.arrayBuffer();
      if (!live) return;
      const geo = new STLLoader().parse(buf);
      geo.computeVertexNormals();
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      const size = new THREE.Vector3();
      bb.getSize(size);
      const center = new THREE.Vector3();
      bb.getCenter(center);
      geo.translate(-center.x, -center.y, -center.z);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9fb4d1, metalness: 0.15, roughness: 0.6, side: THREE.DoubleSide }));
      scene.add(mesh);
      // feature edges make the shape readable; hidden by default on dense meshes
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: 0x1f2937 }));
      edges.visible = geo.attributes.position.count / 3 < 200_000;
      scene.add(edges);
      const r0 = size.length() / 2 || 1;
      scene.add(new THREE.AxesHelper(r0 * 0.6));
      const fit = () => {
        camera.position.set(r0 * 1.6, r0 * 1.2, r0 * 2.0);
        camera.near = r0 / 1000; camera.far = r0 * 100;
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.update();
      };
      fit();
      sceneRef.current = { mesh, edges, controls, camera, fit };
      setInfo({ tris: geo.attributes.position.count / 3, size: [size.x, size.y, size.z], bytes: buf.byteLength, source });
      setBusy(false);
    }).catch((e) => { if (live) { setError(e.message); setBusy(false); } });

    return () => {
      live = false;
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); (m.material as THREE.Material)?.dispose?.(); });
      el.innerHTML = "";
      sceneRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    const s = sceneRef.current;
    if (s) (s.mesh.material as THREE.MeshStandardMaterial).wireframe = wire;
  }, [wire, info]);

  const unit = info && Math.max(...info.size) > 50 ? "mm" : "m";  // M-Star geometry is in m, CAD usually in mm
  return (
    <div className="mesh-preview">
      <div className="row small">
        {busy && <span className="muted">Loading{/\.(step|stp|iges|igs|brep|brp)$/i.test(name) ? " (converting with FreeCAD, first time may take a while)" : ""}...</span>}
        {info && <span className="muted">{info.tris.toLocaleString()} triangles &middot; {fmtBytes(info.bytes)} &middot; extent {info.size.map((v) => v.toPrecision(4)).join(" x ")} ({unit}, as stored){info.source === "freecad" ? " · tessellated by FreeCAD" : ""}</span>}
        <span className="grow" />
        <label><input type="checkbox" checked={wire} onChange={(e) => setWire(e.target.checked)} /> wireframe</label>
        <button className="small" onClick={() => sceneRef.current?.fit()}>Fit</button>
        <button className="small" onClick={() => { const c = box.current?.querySelector("canvas"); if (c) { const a = document.createElement("a"); a.href = c.toDataURL("image/png"); a.download = `${name}.png`; a.click(); } }}>PNG</button>
      </div>
      {error && <div className="error">{error}</div>}
      <div ref={box} className="mesh-canvas" />
      <div className="small muted">Drag to rotate, scroll to zoom, right-drag to pan.</div>
    </div>
  );
}
