import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, AXES, copyText, download, fmt, toCsv, type Inventory, type OutputKind, type PointValue, type Project } from "./api";
import { SolveTag, useSolves } from "./CasesView";
import { hasFinite, logRange, smoothed } from "./cmap";
import { traceStreamlines, type Vec2 } from "./flow";
import { clearLicCache, licNow, runLic } from "./lic";
import { clearPlaneCache, fetchPlane, holdPlanes, isAbort, planeNow, type Plane } from "./plane";
import Plot from "./Plot";
import SliceCanvas, { type Overlay, type Region, type RegionShape, type Tool } from "./SliceCanvas";
import Viewer3D, { CameraSync, clearViewerCaches, layerColor, prefetchMesh, type LineLayer, type MeshLayer } from "./Viewer3D";

const MAX_CASES = 4;
const SLIDER_WAIT = 100;  // ms the time / position slider must rest before its frame or plane is fetched
const MEAN_WAIT = 300;    // ms a frame must stay shown before its global mean is requested
const BG_PRESETS = ["#f4f6f9", "#ffffff", "#808080", "#000000", "#1e293b"];
const NO_LAYERS: MeshLayer[] = [];
type FlowMode = "none" | "lines" | "lic" | "both";
// the two in-plane components of a vector plane (one object per plane)
const vec2s = new WeakMap<Plane, Vec2>();
const toVec2 = (p: Plane): Vec2 => {
  let f = vec2s.get(p);
  if (!f) vec2s.set(p, f = { w: p.w, h: p.h, du: p.du, dv: p.dv,
                             u: p.data.subarray(0, p.w * p.h), v: p.data.subarray(p.w * p.h, 2 * p.w * p.h) });
  return f;
};
// 2D streamlines of a vector plane: traced once per plane and density, whatever else is rendered
const traced = new WeakMap<Plane, Map<number, Float32Array[]>>();
const streamlinesOf = (p: Plane, density: number): Float32Array[] => {
  let m = traced.get(p);
  if (!m) traced.set(p, m = new Map());
  let l = m.get(density);
  if (!l) {
    if (m.size > 2) m.clear();
    m.set(density, l = traceStreamlines(toVec2(p), density));
  }
  return l;
};
type RangeMode = "auto" | "robust" | "manual";
type Profile = { id: string; distance: number[]; value: (number | null)[]; unit: string };
// line profiles of the shown cases with the line, field and frames they were read for
type Profiles = { p0: number[]; p1: number[]; label: string; key: string; rows: Profile[] };
// additional 2D + 3D row for one case with its own field (same output, time and plane)
type ExtraRange = "shared" | RangeMode;
type Extra = { key: number; id: string; array: string; comp: string; cmap: string; log: boolean;
               range: ExtraRange; manual: [number, number] };
const MAX_EXTRAS = 6;
const nearest = (k: OutputKind, t: number) => {
  let best = 0;
  k.times.forEach((x, i) => { if (Math.abs(x - t) < Math.abs(k.times[best] - t)) best = i; });
  return best;
};
const bounds = (k: OutputKind, axis: number): [number, number] => {
  const e = k.extent!, o = k.origin!, s = k.spacing!;
  return [o[axis] + e[2 * axis] * s[axis], o[axis] + e[2 * axis + 1] * s[axis]];
};
// volume output of the isosurface: the selected output when it is a volume, else as the default
// output ("Volume", else the first that is not BoundaryConditions, else the first volume)
const volKindOf = (inv: Inventory | null | undefined, selected: string): OutputKind | undefined => {
  const vols = inv?.kinds.filter((k) => k.type === "volume") ?? [];
  return vols.find((k) => k.kind === selected) ?? vols.find((k) => k.kind === "Volume")
    ?? vols.find((k) => !/boundary/i.test(k.kind)) ?? vols[0];
};
// posed moving-body surfaces replace the static impeller STL; the vessel shell starts hidden
const geoDefaults = (inv: Inventory) => {
  const moving = inv.kinds.some((k) => k.type === "surface" && /movingbody/i.test(k.kind));
  return Object.fromEntries(inv.geometry.map((g) => [g.name, {
    on: !/fluid height|box|vessel|tank|shell|wall|static/i.test(g.name) && !(moving && /moving|agitator|impeller|rotor/i.test(g.name)),
    opacity: /wall|vessel|tank|shell|static/i.test(g.name) ? 0.2 : 0.9,
  }]));
};
// time-varying output surfaces (VOF free surface, posed moving bodies): shown, color, opacity
type SurfOpt = { on: boolean; color: string; opacity: number };
const isVof = (kind: string) => /vof/i.test(kind);
const surfDefaults = (inv: Inventory): Record<string, SurfOpt> => Object.fromEntries(inv.kinds.filter((k) => k.type === "surface")
  .map((k) => [k.kind, { on: /^VolumeMovingBody/i.test(k.kind), color: isVof(k.kind) ? "#4aa3df" : "#9a9a9a", opacity: isVof(k.kind) ? 0.75 : 1 }]));
// triangle budget per surface: lower = faster conversion, download and rendering; "full" skips simplification
const DETAIL: [number, string][] = [[100000, "low (~100k triangles)"], [250000, "medium (~250k)"], [4000000, "full (as exported)"]];

type RegionStats = { mean: number | null; std: number | null; min: number | null; max: number | null;
                     n: number; nAll: number; du: number; dv: number };
// statistics of the plane cells whose centres lie inside the polygon (world coordinates); NaN = solid.
// data = the values to average: p.data, or its smoothed copy when smooth shading is on
function regionStats(p: Plane, poly: number[][], data: Float32Array = p.data): RegionStats {
  const pts = poly.map((q) => [q[p.uAxis], q[p.vAxis]]);
  const inside = (x: number, y: number) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
      if ((pts[i][1] > y) !== (pts[j][1] > y)
          && x < (pts[j][0] - pts[i][0]) * (y - pts[i][1]) / (pts[j][1] - pts[i][1]) + pts[i][0]) c = !c;
    return c;
  };
  const us = pts.map((q) => q[0]), vs = pts.map((q) => q[1]);
  const c0 = Math.max(0, Math.floor((Math.min(...us) - p.u0) / p.du)), c1 = Math.min(p.w - 1, Math.ceil((Math.max(...us) - p.u0) / p.du));
  const r0 = Math.max(0, Math.floor((Math.min(...vs) - p.v0) / p.dv)), r1 = Math.min(p.h - 1, Math.ceil((Math.max(...vs) - p.v0) / p.dv));
  let n = 0, nAll = 0, s = 0, s2 = 0, mn = Infinity, mx = -Infinity;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    if (!inside(p.u0 + c * p.du, p.v0 + r * p.dv)) continue;
    nAll++;
    const v = data[r * p.w + c];
    if (!Number.isFinite(v)) continue;
    n++; s += v; s2 += v * v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const mean = n ? s / n : null;
  return { mean, std: n > 1 ? Math.sqrt(Math.max(0, (s2 - n * mean! * mean!) / (n - 1))) : null,
           min: n ? mn : null, max: n ? mx : null, n, nAll, du: p.du, dv: p.dv };
}
const polyArea = (poly: number[][], ua: number, va: number) =>
  Math.abs(poly.reduce((a, q, i) => { const r = poly[(i + 1) % poly.length]; return a + q[ua] * r[va] - r[ua] * q[va]; }, 0)) / 2;
type RegionSeries = { label: string; rows: { id: string; unit: string; t: number[]; mean: (number | null)[]; std: (number | null)[] }[] };
// "10-20; 30-" -> [[10, 20], [30, Infinity]]; blank = the whole run
const parseIntervals = (s: string): [number, number][] => {
  const out = s.split(/[;,]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(-?[\d.eE+]*)\s*(?:-|to|\u2013)\s*(-?[\d.eE+]*)$/);
    if (!m) return null;
    const a = m[1] === "" ? -Infinity : Number(m[1]), b = m[2] === "" ? Infinity : Number(m[2]);
    return Number.isFinite(a) || Number.isFinite(b) ? [a, b] as [number, number] : null;
  }).filter((x): x is [number, number] => !!x && !Number.isNaN(x[0]) && !Number.isNaN(x[1]) && x[0] <= x[1]);
  return out.length ? out : [[-Infinity, Infinity]];
};

const SHAPES: [RegionShape, string][] = [["rectangle", "rectangle (drag corner to corner)"], ["square", "square (drag corner to corner)"],
  ["circle", "circle (drag from the centre)"], ["polygon", "polygon (click corners)"]];
// outline of a dragged shape from press point a to the current point b on an axis-normal plane
function shapeRegion(shape: RegionShape, a: number[], b: number[], axis: number): { pts: number[][]; info: string } | null {
  const [ua, va] = [0, 1, 2].filter((x) => x !== axis);
  const at = (u: number, v: number) => { const p = [...a]; p[ua] = u; p[va] = v; return p; };
  let du = b[ua] - a[ua], dv = b[va] - a[va];
  if (shape === "circle") {
    const r = Math.hypot(du, dv);
    if (!(r > 0)) return null;
    const n = 96;
    return { pts: Array.from({ length: n }, (_, i) => at(a[ua] + r * Math.cos((2 * Math.PI * i) / n), a[va] + r * Math.sin((2 * Math.PI * i) / n))),
             info: `circle, centre ${AXES[ua]} = ${fmt(a[ua])}, ${AXES[va]} = ${fmt(a[va])} m, radius ${fmt(r)} m` };
  }
  if (shape === "square") {
    const s = Math.max(Math.abs(du), Math.abs(dv));
    du = Math.sign(du || 1) * s;
    dv = Math.sign(dv || 1) * s;
  }
  if (!du || !dv) return null;
  const [u0, u1] = [Math.min(a[ua], a[ua] + du), Math.max(a[ua], a[ua] + du)];
  const [v0, v1] = [Math.min(a[va], a[va] + dv), Math.max(a[va], a[va] + dv)];
  return { pts: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)],
           info: `${shape}, ${AXES[ua]} ${fmt(u0)} to ${fmt(u1)} m, ${AXES[va]} ${fmt(v0)} to ${fmt(v1)} m` };
}
// in-plane axes [u, v] (u across, v up on the 2D pane) of the plane normal to each axis, as the server's PLANE_AXES
const PLANE_UV: [number, number][] = [[2, 1], [0, 2], [0, 1]];
// centre [u, v] of a plane along its own in-plane axes (uAxis, vAxis)
const planeCentreOf = (p: Plane): [number, number] => [p.u0 + ((p.w - 1) / 2) * p.du, p.v0 + ((p.h - 1) / 2) * p.dv];
// outline of a typed shape on the plane normal to axis at pos: size a (diameter / side / length) along
// world axis ua and b (width) along va, centred at (cu, cv) on those axes
function typedRegion(shape: RegionShape, axis: number, ua: number, va: number, pos: number,
                     a: number, b: number, cu: number, cv: number) {
  const pt = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = pos; p[ua] = u; p[va] = v; return p; };
  return shape === "circle" ? shapeRegion("circle", pt(cu, cv), pt(cu + a / 2, cv), axis)
    : shapeRegion(shape, pt(cu - a / 2, cv - b / 2), pt(cu + a / 2, cv + b / 2), axis);
}

export default function ViewerView({ project, onRefresh, active = true }: { project: Project; onRefresh: () => Promise<unknown>; active?: boolean }) {
  const cases = project.cases.filter((c) => c.included);
  const solves = useSolves(project.id, active);
  // first selected case is the reference: its outputs, times and 3D settings drive the view
  const [sel, setSel] = useState<string[]>(() => {
    const r = project.ref_case && cases.some((c) => c.id === project.ref_case) ? project.ref_case : cases[0]?.id;
    return r ? [r] : [];
  });
  const ref = sel[0] ?? "";
  const [invs, setInvs] = useState<Record<string, Inventory>>({});
  const requested = useRef(new Set<string>());
  const [layout, setLayout] = useState<"2d" | "3d" | "both">("both");
  const [kindName, setKindName] = useState("");
  const [ti, setTi] = useState(0);
  const [array, setArray] = useState("");
  const [compSel, setComp] = useState("mag");  // component picked for vector fields (see comp below)
  const [axis, setAxis] = useState(2);
  const [pos, setPos] = useState<number | null>(null);
  // tiF / posF = the frame and plane position that are fetched and shown: they follow the sliders
  // once those have rested for `wait` ms; buttons, typed values and playback apply at once
  const [tiF, setTiF] = useState(0);
  const [posF, setPosF] = useState<number | null>(null);
  const slow = useRef<{ ti?: number; pos?: number }>({});
  const setFrame = (i: number, wait = 0) => {
    setTi(i);
    clearTimeout(slow.current.ti);
    if (wait) slow.current.ti = window.setTimeout(() => setTiF(i), wait); else setTiF(i);
  };
  const setPlanePos = (p: number, wait = 0) => {
    setPos(p);
    clearTimeout(slow.current.pos);
    if (wait) slow.current.pos = window.setTimeout(() => setPosF(p), wait); else setPosF(p);
  };
  useEffect(() => () => { clearTimeout(slow.current.ti); clearTimeout(slow.current.pos); }, []);
  const [cmap, setCmap] = useState("turbo");
  const [cmaps, setCmaps] = useState<string[]>(["turbo"]);
  const [rangeMode, setRangeMode] = useState<RangeMode>("robust");
  const [manual, setManual] = useState<[number, number]>([0, 1]);
  const [log, setLog] = useState(false);
  const [mask, setMask] = useState(true);
  const [smooth, setSmooth] = useState(() => localStorage.getItem("mstar_post.viewer.smooth") === "1");
  useEffect(() => { localStorage.setItem("mstar_post.viewer.smooth", smooth ? "1" : "0"); }, [smooth]);
  const [planes, setPlanes] = useState<Record<string, Plane | null>>({});
  const [planesFor, setPlanesFor] = useState("");  // urlsKey whose planes have all arrived
  const [busy3d, setBusy3d] = useState<Record<string, number>>({});  // meshes still loading per 3D pane
  const [fps, setFps] = useState(() => Number(localStorage.getItem("mstar_post.viewer.fps")) || 4);
  useEffect(() => { localStorage.setItem("mstar_post.viewer.fps", String(fps)); }, [fps]);
  const lastAdvance = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  // superseded plane requests are given up, except in playback: its frames come back in the next loop
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const giveUp = (ac: AbortController) => { if (!playingRef.current) ac.abort(); };
  const [tool, setTool] = useState<Tool>("none");
  const [region, setRegion] = useState<(Region & { axis: number }) | null>(null);
  const [regionShape, setRegionShape] = useState<RegionShape>(() => (localStorage.getItem("mstar_post.viewer.regionShape") as RegionShape | null) ?? "rectangle");
  useEffect(() => { localStorage.setItem("mstar_post.viewer.regionShape", regionShape); }, [regionShape]);
  // typed shape size [m]: a = diameter / side / length (plane u axis, across the pane), b = width (v axis); cu, cv = centre
  const [sizeIn, setSizeIn] = useState({ a: "", b: "", cu: "", cv: "" });
  const [regionSeries, setRegionSeries] = useState<RegionSeries | "busy" | null>(null);
  const regionAsk = useRef(0);  // id of the newest region-series request; older answers are dropped
  const [probe, setProbe] = useState<[string, string, string]>(["", "", ""]);
  const [pointVals, setPointVals] = useState<Record<string, PointValue | string>>({});
  const [pointSeries, setPointSeries] = useState<{ p: number[]; label: string; rows: { id: string; t: number[]; v: (number | null)[] }[] } | "busy" | null>(null);
  const [profiles, setProfiles] = useState<Profiles | null>(null);
  const [gen, setGen] = useState(0);  // raised by Refresh: every plane, mesh and mean is read again
  // 3D state
  const [geo, setGeo] = useState<Record<string, { on: boolean; opacity: number }>>({});
  const [surf, setSurf] = useState<Record<string, SurfOpt>>({});
  const [detail, setDetail] = useState(() => Number(localStorage.getItem("mstar_post.viewer.detail")) || 250000);
  useEffect(() => { localStorage.setItem("mstar_post.viewer.detail", String(detail)); }, [detail]);
  const [iso, setIso] = useState({ on: false, array: "", level: 0.5 });
  const [planeIn3d, setPlaneIn3d] = useState(true);
  const [syncCams, setSyncCams] = useState(false);
  const camSync = useMemo(() => new CameraSync(), []);
  const [bg, setBg] = useState(() => localStorage.getItem("mstar_post.viewer.bg") ?? "#1e293b");
  useEffect(() => { localStorage.setItem("mstar_post.viewer.bg", bg); }, [bg]);
  const [flow, setFlow] = useState({
    vec: "", mode: "none" as FlowMode, density: 30, lineColor: "#ffffff", licL: 20, licScale: 2,
    licMode: "field" as "field" | "grey", stream3d: false, seeds3d: 20, color3d: "#202020",
  });
  const setF = (patch: Partial<typeof flow>) => setFlow((f) => ({ ...f, ...patch }));
  const [vecs, setVecs] = useState<Record<string, { url: string; plane: Plane } | null>>({});  // vector plane with its URL
  const [lics, setLics] = useState<Record<string, { key: string; out: Float32Array }>>({});  // LIC with the key it belongs to
  // center planes: x = cx and z = cz planes, y plane at the fluid-region center (or cy); on by default
  const [cp, setCp] = useState({ on: true, cx: 0, cz: 0, yAuto: true, cy: 0 });
  const [fluidC, setFluidC] = useState<Record<string, number[]>>({});  // fluid-region centre per case id
  const fluidReq = useRef(new Map<string, string | true>());  // per case id: the file asked last, true = final
  const [cplanes, setCplanes] = useState<Record<string, Plane[]>>({});
  const [extras, setExtras] = useState<Extra[]>([]);
  const extraSeq = useRef(0);  // keys of extra views are never used twice
  const [xPlanes, setXPlanes] = useState<Record<number, Plane | null>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const followLast = useRef(true);  // start on the newest frame; set again by Refresh when the last frame was shown

  const pathOf = (id: string) => cases.find((c) => c.id === id)?.path ?? "";
  const invA = invs[ref] ?? null;

  // Re-read the outputs of the shown cases (new time steps, fields) and keep every view setting.
  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    setNote(null);
    try {
      await onRefresh();  // reloads the project: the server drops its case-info and inventory caches
      const k = invs[ref]?.kinds.find((x) => x.kind === kindName);
      followLast.current = !!k && ti >= k.times.length - 1;
      const fresh = await Promise.all(sel.map(async (id) => [id, await api.inventory(pathOf(id))] as const));
      let added = 0;
      for (const [id, inv] of fresh) {
        const old = invs[id]?.kinds.find((x) => x.kind === kindName)?.times.length ?? 0;
        added += Math.max(0, (inv.kinds.find((x) => x.kind === kindName)?.times.length ?? 0) - old);
        setGeo((g) => ({ ...geoDefaults(inv), ...g }));
        setSurf((s) => ({ ...surfDefaults(inv), ...s }));
      }
      setInvs((m) => ({ ...m, ...Object.fromEntries(fresh) }));
      // files may have been written again under the same names: nothing read before is trusted
      clearPlaneCache();
      clearViewerCaches();
      clearLicCache();
      meanReq.current.clear();
      setVmeans({});
      setLics({});
      setGen((g) => g + 1);
      setNote(added ? `${added} new time step${added === 1 ? "" : "s"} of ${kindName}` : "no new time steps");
    } catch (e) { setError((e as Error).message); }
    setRefreshing(false);
  };
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(id);
  }, [note]);

  useEffect(() => { api.cmaps().then(setCmaps); }, []);
  useEffect(() => {
    for (const id of sel) {
      const p = pathOf(id);
      if (!p || requested.current.has(id)) continue;
      requested.current.add(id);
      api.inventory(p).then((inv) => {
        setInvs((m) => ({ ...m, [id]: inv }));
        setGeo((g) => ({ ...geoDefaults(inv), ...g }));
        setSurf((s) => ({ ...surfDefaults(inv), ...s }));
      }).catch((e) => { requested.current.delete(id); setError(`${id}: ${e.message}`); });
    }
  }, [sel.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!invA) return;
    const imgs = invA.kinds.filter((k) => k.type === "volume" || k.type === "slice");
    setKindName((cur) => imgs.some((k) => k.kind === cur) ? cur
      : (imgs.find((k) => k.kind === "Volume") ?? imgs.find((k) => k.type === "volume" && !/boundary/i.test(k.kind))
         ?? imgs.find((k) => k.type === "volume") ?? imgs[0])?.kind ?? "");
  }, [invA]);

  const kind = invA?.kinds.find((k) => k.kind === kindName);
  const arr = kind?.arrays.find((a) => a.name === array);
  // component in use: none for a scalar, else the picked one (magnitude when this field does not have it);
  // derived here, so a change of field never fetches with the component of the previous one first
  const comp = !arr ? compSel : arr.ncomp === 1 ? "" : compSel === "mag" || (compSel !== "" && Number(compSel) < arr.ncomp) ? compSel : "mag";
  const t = kind ? kind.times[Math.min(tiF, kind.times.length - 1)] : 0;  // time of the fetched frame

  useEffect(() => {
    if (!kind) return;
    if (!kind.arrays.some((a) => a.name === array)) {
      const pick = kind.arrays.find((a) => /^velocity magnitude/i.test(a.name))
        ?? kind.arrays.find((a) => /velocity/i.test(a.name) && a.ncomp === 1)
        ?? kind.arrays.find((a) => /velocity/i.test(a.name)) ?? kind.arrays[0];
      setArray(pick?.name ?? "");
    }
    const last = Math.max(0, kind.times.length - 1);
    if (followLast.current) {
      followLast.current = false;
      setFrame(last);
    } else setFrame(Math.min(ti, last));
    if (kind.type === "slice" && kind.slice_axis !== null) setAxis(kind.slice_axis);
    const ia = (volKindOf(invA, kind.kind) ?? kind).arrays, fr = ia.filter((a) => /volume fraction/i.test(a.name));
    setIso((s) => ({ ...s, array: s.array && ia.some((a) => a.name === s.array) ? s.array : (fr[fr.length - 1] ?? ia[0])?.name ?? "" }));
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const vecArrays = kind?.arrays.filter((a) => a.ncomp === 3) ?? [];
  useEffect(() => {
    if (vecArrays.length && !vecArrays.some((a) => a.name === flow.vec))
      setF({ vec: (vecArrays.find((a) => /velocity/i.test(a.name)) ?? vecArrays[0]).name });
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const isVolume = kind?.type === "volume";
  const [lo, hi] = kind && kind.extent ? bounds(kind, axis) : [0, 0];
  // the plane starts in the middle of a new output or normal axis; the two pickers below set it
  // together with the output / axis, so nothing is fetched at the old position first
  useEffect(() => { if (isVolume) setPlanePos((lo + hi) / 2); }, [kindName, axis, isVolume]); // eslint-disable-line react-hooks/exhaustive-deps
  const mid = (k: OutputKind | undefined, a: number) => {
    if (k?.type !== "volume" || !k.extent) return;
    const [l, h] = bounds(k, a);
    setPlanePos((l + h) / 2);
  };
  const pickAxis = (a: number) => { setAxis(a); mid(kind, a); };
  const pickKind = (name: string) => { setKindName(name); mid(invA?.kinds.find((k) => k.kind === name), axis); };

  const urlFor = (path: string, k: OutputKind | undefined, idx: number) =>
    k && array ? api.planeUrl(path, k.files[idx][0], array, comp, isVolume ? axis : null,
                              isVolume ? posF : null, mask, smooth) : null;
  // other cases show their output time nearest to the reference time
  const frameOf = (id: string): [OutputKind, number] | null => {
    const k = invs[id]?.kinds.find((x) => x.kind === kindName);
    if (!k || !k.times.length) return null;
    return [k, id === ref ? Math.min(tiF, k.times.length - 1) : nearest(k, t)];
  };
  const urls = sel.map((id) => { const f = frameOf(id); return f ? urlFor(pathOf(id), f[0], f[1]) : null; });
  const urlsKey = urls.join("\n");

  const shownExtras = extras.filter((e) => sel.includes(e.id));
  const extraArr = (e: Extra) => frameOf(e.id)?.[0].arrays.find((a) => a.name === e.array);
  const extraComp = (e: Extra) => ((extraArr(e)?.ncomp ?? 1) > 1 ? e.comp || "mag" : "");
  const extraUrls = shownExtras.map((e) => {
    const f = frameOf(e.id);
    return f && extraArr(e) ? api.planeUrl(pathOf(e.id), f[0].files[f[1]][0], e.array, extraComp(e),
      isVolume ? axis : null, isVolume ? posF : null, mask, smooth) : null;
  });
  const extraKey = JSON.stringify(shownExtras.map((e, i) => [e.key, extraUrls[i]]));
  useEffect(() => {
    if (layout === "3d" && !planeIn3d) return;
    let live = true;
    const ac = new AbortController();
    shownExtras.forEach((e, i) => {
      const u = extraUrls[i];
      if (!u) { setXPlanes((m) => ({ ...m, [e.key]: null })); return; }
      fetchPlane(u, ac.signal).then((p) => live && setXPlanes((m) => ({ ...m, [e.key]: p })))
        .catch((err) => live && !isAbort(err) && setError(`${e.id} (${e.array}): ${err.message}`));
    });
    return () => { live = false; giveUp(ac); };
  }, [extraKey, layout, planeIn3d, gen]); // eslint-disable-line react-hooks/exhaustive-deps
  // planes of cases and extra views that are no longer shown are let go
  useEffect(() => {
    const keep = <T,>(m: Record<string, T>, ok: (k: string) => boolean): Record<string, T> =>
      Object.keys(m).every(ok) ? m : Object.fromEntries(Object.entries(m).filter(([k]) => ok(k)));
    const on = (k: string) => sel.includes(k);
    setPlanes((m) => keep(m, on));
    setVecs((m) => keep(m, on));
    setLics((m) => keep(m, on));
    setCplanes((m) => keep(m, on));
    setXPlanes((m) => keep(m as Record<string, Plane | null>, (k) => extras.some((e) => String(e.key) === k)));
    setPointVals((m) => keep(m, (k) => (k.startsWith("m|") ? on(k.slice(2)) : extras.some((e) => `x|${e.key}` === k))));
  }, [sel.join("|"), extras.map((e) => e.key).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const addExtra = () => {
    const arrays = kind?.arrays ?? [];
    const used = new Set([array, ...extras.filter((e) => e.id === ref).map((e) => e.array)]);
    const pick = arrays.find((a) => !used.has(a.name)) ?? arrays[0];
    if (!pick) return;
    setExtras([...extras, { key: ++extraSeq.current, id: ref, array: pick.name,
                            comp: pick.ncomp > 1 ? "mag" : "", cmap, log: false, range: "shared", manual: [0, 1] }]);
  };
  const setExtra = (key: number, patch: Partial<Extra>) =>
    setExtras((xs) => xs.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  useEffect(() => {
    if (layout === "3d" && !planeIn3d) { setPlanesFor(urlsKey); return; }
    let live = true;
    const ac = new AbortController();
    setError(null);
    Promise.allSettled(sel.map((id, i) => {
      const u = urls[i];
      if (!u) { setPlanes((m) => ({ ...m, [id]: null })); return null; }
      return fetchPlane(u, ac.signal).then((p) => live && setPlanes((m) => ({ ...m, [id]: p })))
        .catch((e) => live && !isAbort(e) && setError(`${id}: ${e.message}`));
    })).then(() => live && setPlanesFor(urlsKey));
    return () => { live = false; giveUp(ac); };
  }, [urlsKey, layout, planeIn3d, gen]); // eslint-disable-line react-hooks/exhaustive-deps

  // global (fluid-volume) mean of the shown field per case and extra view, keyed by the mean URL.
  // A full-volume pass on the server: asked only for a frame that stays shown (not in playback, not
  // for frames passed while stepping); "busy" = asked, null = failed, missing = not asked (no legend line)
  const [vmeans, setVmeans] = useState<Record<string, { mean: number | null; mask: string } | "busy" | null>>({});
  const meanReq = useRef(new Set<string>());
  const meanKey = (id: string, arrName: string, c: string) => {
    const f = frameOf(id);
    return f && arrName && f[0].type === "volume" ? `${pathOf(id)}|${f[0].files[f[1]][0]}|${arrName}|${c}|${mask}` : null;
  };
  const meanKeys = [...sel.map((id) => meanKey(id, array, comp)),
                    ...shownExtras.map((e) => meanKey(e.id, e.array, extraComp(e)))].filter((k): k is string => !!k);
  useEffect(() => {
    if (playing) return;
    const timer = setTimeout(() => {
      for (const k of meanKeys) {
        if (meanReq.current.has(k)) continue;
        meanReq.current.add(k);
        setVmeans((v) => ({ ...v, [k]: "busy" }));
        const [path, file, arrName, c, m] = k.split("|");
        api.volumeMean(path, file, arrName, c, m === "true")
          .then((r) => setVmeans((v) => ({ ...v, [k]: { mean: r.mean, mask: r.mask } })))
          .catch(() => { meanReq.current.delete(k); setVmeans((v) => ({ ...v, [k]: null })); });
      }
    }, MEAN_WAIT);
    return () => clearTimeout(timer);
  }, [meanKeys.join("\n"), playing, gen]); // eslint-disable-line react-hooks/exhaustive-deps
  const meanNotes = (p: Plane | null, key: string | null): string[] => {
    const out: string[] = [];
    if (p && Number.isFinite(p.mean)) out.push(`plane mean ${fmt(p.mean, 4)}`);
    const g = key ? vmeans[key] : undefined;
    if (g === "busy") out.push("global mean ...");
    else if (g && typeof g.mean === "number") out.push(`global mean ${fmt(g.mean, 4)} (${g.mask === "none" ? "whole grid" : "fluid"})`);
    return out;
  };

  const cpFiles = sel.map((id) => {
    const f = frameOf(id);
    return cp.on && layout !== "2d" && f && f[0].type === "volume" && array ? f[0].files[f[1]][0] : null;
  });
  // fluid centre: read once per case (from the frame shown then) and reused for its other frames;
  // a file without fluid cells (at rest) only gives the grid centre, so the next frame is asked again
  useEffect(() => {
    if (!cp.on || !cp.yAuto) return;
    sel.forEach((id, i) => {
      const file = cpFiles[i], req = fluidReq.current, was = req.get(id);
      if (!file || was === true || was === file) return;
      req.set(id, file);
      api.fluidCenter(pathOf(id), file).then((r) => {
        if (req.get(id) === true) return;
        if (r.source !== "grid") req.set(id, true);
        setFluidC((m) => ({ ...m, [id]: r.center }));
      }).catch((e) => { if (req.get(id) === file) req.delete(id); setError(`${id} (fluid center): ${e.message}`); });
    });
  }, [cpFiles.join("\n"), cp.on, cp.yAuto]); // eslint-disable-line react-hooks/exhaustive-deps
  const cpUrlsOf = (id: string, file: string | null): string[] | null => {
    if (!file) return null;
    const yc = cp.yAuto ? fluidC[id]?.[1] : cp.cy;
    if (yc === undefined) return null;
    return [0, 1, 2].map((ax) => api.planeUrl(pathOf(id), file, array, comp, ax,
                                               [cp.cx, yc, cp.cz][ax], mask, smooth));
  };
  const cpUrls = sel.map((id, i) => cpUrlsOf(id, cpFiles[i]));
  const cpKey = JSON.stringify(cpUrls);
  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    sel.forEach((id, i) => {
      const us = cpUrls[i];
      // no center planes wanted: clear; fluid centre not known yet: the shown planes stay
      if (!us) { if (!cpFiles[i]) setCplanes((m) => ({ ...m, [id]: [] })); return; }
      Promise.all(us.map((u) => fetchPlane(u, ac.signal)))
        .then((ps) => live && setCplanes((m) => ({ ...m, [id]: ps })))
        .catch((e) => live && !isAbort(e) && setError(`${id} (center planes): ${e.message}`));
    });
    return () => { live = false; giveUp(ac); };
  }, [cpKey, cpFiles.map((f) => !!f).join(), gen]); // eslint-disable-line react-hooks/exhaustive-deps

  // in-plane vector planes for streamlines / LIC
  const vecOk = vecArrays.some((a) => a.name === flow.vec);
  const want2d = flow.mode !== "none" && vecOk;
  const vecUrls = sel.map((id) => {
    const f = frameOf(id);
    return want2d && f ? api.planeVecUrl(pathOf(id), f[0].files[f[1]][0], flow.vec,
                                         isVolume ? axis : null, isVolume ? posF : null, mask) : null;
  });
  const vecKey = vecUrls.join("\n");
  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    sel.forEach((id, i) => {
      const u = vecUrls[i];
      if (!u) { setVecs((m) => ({ ...m, [id]: null })); return; }
      fetchPlane(u, ac.signal).then((p) => live && setVecs((m) => ({ ...m, [id]: { url: u, plane: p } })))
        .catch((e) => live && !isAbort(e) && setError(`${id} (vector): ${e.message}`));
    });
    return () => { live = false; giveUp(ac); };
  }, [vecKey, gen]); // eslint-disable-line react-hooks/exhaustive-deps
  // the planes on screen are never dropped from the plane cache
  useEffect(() => {
    holdPlanes([...urls, ...extraUrls, ...cpUrls.flatMap((u) => u ?? []), ...vecUrls].filter((u): u is string => !!u));
  }, [urlsKey, extraKey, cpKey, vecKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => holdPlanes([]), []);
  const showLines = flow.mode === "lines" || flow.mode === "both";
  const showLic = flow.mode === "lic" || flow.mode === "both";
  const lines2d = useMemo(() => Object.fromEntries(sel.map((id) => {
    const p = vecs[id]?.plane;
    return [id, p && showLines ? streamlinesOf(p, flow.density) : null];
  })), [vecs, showLines, flow.density, sel.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  // LIC of the vector plane of each case (owner = the case: an image not started yet is dropped
  // when the case asks for another one); kept with the key it was computed for
  const licKey = (u: string) => `${u}|${flow.licScale}|${flow.licL}`;
  useEffect(() => {
    if (!showLic) { setLics((m) => (Object.keys(m).length ? {} : m)); return; }
    let live = true;
    sel.forEach((id, i) => {
      // only the vector plane of the current URL: the LIC is cached by that URL
      const v = vecs[id], u = vecUrls[i];
      if (!v || !u || v.url !== u) return;
      const key = licKey(u);
      runLic(u, toVec2(v.plane), flow.licScale, flow.licL, id)
        .then((out) => live && setLics((m) => (m[id]?.out === out ? m : { ...m, [id]: { key, out } })), () => undefined);
    });
    return () => { live = false; };
  }, [vecs, showLic, flow.licScale, flow.licL, gen]); // eslint-disable-line react-hooks/exhaustive-deps
  // The LIC to draw: only the one of the vector plane and of the field plane that are shown.
  // A LIC of another frame is never drawn; until its own is there the plane is shown unshaded.
  const licOf = (id: string): Float32Array | null => {
    const i = sel.indexOf(id), u = vecUrls[i], v = vecs[id], pu = urls[i];
    if (!showLic || !u || !v || v.url !== u || !pu || planeNow(pu) !== planes[id]) return null;
    const cur = lics[id];
    return cur && cur.key === licKey(u) ? cur.out : licNow(u, flow.licScale, flow.licL);
  };
  const overlayOf = (id: string): Overlay | undefined => flow.mode === "none" ? undefined : {
    lines: lines2d[id], lic: licOf(id), licScale: flow.licScale,
    licMode: flow.licMode, lineColor: flow.lineColor,
  };

  // 3D streamlines seeded on the plane; colored by speed when the field is that vector's magnitude
  const lines3d: Record<string, LineLayer[]> = Object.fromEntries(sel.map((id) => {
    const f = frameOf(id);
    if (!flow.stream3d || !vecOk || !f || f[0].type !== "volume") return [id, []];
    return [id, [{ key: "stream", url: api.streamlinesUrl(pathOf(id), f[0].files[f[1]][0], flow.vec, axis, posF,
                                                           flow.seeds3d, f[0].file_size > 4e8 ? 2 : 1),
                   color: array === flow.vec && comp === "mag" ? null : flow.color3d, cmap, range: [0, 0], log }]];
  }));
  const lines3dKey = JSON.stringify(lines3d);

  // Everything a frame shows, asked for ahead of time and kept in the caches: the planes of the main
  // rows and extra views, the centre planes, the vector planes (with their LIC when `lic`) and the 3D
  // meshes. The promises settle when the assets are there or have failed.
  const fetchAhead = (frame: number, lic: boolean): Promise<unknown>[] => {
    if (!kind) return [];
    const tt = kind.times[frame], jobs: Promise<unknown>[] = [], withPlanes = layout !== "3d" || planeIn3d;
    const get = (u: string | null) => { if (u) jobs.push(fetchPlane(u)); };
    sel.forEach((id) => {
      const k = invs[id]?.kinds.find((x) => x.kind === kindName);
      if (!k || !k.times.length) return;
      const idx = id === ref ? Math.min(frame, k.times.length - 1) : nearest(k, tt), file = k.files[idx][0], path = pathOf(id);
      if (withPlanes) {
        get(urlFor(path, k, idx));
        for (const e of shownExtras) {
          const a = e.id === id ? k.arrays.find((x) => x.name === e.array) : undefined;
          if (a) get(api.planeUrl(path, file, e.array, a.ncomp > 1 ? e.comp || "mag" : "", isVolume ? axis : null, isVolume ? posF : null, mask, smooth));
        }
      }
      if (cp.on && layout !== "2d" && k.type === "volume" && array) cpUrlsOf(id, file)?.forEach(get);
      if (want2d) {
        const vu = api.planeVecUrl(path, file, flow.vec, isVolume ? axis : null, isVolume ? posF : null, mask);
        jobs.push(lic && showLic ? fetchPlane(vu).then((p) => runLic(vu, toVec2(p), flow.licScale, flow.licL, id)) : fetchPlane(vu));
      }
    });
    if (layout !== "2d") Object.values(buildLayers(tt)).flat().forEach((l) => { if (l.visible && l.key !== "iso") jobs.push(prefetchMesh(l.url)); });
    return jobs;
  };

  // playback: the next frame is shown when the current one is complete (planes of every case and
  // all 3D meshes) and everything the next one shows has arrived (fetchAhead: also its extra views,
  // centre planes, vector planes and LIC), at most `fps` frames per second. So a frame appears
  // whole, with the LIC of its own vector plane; the frame after it is fetched meanwhile.
  const busyTotal = Object.values(busy3d).reduce((a, b) => a + b, 0);
  const [ahead, setAhead] = useState("");  // key of the next frame whose assets have settled
  useEffect(() => {
    if (!playing || !kind) return;
    if (planesFor !== urlsKey || (layout !== "2d" && busyTotal > 0)) return;
    const n = kind.times.length;
    const next = (ti + 1) % n;
    const key = [next, urlsKey, extraKey, cpKey, vecKey, showLic, flow.licScale, flow.licL, layout, planeIn3d, gen].join("\n");
    if (ahead !== key) {
      let live = true;
      Promise.allSettled(fetchAhead(next, true)).then(() => live && setAhead(key));
      Promise.allSettled(fetchAhead((ti + 2) % n, false));
      return () => { live = false; };
    }
    const wait = Math.max(0, 1000 / fps - (performance.now() - lastAdvance.current));
    const id = setTimeout(() => { lastAdvance.current = performance.now(); setFrame(next); }, wait);
    return () => clearTimeout(id);
  }, [playing, planesFor, urlsKey, busyTotal, ti, kind, layout, fps, ahead, extraKey, cpKey, vecKey, showLic, flow.licScale, flow.licL, planeIn3d, gen]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = sel.map((id) => planes[id]).filter((p): p is Plane => !!p);
  // a plane without fluid cells (all masked) has no range of its own: it is left out of shared ranges
  const ranged = shown.filter((p) => hasFinite(p.data));
  const rangeKey = ranged.map((p) => `${p.p01},${p.p99},${p.vmin},${p.vmax}`).join("|");
  const baseRange: [number, number] = useMemo(() => {
    if (rangeMode === "manual" || !ranged.length) return manual;
    return rangeMode === "robust"
      ? [Math.min(...ranged.map((p) => p.p01)), Math.max(...ranged.map((p) => p.p99))]
      : [Math.min(...ranged.map((p) => p.vmin)), Math.max(...ranged.map((p) => p.vmax))];
  }, [rangeMode, manual, rangeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // log scale: a lower bound <= 0 is replaced by one positive bound from the shown planes, and
  // this range goes to the colours and the legends alike (same array while the values are the same)
  const rangeRef = useRef<[number, number]>(baseRange);
  const range: [number, number] = useMemo(() => {
    const r = log ? logRange(baseRange, shown.map((p) => p.data)) : baseRange, k = rangeRef.current;
    return r[0] === k[0] && r[1] === k[1] ? k : (rangeRef.current = r);
  }, [baseRange, log, planes, sel.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  // "shared": views of the same field share one color range (with the main rows when it is the main field)
  const rangeRaw = (e: Extra): [number, number] => {
    const p = xPlanes[e.key];
    const lg = (r: [number, number], ps: Plane[]) => (e.log ? logRange(r, ps.map((q) => q.data)) : r);
    if (e.range === "manual") return lg(e.manual, p ? [p] : []);
    const span = (ps: Plane[], mode: RangeMode): [number, number] => mode === "auto"
      ? [Math.min(...ps.map((p) => p.vmin)), Math.max(...ps.map((p) => p.vmax))]
      : [Math.min(...ps.map((p) => p.p01)), Math.max(...ps.map((p) => p.p99))];
    if (e.range !== "shared") return p ? lg(span([p], e.range), [p]) : [0, 1];
    const same = (x: Extra) => x.range === "shared" && x.array === e.array && extraComp(x) === extraComp(e);
    if (e.array === array && extraComp(e) === comp) return e.log === log ? range : lg(baseRange, shown);
    const ps = shownExtras.filter(same).map((x) => xPlanes[x.key]).filter((p): p is Plane => !!p && hasFinite(p.data));
    return ps.length ? lg(span(ps, rangeMode === "auto" ? "auto" : "robust"), ps) : [0, 1];
  };
  // the same array as long as the values are the same, so an unrelated render does not recolor the view
  const extraRanges = useRef(new Map<number, [number, number]>());
  const rangeOf = (e: Extra): [number, number] => {
    const r = rangeRaw(e), k = extraRanges.current.get(e.key);
    if (k && k[0] === r[0] && k[1] === r[1]) return k;
    extraRanges.current.set(e.key, r);
    return r;
  };
  const labelOf = (name: string, c: string, ncomp: number) =>
    `${name}${ncomp > 1 ? (c === "mag" ? " |mag|" : ` (${AXES[Number(c)] ?? c})`) : ""}`;

  // Line profile along a picked line. It is read again when the field or the frame changes (the line
  // stays) and dropped when the plane changes; an answer for an older state is not shown.
  const lineAsk = useRef(0);
  const lineKey = JSON.stringify([sel.map((id) => { const f = frameOf(id); return f ? f[0].files[f[1]][0] : null; }), array, comp]);
  const onLine = async (p0: number[], p1: number[]) => {
    const ask = ++lineAsk.current, key = lineKey, label = labelOf(array, comp, arr?.ncomp ?? 1);
    try {
      const out = await Promise.all(sel.map(async (id) => {
        const f = frameOf(id);
        if (!f) return null;
        return { id, ...await api.line(pathOf(id), f[0].files[f[1]][0], array, comp, p0, p1) };
      }));
      if (ask === lineAsk.current) setProfiles({ p0, p1, label, key, rows: out.filter((x): x is Profile => !!x) });
    } catch (e) { if (ask === lineAsk.current) setError((e as Error).message); }
  };
  useEffect(() => { if (profiles && profiles.key !== lineKey) onLine(profiles.p0, profiles.p1); }, [lineKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { lineAsk.current++; setProfiles(null); }, [kindName, axis, posF]);

  // 3D layers per case at time tt; geometry/surface toggles are shared by name
  const buildLayers = (tt: number): Record<string, MeshLayer[]> => Object.fromEntries(sel.map((id) => {
    const inv = invs[id], path = pathOf(id);
    if (!inv) return [id, []];
    const out: MeshLayer[] = inv.geometry.map((g, i) => ({
      key: `geo:${g.name}`, url: api.surfaceUrl(path, g.file), color: layerColor(i),
      opacity: geo[g.name]?.opacity ?? 0.5, visible: !!geo[g.name]?.on,
    }));
    inv.kinds.filter((k) => k.type === "surface" && surf[k.kind]?.on).forEach((k) => {
      const idx = nearest(k, tt);
      const o = surf[k.kind];
      k.files[idx].forEach((f, j) => out.push({
        key: `surf:${k.kind}:${j}`, url: api.surfaceUrl(path, f, detail, "mesh"),
        color: o.color, opacity: o.opacity, visible: true, smooth: isVof(k.kind),
      }));
    });
    const vol = volKindOf(inv, kindName), a = vol?.arrays.find((x) => x.name === iso.array);
    if (iso.on && vol && a) {  // not while the array is one of another output (just switched)
      out.push({ key: "iso", url: api.isoUrl(path, vol.files[nearest(vol, tt)][0], iso.array,
        a.ncomp > 1 ? "mag" : "", iso.level, vol.file_size > 4e8 ? 2 : 1, detail),
        color: "#e07b39", opacity: 0.85, visible: true, smooth: true });
    }
    return [id, out];
  }));
  const layersBy: Record<string, MeshLayer[]> = useMemo(() => buildLayers(t),
    [sel.join("|"), invs, geo, surf, iso, t, detail, kindName]); // eslint-disable-line react-hooks/exhaustive-deps

  // surfaces of other time steps: the server converts the 40 frames around the current one in
  // the background (re-requested when the time moves more than 15 frames from the last warm-up)
  // and the browser preloads the next frame, so stepping in time is quick
  const surfKinds = Object.entries(surf).filter(([, o]) => o.on).map(([k]) => k).join("|");
  const warmed = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!surfKinds || layout === "2d") return;
    for (const id of sel) {
      const inv = invs[id];
      if (!inv) continue;
      for (const k of inv.kinds.filter((x) => x.type === "surface" && surf[x.kind]?.on)) {
        const i0 = nearest(k, t);
        const wk = `${id}|${k.kind}|${detail}`;
        if (Math.abs((warmed.current[wk] ?? -1e9) - i0) > 15) {
          warmed.current[wk] = i0;
          const order = [...k.files.keys()].sort((a, b) => Math.abs(a - i0) - Math.abs(b - i0));
          api.surfaceWarm(pathOf(id), order.slice(0, 40).flatMap((i) => k.files[i]), detail).catch(() => undefined);
        }
        if (i0 + 1 < k.files.length) k.files[i0 + 1].forEach((f) => prefetchMesh(api.surfaceUrl(pathOf(id), f, detail, "mesh")));
      }
    }
  }, [surfKinds, detail, layout, sel.join("|"), invs, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const lines3dBy: Record<string, LineLayer[]> = useMemo(() => Object.fromEntries(Object.entries(lines3d)
    .map(([id, ls]) => [id, ls.map((l) => ({ ...l, range }))])), [lines3dKey, range]); // eslint-disable-line react-hooks/exhaustive-deps

  // region average: a polygon drawn on the plane, applied to every pane with the same normal axis
  const addRegionPoint = (p: number[]) => setRegion((r) => {
    if (!r || r.closed || r.axis !== axis) return { axis, pts: [p], closed: false, shape: "polygon" };
    const last = r.pts[r.pts.length - 1];
    return last.every((x, i) => x === p[i]) ? r : { ...r, pts: [...r.pts, p] };
  });
  // the plane the typed shape goes on: its real in-plane axes (u across, v up on the 2D pane; for an
  // x-normal plane u = z, v = y), the centre [u, v] of the shown plane and its normal position
  const refPlane = planes[ref] ?? null;
  const onAxis = refPlane && refPlane.axis === axis ? refPlane : null;
  const [sua, sva] = onAxis ? [onAxis.uAxis, onAxis.vAxis] : PLANE_UV[axis];
  const planeCentre = onAxis ? planeCentreOf(onAxis) : null;
  const dragRegion = (a: number[], b: number[], done: boolean) => {
    const s = shapeRegion(regionShape, a, b, axis);
    if (!s) { if (done) setRegion(null); return; }
    setRegion({ axis, pts: s.pts, closed: done, shape: regionShape, info: s.info });
    if (done) {
      setTool("none");
      const us = s.pts.map((p) => p[sua]), vs = s.pts.map((p) => p[sva]);
      const num = (x: number) => String(Number(x.toPrecision(5)));
      setSizeIn({ a: num(Math.max(...us) - Math.min(...us)), b: num(Math.max(...vs) - Math.min(...vs)),
                  cu: num(regionShape === "circle" ? a[sua] : (Math.max(...us) + Math.min(...us)) / 2),
                  cv: num(regionShape === "circle" ? a[sva] : (Math.max(...vs) + Math.min(...vs)) / 2) });
    }
  };
  const placeRegion = () => {
    const a = Number(sizeIn.a), b = regionShape === "rectangle" ? Number(sizeIn.b) : a;
    const cu = sizeIn.cu.trim() === "" ? planeCentre?.[0] : Number(sizeIn.cu);
    const cv = sizeIn.cv.trim() === "" ? planeCentre?.[1] : Number(sizeIn.cv);
    if (!(a > 0) || !(b > 0) || cu === undefined || cv === undefined || !Number.isFinite(cu) || !Number.isFinite(cv)) return;
    const s = typedRegion(regionShape, axis, sua, sva, onAxis?.pos ?? pos ?? 0, a, b, cu, cv);
    if (!s) return;
    setRegion({ axis, pts: s.pts, closed: true, shape: regionShape, info: s.info });
    setTool((t) => (t === "region" ? "none" : t));
  };
  const sizeOk = Number(sizeIn.a) > 0 && (regionShape !== "rectangle" || Number(sizeIn.b) > 0) && (!!planeCentre || (sizeIn.cu !== "" && sizeIn.cv !== ""));
  const closeRegion = () => {
    if (!region || region.pts.length < 3) return;
    setRegion({ ...region, closed: true });
    setTool("none");
  };
  const clearRegion = () => {
    setRegion(null);
    setTool((t) => (t === "region" ? "none" : t));
  };
  const pickPoint = (p: number[]) => {
    setProbe(p.map((x) => String(Number(x.toPrecision(6)))) as [string, string, string]);
    setTool("none");
  };
  const regionFor = (p: Plane | null) => (region && p && region.axis === p.axis ? region : null);
  // region mean in every frame of the shown cases (main field); dropped when the region or the field
  // changes, and an answer that arrives after such a change (or after a newer request) is not shown
  useEffect(() => { regionAsk.current++; setRegionSeries(null); }, [region, array, comp, mask, smooth, kindName, axis, posF, sel.join("|")]);
  const closeRegionSeries = () => { regionAsk.current++; setRegionSeries(null); };
  const regionOverTime = async () => {
    if (!region?.closed) return;
    const ask = ++regionAsk.current;
    setRegionSeries("busy");
    try {
      const rowsOut = await Promise.all(sel.map(async (id) => {
        const k = invs[id]?.kinds.find((x) => x.kind === kindName);
        const p = planes[id];
        if (!k || !array || !p || p.axis !== region.axis) return null;
        const r = await api.regionSeries(pathOf(id), k.files.map((f) => f[0]), array, comp, isVolume ? axis : null,
          isVolume ? posF : null, region.pts.map((q) => [q[p.uAxis], q[p.vAxis]]), mask, smooth);
        return { id, unit: r.frames[0]?.unit ?? p.unit, t: r.frames.map((f, i) => f.time ?? k.times[i]),
                 mean: r.frames.map((f) => f.mean), std: r.frames.map((f) => f.std) };
      }));
      if (ask === regionAsk.current) setRegionSeries({ label: fieldLabel, rows: rowsOut.filter((x): x is NonNullable<typeof x> => !!x) });
    } catch (e) { if (ask === regionAsk.current) { setError((e as Error).message); setRegionSeries(null); } }
  };
  // with smooth shading the statistics are of the values that are drawn (cmap.smoothed), as the hover readout
  const regionRows = useMemo(() => {
    if (!region?.closed) return [];
    const rowsOut: { id: string; label: string; unit: string; s: RegionStats }[] = [];
    const stats = (p: Plane) => regionStats(p, region.pts, smooth ? smoothed(p.data, p.w, p.h) : p.data);
    sel.forEach((id) => { const p = planes[id]; if (p && p.axis === region.axis) rowsOut.push({ id, label: labelOf(array, comp, arr?.ncomp ?? 1), unit: p.unit, s: stats(p) }); });
    shownExtras.forEach((e) => {
      const p = xPlanes[e.key];
      if (p && p.axis === region.axis) rowsOut.push({ id: e.id, label: labelOf(e.array, extraComp(e), extraArr(e)?.ncomp ?? 1), unit: p.unit, s: stats(p) });
    });
    return rowsOut;
  }, [region, planes, xPlanes, sel.join("|"), extraKey, array, comp, smooth]); // eslint-disable-line react-hooks/exhaustive-deps

  // point probe: value of the cell nearest to (x, y, z) in the current frame of every shown case and extra view
  const probeP = useMemo(() => (probe.every((s) => s.trim() !== "" && Number.isFinite(Number(s))) ? probe.map(Number) : null), [probe]);
  const pointReqs = probeP ? [
    ...sel.map((id) => ({ key: `m|${id}`, id, array, comp, label: labelOf(array, comp, arr?.ncomp ?? 1) })),
    ...shownExtras.map((e) => ({ key: `x|${e.key}`, id: e.id, array: e.array, comp: extraComp(e),
                                 label: labelOf(e.array, extraComp(e), extraArr(e)?.ncomp ?? 1) })),
  ].flatMap((q) => { const f = frameOf(q.id); return f && q.array ? [{ ...q, file: f[0].files[f[1]][0] }] : []; }) : [];
  const pointKey = JSON.stringify([probeP, mask, pointReqs.map((q) => [q.key, q.file, q.array, q.comp])]);
  useEffect(() => {
    if (!probeP) return;
    let live = true;
    pointReqs.forEach((q) => api.point(pathOf(q.id), [q.file], q.array, q.comp, probeP, mask)
      .then((r) => live && setPointVals((m) => ({ ...m, [q.key]: r.points[0] })))
      .catch((e) => live && setPointVals((m) => ({ ...m, [q.key]: (e as Error).message }))));
    return () => { live = false; };
  }, [pointKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // the field at the point in every frame; kept with the field it was read for, an answer after a
  // newer request (or Clear) is not shown
  const pointAsk = useRef(0);
  const pointOverTime = async () => {
    if (!probeP) return;
    const ask = ++pointAsk.current, label = fieldLabel;
    setPointSeries("busy");
    try {
      const rowsOut = await Promise.all(sel.map(async (id) => {
        const k = invs[id]?.kinds.find((x) => x.kind === kindName);
        if (!k || !array) return null;
        const r = await api.point(pathOf(id), k.files.map((f) => f[0]), array, comp, probeP, mask);
        return { id, t: k.times, v: r.points.map((x) => x.value) };
      }));
      if (ask === pointAsk.current) setPointSeries({ p: probeP, label, rows: rowsOut.filter((x): x is NonNullable<typeof x> => !!x) });
    } catch (e) { if (ask === pointAsk.current) { setError((e as Error).message); setPointSeries(null); } }
  };
  const closePointSeries = () => { pointAsk.current++; setPointSeries(null); };
  const markerFor = (p: Plane | null) => probeP && p
    && Math.abs(probeP[p.axis] - p.pos) <= 0.5 * (kind?.spacing?.[p.axis] ?? Math.max(p.du, p.dv)) + 1e-12 ? probeP : null;

  // One set of callbacks for the life of the view: the panes are memoised, so their props must not
  // change with every render; each callback runs the latest closure.
  const act = useRef({ onLine, addRegionPoint, closeRegion, dragRegion, pickPoint });
  act.current = { onLine, addRegionPoint, closeRegion, dragRegion, pickPoint };
  const cb = useMemo(() => ({
    onLine: (p0: number[], p1: number[]) => { act.current.onLine(p0, p1); },
    onRegionPoint: (p: number[]) => act.current.addRegionPoint(p),
    onRegionClose: () => act.current.closeRegion(),
    onRegionDrag: (a: number[], b: number[], done: boolean) => act.current.dragRegion(a, b, done),
    onPoint: (p: number[]) => act.current.pickPoint(p),
  }), []);
  const onLoading3d = useCallback((n: number, key?: string) =>
    setBusy3d((b) => (key === undefined || b[key] === n ? b : { ...b, [key]: n })), []);
  const profilePlot = useMemo(() => profiles && {
    data: profiles.rows.map((p) => ({ type: "scatter" as const, mode: "lines" as const, x: p.distance, y: p.value, name: p.id })),
    layout: { xaxis: { title: { text: "distance [m]" } },
              yaxis: { title: { text: `${profiles.label} [${profiles.rows[0]?.unit || "-"}]` } } },
  }, [profiles]);

  if (!cases.length) return <div className="panel muted">Include at least one case on the Cases tab.</div>;
  const imgKinds = invA?.kinds.filter((k) => k.type === "volume" || k.type === "slice") ?? [];
  const volKind = volKindOf(invA, kindName);  // output of the isosurface
  const n = sel.length;
  const rows = n + shownExtras.length;
  const both = layout === "both";
  const paneH = rows === 1 ? (both ? 480 : 620) : rows === 2 ? (both ? 400 : 440) : 330;
  const fieldLabel = `${array}${arr && arr.ncomp > 1 ? (comp === "mag" ? " |mag|" : ` (${AXES[Number(comp)] ?? comp})`) : ""}`;
  const legendFor = (id: string) => array ? { label: fieldLabel, unit: planes[id]?.unit ?? arr?.unit ?? "",
                                              notes: meanNotes(planes[id] ?? null, meanKey(id, array, comp)) } : undefined;

  return (
    <div className="split">
      <div className="side controls">
        <div className="row">
          <span className="grow small muted">{note}</span>
          <button onClick={refresh} disabled={refreshing}
                  title="re-read the outputs of the shown cases (new time steps, fields) and keep the current view; moves to the newest frame when the last one is shown">
            {refreshing ? "Refreshing..." : "Refresh"}</button>
        </div>
        <Section id="cases" title={`Cases (max ${MAX_CASES})`}>
          <div className="checklist">
            {cases.map((c) => {
              const on = sel.includes(c.id);
              return (
                <div key={c.id} className="row small">
                  <label className="grow"><input type="checkbox" checked={on}
                    disabled={on ? n === 1 : n >= MAX_CASES}
                    onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} />
                    <span className="mono">{c.id}</span></label>
                  {solves?.[c.id] && solves[c.id].state !== "complete" && solves[c.id].state !== "no log" && <SolveTag s={solves[c.id]} />}
                  {on && (c.id === ref ? <span className="tag">ref</span>
                    : <button title="use as reference (outputs, time, 3D settings)"
                              onClick={() => setSel([c.id, ...sel.filter((x) => x !== c.id)])}>ref</button>)}
                </div>
              );
            })}
          </div>
        </Section>
        <label>View <select value={layout} onChange={(e) => setLayout(e.target.value as typeof layout)}>
          <option value="both">2D + 3D</option><option value="2d">2D</option><option value="3d">3D</option></select></label>
        {!invA && <div className="muted">scanning outputs...</div>}
        {invA && !imgKinds.length && <div className="muted">No .vti volume or slice output found.</div>}
        {!!imgKinds.length && (
          <Section id="plane" title="Plane">
            <label>Output <select value={kindName} onChange={(e) => pickKind(e.target.value)}>
              {imgKinds.map((k) => <option key={k.kind} value={k.kind}>{k.kind} ({k.type}, {k.times.length})</option>)}
            </select></label>
            {kind && (
              <>
                <SliderNum label={`Time [s] (${ti + 1}/${kind.times.length})`} min={0} max={kind.times.length - 1} step={1}
                           value={ti} onChange={(v) => setFrame(v, SLIDER_WAIT)} num={kind.times[Math.min(ti, kind.times.length - 1)]}
                           numMin={kind.times[0]} numMax={kind.times[kind.times.length - 1]}
                           onNum={(v) => setFrame(nearest(kind, v))} title="time [s]; snaps to the nearest output time" />
                <div className="row">
                  <button onClick={() => setFrame(Math.max(0, ti - 1))}>&lt;</button>
                  <button onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
                  <button onClick={() => setFrame(Math.min(kind.times.length - 1, ti + 1))}>&gt;</button>
                  <button onClick={() => setFrame(kind.times.length - 1)}>Last</button>
                  <select value={fps} title="playback speed; a frame waits for its planes and 3D surfaces, so large surfaces play slower"
                          onChange={(e) => setFps(Number(e.target.value))}>
                    {[1, 2, 4, 8, 15].map((f) => <option key={f} value={f}>{f} fps</option>)}</select>
                </div>
                <label>Field <select value={array} onChange={(e) => setArray(e.target.value)}>
                  {kind.arrays.map((a) => <option key={a.name}>{a.name}</option>)}</select></label>
                {arr && arr.ncomp > 1 && (
                  <label>Component <select value={comp} onChange={(e) => setComp(e.target.value)}>
                    <option value="mag">magnitude</option>
                    {Array.from({ length: arr.ncomp }, (_, i) => <option key={i} value={String(i)}>{AXES[i] ?? i}</option>)}
                  </select></label>
                )}
                {isVolume ? (
                  <>
                    <label>Normal <select value={axis} onChange={(e) => pickAxis(Number(e.target.value))}>
                      {AXES.map((a, i) => <option key={a} value={i}>{a}</option>)}</select></label>
                    <SliderNum label={`${AXES[axis]} [m]`} min={lo} max={hi} step={(hi - lo) / 500 || 1}
                               value={pos ?? lo} onChange={(v) => setPlanePos(v, SLIDER_WAIT)} onNum={(v) => setPlanePos(v)} />
                  </>
                ) : <div className="small muted">slice normal {AXES[kind.slice_axis ?? 0]} at {fmt(kind.slice_pos)} m</div>}
                <label>Colormap <select value={cmap} onChange={(e) => setCmap(e.target.value)}>
                  {cmaps.map((c) => <option key={c}>{c}</option>)}</select></label>
                <label>Range <select value={rangeMode} onChange={(e) => {
                  const m = e.target.value as RangeMode;
                  if (m === "manual") setManual(range);
                  setRangeMode(m);
                }}>
                  <option value="robust">1-99th percentile</option>
                  <option value="auto">min-max</option>
                  <option value="manual">manual (locked)</option></select></label>
                {rangeMode === "manual" && (
                  <div className="row">
                    <input type="number" step="any" value={manual[0]} onChange={(e) => setManual([Number(e.target.value), manual[1]])} />
                    <input type="number" step="any" value={manual[1]} onChange={(e) => setManual([manual[0], Number(e.target.value)])} />
                  </div>
                )}
                <label><input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} /> log scale</label>
                <label title="blank cells that hold no liquid: solids, outside the vessel and (free surface) the headspace. Fluid = the volume fractions (two-fluid output), else a non-zero velocity. The plane and global means use the same cells.">
                  <input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} /> mask non-fluid cells</label>
                <label title="VTK-style cell-to-point shading as in M-Star Post: 1-2-1 average over the neighbouring cells in all three directions, then bilinear interpolation; solid edges stay sharp. Hover values are then smoothed too; the line probe stays raw.">
                  <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} /> smooth shading</label>
                <label title="what a click on the 2D plane does">Click tool <select value={tool} onChange={(e) => setTool(e.target.value as Tool)}>
                  <option value="none">none (drag pans when zoomed)</option>
                  <option value="line">line profile (2 clicks)</option>
                  <option value="region">region average (draw a shape)</option>
                  <option value="point">point probe (pick x, y, z)</option></select></label>
              </>
            )}
          </Section>
        )}
        {kind && (
          <Section id="probes" title="Region and point">
            <div className="small"><b>Region average</b>{" "}
              <span className="muted">{region ? `${region.info ?? `polygon, ${region.pts.length} corners`}${region.closed ? "" : " (drawing)"}, ${AXES[region.axis]}-normal planes`
                : "none: pick a shape, press Draw region and draw it on a 2D pane"}</span></div>
            <label className="small">Shape <select value={regionShape} onChange={(e) => setRegionShape(e.target.value as RegionShape)}>
              {SHAPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            {regionShape !== "polygon" && (
              <div className="size-grid small" title="or type the size and centre and press Place; drawing a shape fills these in">
                <span>{regionShape === "circle" ? "diameter" : regionShape === "square" ? "side" : `length (${AXES[sua]})`} [m]</span>
                <input type="number" step="any" min={0} className="short" value={sizeIn.a} onChange={(e) => setSizeIn({ ...sizeIn, a: e.target.value })} />
                {regionShape === "rectangle" && <>
                  <span>width ({AXES[sva]}) [m]</span>
                  <input type="number" step="any" min={0} className="short" value={sizeIn.b} onChange={(e) => setSizeIn({ ...sizeIn, b: e.target.value })} /></>}
                <span>centre {AXES[sua]}, {AXES[sva]} [m]</span>
                <span className="row">
                  <input type="number" step="any" className="short" value={sizeIn.cu} placeholder={planeCentre ? fmt(planeCentre[0]) : AXES[sua]}
                         onChange={(e) => setSizeIn({ ...sizeIn, cu: e.target.value })} />
                  <input type="number" step="any" className="short" value={sizeIn.cv} placeholder={planeCentre ? fmt(planeCentre[1]) : AXES[sva]}
                         onChange={(e) => setSizeIn({ ...sizeIn, cv: e.target.value })} /></span>
                <span />
                <span className="row">
                  <button className="primary" disabled={!sizeOk} onClick={placeRegion}
                          title={`place the ${regionShape} on the ${AXES[axis]}-normal plane (blank centre = plane centre)`}>Place</button>
                  {planeCentre && <button onClick={() => setSizeIn({ ...sizeIn, cu: String(Number(planeCentre[0].toPrecision(5))), cv: String(Number(planeCentre[1].toPrecision(5))) })}
                                          title="centre of the shown plane">plane centre</button>}
                </span>
              </div>
            )}
            <div className="row small">
              {tool === "region"
                ? <><span className="muted">{regionShape === "polygon" ? "click corners, double-click to close"
                    : `press, drag and release on a 2D pane${regionShape === "circle" ? " (start at the centre)" : ""}`}</span>
                    <button onClick={() => { setTool("none"); if (region && !region.closed) setRegion(null); }}>Cancel</button></>
                : <button onClick={() => { if (region) setRegion(null); setTool("region"); }}>{region ? "Draw new region" : "Draw region"}</button>}
              <button disabled={!region} onClick={clearRegion}>Clear region</button>
            </div>
            <div className="small"><b>Point probe</b> <span className="muted">x, y, z [m]; nearest cell</span></div>
            <div className="row small">
              {[0, 1, 2].map((i) => (
                <input key={i} type="number" step="any" className="short" placeholder={AXES[i]} value={probe[i]} title={`${AXES[i]} [m]`}
                       onChange={(e) => setProbe(probe.map((s, j) => (j === i ? e.target.value : s)) as [string, string, string])} />))}
            </div>
            <div className="row small">
              {tool === "point"
                ? <button onClick={() => setTool("none")} title="click a 2D pane to set the point">Cancel pick</button>
                : <button onClick={() => setTool("point")} title="then click a 2D pane">Pick on plane</button>}
              <button disabled={!probeP || pointSeries === "busy"} onClick={pointOverTime}
                      title="the field at this point in every frame of the shown cases">{pointSeries === "busy" ? "Reading frames..." : "Over time"}</button>
              <button disabled={!probe.some((s) => s)} onClick={() => { setProbe(["", "", ""]); setPointVals({}); closePointSeries(); }}>Clear</button>
            </div>
          </Section>
        )}
        {kind && vecArrays.length > 0 && (
          <Section id="flow" title="Flow" defaultOpen={false}>
            <label>Vector field <select value={flow.vec} onChange={(e) => setF({ vec: e.target.value })}>
              {vecArrays.map((a) => <option key={a.name}>{a.name}</option>)}</select></label>
            <label>2D overlay <select value={flow.mode} onChange={(e) => setF({ mode: e.target.value as FlowMode })}>
              <option value="none">none</option><option value="lines">streamlines</option>
              <option value="lic">LIC</option><option value="both">LIC + streamlines</option></select></label>
            {showLines && (
              <>
                <SliderNum label="Streamline density" min={10} max={60} step={1} value={flow.density}
                           onChange={(v) => setF({ density: Math.round(v) })} />
                <label>Line color <select value={flow.lineColor} onChange={(e) => setF({ lineColor: e.target.value })}>
                  <option value="#ffffff">white</option><option value="#000000">black</option>
                  <option value="#808080">grey</option></select></label>
              </>
            )}
            {showLic && (
              <>
                <SliderNum label="LIC length" min={5} max={40} step={1} value={flow.licL}
                           onChange={(v) => setF({ licL: Math.round(v) })} />
                <label>LIC resolution <select value={flow.licScale} onChange={(e) => setF({ licScale: Number(e.target.value) })}>
                  <option value={1}>1x</option><option value={2}>2x</option><option value={3}>3x</option></select></label>
                <label>LIC color <select value={flow.licMode} onChange={(e) => setF({ licMode: e.target.value as "field" | "grey" })}>
                  <option value="field">field colormap</option><option value="grey">grey</option></select></label>
              </>
            )}
            {isVolume && (
              <>
                <label><input type="checkbox" checked={flow.stream3d} onChange={(e) => setF({ stream3d: e.target.checked })} /> 3D streamlines (seeded on the plane)</label>
                {flow.stream3d && (
                  <>
                    <SliderNum label="Seeds per side" min={5} max={40} step={1} value={flow.seeds3d}
                               onChange={(v) => setF({ seeds3d: Math.round(v) })} />
                    <label>3D line color <input type="color" value={flow.color3d}
                                               onChange={(e) => setF({ color3d: e.target.value })} /></label>
                    <div className="small muted">colored by speed when the field is this vector's magnitude</div>
                  </>
                )}
              </>
            )}
          </Section>
        )}
        {kind && (
          <Section id="extras" title={`Extra views (${shownExtras.length})`}>
            <div className="small muted">More fields side by side: same output, time and plane. Range "shared": views of the same field share a color range (the main one for the main field).</div>
            {extras.map((e) => {
              const k = frameOf(e.id)?.[0];
              const a = k?.arrays.find((x) => x.name === e.array);
              return (
                <div key={e.key} className="extra-view">
                  <div className="row small">
                    <select value={e.id} title="case" onChange={(ev) => setExtra(e.key, { id: ev.target.value })}>
                      {sel.map((id) => <option key={id} value={id}>{id}</option>)}
                      {!sel.includes(e.id) && <option value={e.id}>{e.id} (not selected)</option>}
                    </select>
                    <button title="remove view" onClick={() => setExtras(extras.filter((x) => x.key !== e.key))}>&times;</button>
                  </div>
                  <div className="row small">
                    <select value={e.array} title="field" onChange={(ev) => {
                      const na = k?.arrays.find((x) => x.name === ev.target.value);
                      setExtra(e.key, { array: ev.target.value, comp: na && na.ncomp > 1 ? "mag" : "" });
                    }}>
                      {!a && <option value={e.array}>{e.array} (missing)</option>}
                      {k?.arrays.map((x) => <option key={x.name}>{x.name}</option>)}
                    </select>
                    {a && a.ncomp > 1 && (
                      <select value={e.comp || "mag"} title="component" onChange={(ev) => setExtra(e.key, { comp: ev.target.value })}>
                        <option value="mag">mag</option>
                        {Array.from({ length: a.ncomp }, (_, i) => <option key={i} value={String(i)}>{AXES[i] ?? i}</option>)}
                      </select>
                    )}
                  </div>
                  <div className="row small">
                    <select value={e.cmap} title="colormap" onChange={(ev) => setExtra(e.key, { cmap: ev.target.value })}>
                      {cmaps.map((c) => <option key={c}>{c}</option>)}</select>
                    <label><input type="checkbox" checked={e.log} onChange={(ev) => setExtra(e.key, { log: ev.target.checked })} /> log</label>
                  </div>
                  <div className="row small">
                    <select value={e.range} title="color range" onChange={(ev) => {
                      const m = ev.target.value as ExtraRange;
                      setExtra(e.key, m === "manual" ? { range: m, manual: rangeOf(e) } : { range: m });
                    }}>
                      <option value="shared">range: shared</option>
                      <option value="robust">range: own 1-99th pct</option>
                      <option value="auto">range: own min-max</option>
                      <option value="manual">range: manual</option>
                    </select>
                  </div>
                  {e.range === "manual" && (
                    <div className="row small">
                      <input type="number" step="any" className="short" value={e.manual[0]} title="min"
                             onChange={(ev) => setExtra(e.key, { manual: [Number(ev.target.value), e.manual[1]] })} />
                      <input type="number" step="any" className="short" value={e.manual[1]} title="max"
                             onChange={(ev) => setExtra(e.key, { manual: [e.manual[0], Number(ev.target.value)] })} />
                    </div>
                  )}
                </div>
              );
            })}
            <button disabled={extras.length >= MAX_EXTRAS} onClick={addExtra}>+ Add view</button>
          </Section>
        )}
        {invA && layout !== "2d" && (
          <Section id="3d" title="3D">
            <label><input type="checkbox" checked={planeIn3d} onChange={(e) => setPlaneIn3d(e.target.checked)} /> plane</label>
            {volKind && (
              <>
                <label title="planes normal to x, y and z through one point"><input type="checkbox" checked={cp.on}
                  onChange={(e) => setCp({ ...cp, on: e.target.checked })} /> center planes (all 3 axes)</label>
                {cp.on && (
                  <div className="cp-grid small">
                    <span>x [m]</span><input type="number" step="any" value={cp.cx}
                                            onChange={(e) => setCp({ ...cp, cx: Number(e.target.value) })} />
                    <span>z [m]</span><input type="number" step="any" value={cp.cz}
                                            onChange={(e) => setCp({ ...cp, cz: Number(e.target.value) })} />
                    <span>y [m]</span>
                    <span><label><input type="checkbox" checked={cp.yAuto}
                      onChange={(e) => setCp({ ...cp, yAuto: e.target.checked })} /> fluid center</label>
                      {cp.yAuto ? <span className="muted"> {fmt(fluidC[ref]?.[1])}</span>
                        : <input type="number" step="any" value={cp.cy}
                                 onChange={(e) => setCp({ ...cp, cy: Number(e.target.value) })} />}</span>
                  </div>
                )}
              </>
            )}
            {rows > 1 && <label><input type="checkbox" checked={syncCams} onChange={(e) => setSyncCams(e.target.checked)} /> link cameras</label>}
            <div className="row small">Background <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />
              {BG_PRESETS.map((c) => <button key={c} className="swatch" style={{ background: c }} title={c}
                                             onClick={() => setBg(c)} />)}</div>
            {invA.geometry.map((g) => (
              <div key={g.name} className="row small">
                <label className="grow"><input type="checkbox" checked={!!geo[g.name]?.on}
                  onChange={(e) => setGeo({ ...geo, [g.name]: { ...geo[g.name], on: e.target.checked } })} />
                  <span title={g.file}>{g.name}</span></label>
                <SliderNum inline min={0.05} max={1} step={0.05} value={geo[g.name]?.opacity ?? 0.5} title="opacity"
                           onChange={(v) => setGeo({ ...geo, [g.name]: { ...geo[g.name], opacity: v } })} />
              </div>
            ))}
            {invA.kinds.filter((k) => k.type === "surface").map((k) => {
              const o = surf[k.kind] ?? { on: false, color: "#9a9a9a", opacity: 1 };
              const set = (p: Partial<SurfOpt>) => setSurf({ ...surf, [k.kind]: { ...o, ...p } });
              return (
                <div key={k.kind} className="row small">
                  <label className="grow"><input type="checkbox" checked={o.on} onChange={(e) => set({ on: e.target.checked })} />{k.kind}
                    <span className="muted"> ({(k.file_size / 1e6).toFixed(0)} MB)</span></label>
                  <input type="color" value={o.color} title="surface color" onChange={(e) => set({ color: e.target.value })} />
                  <SliderNum inline min={0.05} max={1} step={0.05} value={o.opacity} title="opacity" onChange={(v) => set({ opacity: v })} />
                </div>
              );
            })}
            {invA.kinds.some((k) => k.type === "surface") && (
              <label title="triangle budget of output surfaces and isosurfaces: lower loads and draws faster">Surface detail <select value={detail} onChange={(e) => setDetail(Number(e.target.value))}>
                {DETAIL.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>)}
            {volKind && (
              <>
                <label className="small"><input type="checkbox" checked={iso.on}
                  onChange={(e) => setIso({ ...iso, on: e.target.checked })} /> isosurface</label>
                {iso.on && (
                  <>
                    <select value={iso.array} onChange={(e) => setIso({ ...iso, array: e.target.value })}>
                      {volKind.arrays.map((a) => <option key={a.name}>{a.name}</option>)}</select>
                    <input type="number" step="any" value={iso.level}
                           onChange={(e) => setIso({ ...iso, level: Number(e.target.value) })} />
                  </>
                )}
              </>
            )}
            <div className="small muted">surfaces use the time step nearest to {fmt(t)} s</div>
          </Section>
        )}
      </div>
      <div className="main">
        {error && <div className="error">{error}</div>}
        <div className="viewer-wrap">
          <div className={`viewer-grid${!both && rows > 1 ? " cols2" : ""}`}>
            {sel.map((id) => {
              const has = !!invs[id]?.kinds.some((k) => k.kind === kindName);
              const legend = legendFor(id);
              return (
                <div key={id} className="viewer-case">
                  <div className="slice-title">{id}{id === ref && n > 1 ? " (reference)" : ""}
                    {invs[id] && !has && <span className="muted"> - no '{kindName}' output</span>}</div>
                  <div className={`viewer-row${both ? " both" : ""}`}>
                    {layout !== "3d" && (
                      <SliceCanvas plane={planes[id] ?? null} cmap={cmap} range={range} log={log} height={paneH}
                                   tool={tool} onLine={cb.onLine} legend={legend} overlay={overlayOf(id)}
                                   region={regionFor(planes[id] ?? null)} onRegionPoint={cb.onRegionPoint} onRegionClose={cb.onRegionClose}
                                   regionShape={regionShape} onRegionDrag={cb.onRegionDrag}
                                   onPoint={cb.onPoint}
                                   marker={markerFor(planes[id] ?? null)}
                                   background={bg} smooth={smooth}
                                   exportName={`${id}_${kindName}_t${fmt(t)}`} />
                    )}
                    {layout !== "2d" && invs[id] && (
                      <Viewer3D layers={layersBy[id] ?? NO_LAYERS} plane={planeIn3d ? planes[id] ?? null : null}
                                cmap={cmap} range={range} log={log} height={paneH} background={bg} smooth={smooth}
                                legend={legend} overlay={overlayOf(id)} lines={lines3dBy[id]}
                                extraPlanes={cp.on ? cplanes[id] : undefined}
                                exportName={`${id}_3d_t${fmt(t)}`}
                                onLoading={onLoading3d} loadKey={id} reload={gen}
                                sync={syncCams && rows > 1 ? camSync : undefined} />
                    )}
                  </div>
                </div>
              );
            })}
            {shownExtras.map((e) => {
              const a = extraArr(e);
              const p = xPlanes[e.key] ?? null;
              const lab = labelOf(e.array, extraComp(e), a?.ncomp ?? 1);
              const lg = { label: lab, unit: p?.unit ?? a?.unit ?? "", notes: meanNotes(p, meanKey(e.id, e.array, extraComp(e))) };
              const r = rangeOf(e);
              return (
                <div key={`x${e.key}`} className="viewer-case">
                  <div className="slice-title">{e.id} - {lab}
                    {!a && <span className="muted"> - field not in this case's '{kindName}' output</span>}</div>
                  <div className={`viewer-row${both ? " both" : ""}`}>
                    {layout !== "3d" && (
                      <SliceCanvas plane={p} cmap={e.cmap} range={r} log={e.log} height={paneH}
                                   tool={tool === "line" ? "none" : tool} onLine={cb.onLine} legend={lg} overlay={overlayOf(e.id)}
                                   region={regionFor(p)} onRegionPoint={cb.onRegionPoint} onRegionClose={cb.onRegionClose}
                                   regionShape={regionShape} onRegionDrag={cb.onRegionDrag}
                                   onPoint={cb.onPoint}
                                   marker={markerFor(p)}
                                   background={bg} smooth={smooth} exportName={`${e.id}_${e.array}_t${fmt(t)}`} />
                    )}
                    {layout !== "2d" && invs[e.id] && (
                      <Viewer3D layers={layersBy[e.id] ?? NO_LAYERS} plane={planeIn3d ? p : null}
                                cmap={e.cmap} range={r} log={e.log} height={paneH} background={bg} smooth={smooth}
                                legend={lg} overlay={overlayOf(e.id)}
                                exportName={`${e.id}_${e.array}_3d_t${fmt(t)}`}
                                onLoading={onLoading3d} loadKey={`x${e.key}`} reload={gen}
                                sync={syncCams ? camSync : undefined} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {region?.closed && (
          <RegionCard rows={regionRows} region={region} t={t} smooth={smooth} onClear={clearRegion}
                      series={regionSeries} onOverTime={regionOverTime} onCloseSeries={closeRegionSeries}
                      nFrames={kind?.times.length ?? 0} />
        )}
        {probeP && (
          <PointCard p={probeP} t={t} rows={pointReqs.map((q) => ({ key: q.key, id: q.id, label: q.label, r: pointVals[q.key] }))}
                     series={pointSeries} onCloseSeries={closePointSeries} />
        )}
        {profiles && profilePlot && (
          <div className="card">
            <div className="row"><b className="grow">Line profile of {profiles.label}</b>
              <button onClick={() => download("line_profile.csv", toCsv(
                ["distance_m", ...profiles.rows.map((p) => p.id)],
                profiles.rows[0]?.distance.map((d, i) => [d, ...profiles.rows.map((p) => p.value[i])]) ?? []))}>Export CSV</button>
              <button onClick={() => { lineAsk.current++; setProfiles(null); }}>Close</button></div>
            <Plot height={300} exportName="line_profile" data={profilePlot.data} layout={profilePlot.layout} />
          </div>
        )}
      </div>
    </div>
  );
}

// Slider with a numeric box; the box commits on Enter or blur, clamped to its range.
// num/onNum let the box show a different quantity than the slider (e.g. time for a frame index).
function SliderNum({ label, min, max, step, value, onChange, num, numMin, numMax, onNum, title, inline }: {
  label?: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void;
  num?: number; numMin?: number; numMax?: number; onNum?: (v: number) => void; title?: string; inline?: boolean;
}) {
  const shownNum = num ?? value;
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (draft.trim() === "" || !Number.isFinite(v)) return;
    const c = Math.min(numMax ?? max, Math.max(numMin ?? min, v));
    (onNum ?? onChange)(c);
  };
  const body = (
    <span className={`slider-num${inline ? " inline" : ""}`} title={title}>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={(e) => onChange(Number(e.target.value))} />
      <input type="number" step="any" value={draft ?? String(Number(shownNum.toPrecision(6)))}
             onChange={(e) => setDraft(e.target.value)} onBlur={commit}
             onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setDraft(null); }} />
    </span>
  );
  return label ? <label>{label}{body}</label> : body;
}

// Region average results: one row per pane of the region's plane orientation, plus the region mean over time.
function RegionCard({ rows, region, t, smooth, onClear, series, onOverTime, onCloseSeries, nFrames }: {
  rows: { id: string; label: string; unit: string; s: RegionStats }[];
  region: Region & { axis: number }; t: number; smooth: boolean; onClear: () => void;
  series: RegionSeries | "busy" | null; onOverTime: () => void; onCloseSeries: () => void; nFrames: number;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const [intervals, setIntervals] = useState("");
  const [band, setBand] = useState(false);
  const [ua, va] = [0, 1, 2].filter((a) => a !== region.axis);
  const polyA = polyArea(region.pts, ua, va);
  const header = ["case", "field", "unit", "mean", "std", "min", "max", "fluid cells [count]", "fluid area [m^2]",
                  "region area (cells) [m^2]", "fluid share [%]"];
  const table = rows.map((r) => {
    const cellA = r.s.du * r.s.dv;
    return [r.id, r.label, r.unit, r.s.mean, r.s.std, r.s.min, r.s.max, r.s.n, r.s.n * cellA, r.s.nAll * cellA,
            r.s.nAll ? (100 * r.s.n) / r.s.nAll : null];
  });
  const copy = async () => {
    setCopied(await copyText([header, ...table].map((r) => r.map((v) => (v === null ? "" : String(v))).join("\t")).join("\n")));
    setTimeout(() => setCopied(null), 1500);
  };
  const s = series && series !== "busy" ? series : null;
  const ivs = parseIntervals(intervals);
  const tAll = s ? s.rows.flatMap((r) => r.t) : [];
  const tMin = tAll.length ? Math.min(...tAll) : 0, tMax = tAll.length ? Math.max(...tAll) : 0;
  const preset = (frac: number) => setIntervals(frac >= 1 ? "" : `${Number((tMax - frac * (tMax - tMin)).toPrecision(4))}-`);
  const ivLabel = ([a, b]: [number, number]) => `${Number.isFinite(a) ? fmt(a) : fmt(tMin)} to ${Number.isFinite(b) ? fmt(b) : fmt(tMax)} s`;
  const ivHeader = ["case", "field", "interval", "time-mean of region mean", "std over time", "CoV [%]", "min", "max", "frames [count]"];
  const ivTable = s ? s.rows.flatMap((r) => ivs.map((iv) => {
    const v = r.mean.filter((x, i): x is number => x !== null && r.t[i] >= iv[0] && r.t[i] <= iv[1]);
    const m = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    const sd = m !== null && v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : null;
    return [r.id, `${s.label} [${r.unit}]`, ivLabel(iv), m, sd, m && sd !== null ? (100 * sd) / Math.abs(m) : null,
            v.length ? Math.min(...v) : null, v.length ? Math.max(...v) : null, v.length];
  })) : [];
  const copyIv = async () => {
    setCopied(await copyText([ivHeader, ...ivTable].map((r) => r.map((v) => (v === null ? "" : String(v))).join("\t")).join("\n")));
    setTimeout(() => setCopied(null), 1500);
  };
  // the figure is rebuilt only when its data, the intervals or the time marker change
  const plot = useMemo(() => s && {
    data: s.rows.flatMap((r, ci) => {
      const lines: Plotly.Data[] = [{ type: "scatter", mode: "lines+markers", x: r.t, y: r.mean, name: r.id, legendgroup: r.id,
                                      marker: { size: 4 }, line: { color: PALETTE[ci % PALETTE.length] } }];
      if (band) lines.push({ type: "scatter", mode: "lines", x: [...r.t, ...[...r.t].reverse()], legendgroup: r.id, showlegend: false,
        y: [...r.mean.map((m, i) => (m === null || r.std[i] === null ? null : m + r.std[i]!)),
            ...r.mean.map((m, i) => (m === null || r.std[i] === null ? null : m - r.std[i]!)).reverse()],
        fill: "toself", line: { width: 0 }, fillcolor: PALETTE[ci % PALETTE.length] + "33", hoverinfo: "skip" });
      return lines;
    }),
    layout: {
      xaxis: { title: { text: "time [s]" } }, yaxis: { title: { text: `region mean ${s.label} [${s.rows[0]?.unit ?? ""}]` } },
      legend: { orientation: "h" as const, y: 1.02, yanchor: "bottom" as const }, margin: { t: 30, r: 20, b: 50, l: 80 },
      shapes: [
        ...(intervals.trim() ? ivs.map((iv) => ({ type: "rect" as const, xref: "x" as const, yref: "paper" as const,
          x0: Number.isFinite(iv[0]) ? iv[0] : tMin, x1: Number.isFinite(iv[1]) ? iv[1] : tMax, y0: 0, y1: 1,
          fillcolor: "rgba(120,160,220,0.15)", line: { width: 0 } })) : []),
        { type: "line" as const, x0: t, x1: t, yref: "paper" as const, y0: 0, y1: 1, line: { dash: "dot" as const, color: "grey" } }],
    },
  }, [s, band, intervals, t]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card">
      <div className="row"><b className="grow">Region average</b>
        <button onClick={copy}>{copied === null ? "Copy table" : copied ? "Copied" : "Copy failed"}</button>
        <button onClick={() => download("region_average.csv", toCsv(header, table))}>Export CSV</button>
        <button onClick={onClear}>Clear</button></div>
      <div className="small muted">
        Mean over the fluid cells of the current plane whose centres lie inside the region ({region.info ?? `polygon, ${region.pts.length} corners`},
        area {fmt(polyA, 4)} m^2, {AXES[region.axis]}-normal) at t = {fmt(t)} s. Cells are equal in size, so this
        is the area-weighted mean; solid (masked) cells are left out.{smooth ? " Smooth shading is on: the table uses the values that are drawn (each cell averaged 1-2-1 with its neighbours in the plane and in the two neighbouring layers), as the hover readout. The time course below is computed by the server from the cells averaged with the two neighbouring layers only, so its value at this time can differ slightly from the table." : ""}
      </div>
      <div className="tablewrap">
        <table className="grid">
          <thead><tr>{header.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{table.map((r, i) => (
            <tr key={i}>{r.map((v, j) => j < 3 ? <td key={j} className={j ? "small" : "mono"}>{v}</td>
              : <td key={j} className="num">{fmt(v as number | null)}</td>)}</tr>))}
            {!rows.length && <tr><td colSpan={header.length} className="muted">no plane with this orientation is shown</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button disabled={series === "busy" || !rows.length} onClick={onOverTime}
                title={`region mean of the main field in all ${nFrames} frames of the shown cases (same plane and region)`}>
          {series === "busy" ? "Reading frames..." : s ? "Recompute over time" : "Region mean over time"}</button>
        {s && <button onClick={onCloseSeries}>Close time course</button>}
      </div>
      {s && (
        <>
          <div className="row small">
            <label title="one or more intervals [s], e.g. '10-20; 30-' (blank = whole run; open ends allowed)">Averaging intervals [s]{" "}
              <input className="wide" value={intervals} placeholder="whole run, e.g. 10-20; 30-" onChange={(e) => setIntervals(e.target.value)} /></label>
            <button onClick={() => preset(1)}>whole run</button>
            <button onClick={() => preset(0.5)}>last 50%</button>
            <button onClick={() => preset(0.25)}>last 25%</button>
            <label><input type="checkbox" checked={band} onChange={(e) => setBand(e.target.checked)} /> &plusmn; spatial std band</label>
          </div>
          {plot && <Plot height={320} exportName="region_mean_series" data={plot.data} layout={plot.layout} />}
          <div className="row small">
            <b className="grow">Mean over the interval{ivs.length > 1 ? "s" : ""}</b>
            <button onClick={copyIv}>{copied === null ? "Copy table" : copied ? "Copied" : "Copy failed"}</button>
            <button onClick={() => download("region_interval_means.csv", toCsv(ivHeader, ivTable))}>Export CSV</button>
            <button onClick={() => download("region_mean_series.csv", toCsv(["case", "time [s]", `region mean ${s.label}`, "spatial std"],
              s.rows.flatMap((r) => r.t.map((tt, i) => [r.id, tt, r.mean[i], r.std[i]]))))}>Time course CSV</button>
          </div>
          <div className="tablewrap">
            <table className="grid">
              <thead><tr>{ivHeader.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{ivTable.map((r, i) => (
                <tr key={i}>{r.map((v, j) => j < 3 ? <td key={j} className={j ? "small" : "mono"}>{v}</td>
                  : <td key={j} className="num">{fmt(v as number | null)}</td>)}</tr>))}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
const PALETTE = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b"];

// Point probe results for the current frame, plus the optional time series at the point.
function PointCard({ p, t, rows, series, onCloseSeries }: {
  p: number[]; t: number; onCloseSeries: () => void;
  rows: { key: string; id: string; label: string; r: PointValue | string | undefined }[];
  series: { p: number[]; label: string; rows: { id: string; t: number[]; v: (number | null)[] }[] } | "busy" | null;
}) {
  const status = (r: PointValue) => !r.inside ? "outside the output grid" : r.solid ? "not fluid (solid, outside or headspace)" : "";
  const header = ["case", "field", "value", "unit", "cell centre x [m]", "cell centre y [m]", "cell centre z [m]", "note"];
  const table = rows.map((x) => typeof x.r === "object"
    ? [x.id, x.label, x.r.value, x.r.unit, ...x.r.center, status(x.r)]
    : [x.id, x.label, null, "", null, null, null, x.r ?? "loading..."]);
  const s = series && series !== "busy" ? series : null;
  // the series keeps the field it was read for (s.label); the figure is rebuilt only for new data or time
  const plot = useMemo(() => s && {
    data: s.rows.map((r) => ({ type: "scatter" as const, mode: "lines+markers" as const, x: r.t, y: r.v, name: r.id })),
    layout: { xaxis: { title: { text: "time [s]" } }, yaxis: { title: { text: s.label } },
              shapes: [{ type: "line" as const, x0: t, x1: t, yref: "paper" as const, y0: 0, y1: 1, line: { dash: "dot" as const, color: "grey" } }] },
  }, [s, t]);
  return (
    <div className="card">
      <div className="row"><b className="grow">Point probe at ({p.map((v) => fmt(v)).join(", ")}) m, t = {fmt(t)} s</b>
        <button onClick={() => download("point_probe.csv", toCsv(header, table))}>Export CSV</button></div>
      <div className="small muted">Value of the cell nearest to the point (cell data, no interpolation); the marker shows on 2D panes whose plane contains it.</div>
      <div className="tablewrap">
        <table className="grid">
          <thead><tr>{header.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{table.map((r, i) => (
            <tr key={i}>{r.map((v, j) => typeof v === "number" || v === null
              ? <td key={j} className="num">{fmt(v)}</td> : <td key={j} className={j ? "small" : "mono"}>{v}</td>)}</tr>))}</tbody>
        </table>
      </div>
      {s && plot && (
        <>
          <div className="row"><b className="grow">{s.label} at ({s.p.map((v) => fmt(v)).join(", ")}) m over time</b>
            <button onClick={() => download("point_series.csv", toCsv(["case", "time [s]", s.label],
              s.rows.flatMap((r) => r.t.map((tt, i) => [r.id, tt, r.v[i]]))))}>Export CSV</button>
            <button onClick={onCloseSeries}>Close</button></div>
          <Plot height={300} exportName="point_series" data={plot.data} layout={plot.layout} />
        </>
      )}
    </div>
  );
}

// Collapsible sidebar section; open state remembered in localStorage.
function Section({ id, title, defaultOpen = true, children }: {
  id: string; title: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const key = `mstar_post.viewer.section.${id}`;
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(key);
    return v === null ? defaultOpen : v === "1";
  });
  const toggle = () => setOpen((o) => { localStorage.setItem(key, o ? "0" : "1"); return !o; });
  return (
    <fieldset className={`section${open ? "" : " closed"}`}>
      <legend onClick={toggle} title={open ? "collapse" : "expand"}>{open ? "\u25be" : "\u25b8"} {title}</legend>
      {open && children}
    </fieldset>
  );
}
