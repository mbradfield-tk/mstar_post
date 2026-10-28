import { useEffect, useMemo, useRef, useState } from "react";
import { api, AXES, download, fmt, toCsv, type Inventory, type OutputKind, type Project } from "./api";
import { SolveTag, useSolves } from "./CasesView";
import { traceStreamlines, type Vec2 } from "./flow";
import { runLic } from "./lic";
import { fetchPlane, type Plane } from "./plane";
import Plot from "./Plot";
import SliceCanvas, { type Overlay } from "./SliceCanvas";
import Viewer3D, { CameraSync, layerColor, prefetchMesh, type LineLayer, type MeshLayer } from "./Viewer3D";

const MAX_CASES = 4;
const BG_PRESETS = ["#f4f6f9", "#ffffff", "#808080", "#000000", "#1e293b"];
type FlowMode = "none" | "lines" | "lic" | "both";
const toVec2 = (p: Plane): Vec2 => ({ w: p.w, h: p.h, du: p.du, dv: p.dv,
  u: p.data.subarray(0, p.w * p.h), v: p.data.subarray(p.w * p.h, 2 * p.w * p.h) });
type RangeMode = "auto" | "robust" | "manual";
type Profile = { id: string; distance: number[]; value: (number | null)[]; unit: string };
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
  const [comp, setComp] = useState("mag");
  const [axis, setAxis] = useState(2);
  const [pos, setPos] = useState<number | null>(null);
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
  const [lineMode, setLineMode] = useState(false);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
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
  const [vecs, setVecs] = useState<Record<string, Plane | null>>({});
  const [lics, setLics] = useState<Record<string, Float32Array>>({});
  // center planes: x = cx and z = cz planes, y plane at the fluid-region center (or cy); on by default
  const [cp, setCp] = useState({ on: true, cx: 0, cz: 0, yAuto: true, cy: 0 });
  const [fluidC, setFluidC] = useState<Record<string, number[]>>({});
  const [cplanes, setCplanes] = useState<Record<string, Plane[]>>({});
  const [extras, setExtras] = useState<Extra[]>([]);
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
  const t = kind ? kind.times[Math.min(ti, kind.times.length - 1)] : 0;

  useEffect(() => {
    if (!kind) return;
    if (!kind.arrays.some((a) => a.name === array)) {
      const pick = kind.arrays.find((a) => /^velocity magnitude/i.test(a.name))
        ?? kind.arrays.find((a) => /velocity/i.test(a.name) && a.ncomp === 1)
        ?? kind.arrays.find((a) => /velocity/i.test(a.name)) ?? kind.arrays[0];
      setArray(pick?.name ?? "");
    }
    if (followLast.current) {
      followLast.current = false;
      setTi(kind.times.length - 1);
    } else setTi((i) => Math.min(i, kind.times.length - 1) < 0 ? 0 : (i >= kind.times.length ? kind.times.length - 1 : i));
    if (kind.type === "slice" && kind.slice_axis !== null) setAxis(kind.slice_axis);
    const fr = kind.arrays.filter((a) => /volume fraction/i.test(a.name));
    setIso((s) => ({ ...s, array: s.array && kind.arrays.some((a) => a.name === s.array) ? s.array : (fr[fr.length - 1] ?? kind.arrays[0])?.name ?? "" }));
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (arr && arr.ncomp === 1) setComp(""); else if (arr && comp === "") setComp("mag"); }, [arr]); // eslint-disable-line react-hooks/exhaustive-deps

  const vecArrays = kind?.arrays.filter((a) => a.ncomp === 3) ?? [];
  useEffect(() => {
    if (vecArrays.length && !vecArrays.some((a) => a.name === flow.vec))
      setF({ vec: (vecArrays.find((a) => /velocity/i.test(a.name)) ?? vecArrays[0]).name });
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const isVolume = kind?.type === "volume";
  const [lo, hi] = kind && kind.extent ? bounds(kind, axis) : [0, 0];
  useEffect(() => { if (isVolume) setPos((lo + hi) / 2); }, [kindName, axis, isVolume]); // eslint-disable-line react-hooks/exhaustive-deps

  const urlFor = (path: string, k: OutputKind | undefined, idx: number) =>
    k && array ? api.planeUrl(path, k.files[idx][0], array, comp, isVolume ? axis : null,
                              isVolume ? pos : null, mask, smooth) : null;
  // other cases show their output time nearest to the reference time
  const frameOf = (id: string): [OutputKind, number] | null => {
    const k = invs[id]?.kinds.find((x) => x.kind === kindName);
    if (!k || !k.times.length) return null;
    return [k, id === ref ? Math.min(ti, k.times.length - 1) : nearest(k, t)];
  };
  const urls = sel.map((id) => { const f = frameOf(id); return f ? urlFor(pathOf(id), f[0], f[1]) : null; });
  const urlsKey = urls.join("\n");

  const shownExtras = extras.filter((e) => sel.includes(e.id));
  const extraArr = (e: Extra) => frameOf(e.id)?.[0].arrays.find((a) => a.name === e.array);
  const extraComp = (e: Extra) => ((extraArr(e)?.ncomp ?? 1) > 1 ? e.comp || "mag" : "");
  const extraUrls = shownExtras.map((e) => {
    const f = frameOf(e.id);
    return f && extraArr(e) ? api.planeUrl(pathOf(e.id), f[0].files[f[1]][0], e.array, extraComp(e),
      isVolume ? axis : null, isVolume ? pos : null, mask, smooth) : null;
  });
  const extraKey = JSON.stringify(shownExtras.map((e, i) => [e.key, extraUrls[i]]));
  useEffect(() => {
    if (layout === "3d" && !planeIn3d) return;
    let live = true;
    shownExtras.forEach((e, i) => {
      const u = extraUrls[i];
      if (!u) { setXPlanes((m) => ({ ...m, [e.key]: null })); return; }
      fetchPlane(u).then((p) => live && setXPlanes((m) => ({ ...m, [e.key]: p })))
        .catch((err) => live && setError(`${e.id} (${e.array}): ${err.message}`));
    });
    return () => { live = false; };
  }, [extraKey, layout, planeIn3d]); // eslint-disable-line react-hooks/exhaustive-deps
  const addExtra = () => {
    const arrays = kind?.arrays ?? [];
    const used = new Set([array, ...extras.filter((e) => e.id === ref).map((e) => e.array)]);
    const pick = arrays.find((a) => !used.has(a.name)) ?? arrays[0];
    if (!pick) return;
    setExtras([...extras, { key: Math.max(0, ...extras.map((e) => e.key)) + 1, id: ref, array: pick.name,
                            comp: pick.ncomp > 1 ? "mag" : "", cmap, log: false, range: "shared", manual: [0, 1] }]);
  };
  const setExtra = (key: number, patch: Partial<Extra>) =>
    setExtras((xs) => xs.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  useEffect(() => {
    if (layout === "3d" && !planeIn3d) { setPlanesFor(urlsKey); return; }
    let live = true;
    setError(null);
    Promise.allSettled(sel.map((id, i) => {
      const u = urls[i];
      if (!u) { setPlanes((m) => ({ ...m, [id]: null })); return null; }
      return fetchPlane(u).then((p) => live && setPlanes((m) => ({ ...m, [id]: p })))
        .catch((e) => live && setError(`${id}: ${e.message}`));
    })).then(() => live && setPlanesFor(urlsKey));
    return () => { live = false; };
  }, [urlsKey, layout, planeIn3d]); // eslint-disable-line react-hooks/exhaustive-deps

  // global (fluid-volume) mean of the shown field per case and extra view, keyed by the mean URL
  const [vmeans, setVmeans] = useState<Record<string, number | null>>({});
  const meanKey = (id: string, arrName: string, c: string) => {
    const f = frameOf(id);
    return f && arrName && f[0].type === "volume" ? `${pathOf(id)}|${f[0].files[f[1]][0]}|${arrName}|${c}|${mask}` : null;
  };
  const meanKeys = [...sel.map((id) => meanKey(id, array, comp)),
                    ...shownExtras.map((e) => meanKey(e.id, e.array, extraComp(e)))].filter((k): k is string => !!k);
  useEffect(() => {
    let live = true;
    for (const k of meanKeys) {
      if (k in vmeans) continue;
      const [path, file, arrName, c, m] = k.split("|");
      api.volumeMean(path, file, arrName, c, m === "true")
        .then((r) => live && setVmeans((v) => ({ ...v, [k]: r.mean })))
        .catch(() => live && setVmeans((v) => ({ ...v, [k]: null })));
    }
    return () => { live = false; };
  }, [meanKeys.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  const meanNotes = (p: Plane | null, key: string | null): string[] => {
    const out: string[] = [];
    if (p && Number.isFinite(p.mean)) out.push(`plane mean ${fmt(p.mean, 4)}`);
    const g = key ? vmeans[key] : undefined;
    if (typeof g === "number") out.push(`global mean ${fmt(g, 4)}`);
    else if (key && g === undefined) out.push("global mean ...");
    return out;
  };

  const cpFiles = sel.map((id) => {
    const f = frameOf(id);
    return cp.on && layout !== "2d" && f && f[0].type === "volume" && array ? f[0].files[f[1]][0] : null;
  });
  useEffect(() => {
    if (!cp.on || !cp.yAuto) return;
    let live = true;
    sel.forEach((id, i) => {
      const file = cpFiles[i];
      if (file) api.fluidCenter(pathOf(id), file)
        .then((r) => live && setFluidC((m) => ({ ...m, [`${id}|${file}`]: r.center })))
        .catch((e) => live && setError(`${id} (fluid center): ${e.message}`));
    });
    return () => { live = false; };
  }, [cpFiles.join("\n"), cp.on, cp.yAuto]); // eslint-disable-line react-hooks/exhaustive-deps
  const cpUrls = sel.map((id, i) => {
    const file = cpFiles[i];
    if (!file) return null;
    const yc = cp.yAuto ? fluidC[`${id}|${file}`]?.[1] : cp.cy;
    if (yc === undefined) return null;
    return [0, 1, 2].map((ax) => api.planeUrl(pathOf(id), file, array, comp, ax,
                                               [cp.cx, yc, cp.cz][ax], mask, smooth));
  });
  const cpKey = JSON.stringify(cpUrls);
  useEffect(() => {
    let live = true;
    sel.forEach((id, i) => {
      const us = cpUrls[i];
      if (!us) { setCplanes((m) => ({ ...m, [id]: [] })); return; }
      Promise.all(us.map((u) => fetchPlane(u)))
        .then((ps) => live && setCplanes((m) => ({ ...m, [id]: ps })))
        .catch((e) => live && setError(`${id} (center planes): ${e.message}`));
    });
    return () => { live = false; };
  }, [cpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // in-plane vector planes for streamlines / LIC
  const vecOk = vecArrays.some((a) => a.name === flow.vec);
  const want2d = flow.mode !== "none" && vecOk;
  const vecUrls = sel.map((id) => {
    const f = frameOf(id);
    return want2d && f ? api.planeVecUrl(pathOf(id), f[0].files[f[1]][0], flow.vec,
                                         isVolume ? axis : null, isVolume ? pos : null, mask) : null;
  });
  const vecKey = vecUrls.join("\n");
  useEffect(() => {
    let live = true;
    sel.forEach((id, i) => {
      const u = vecUrls[i];
      if (!u) { setVecs((m) => ({ ...m, [id]: null })); return; }
      fetchPlane(u).then((p) => live && setVecs((m) => ({ ...m, [id]: p })))
        .catch((e) => live && setError(`${id} (vector): ${e.message}`));
    });
    return () => { live = false; };
  }, [vecKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const showLines = flow.mode === "lines" || flow.mode === "both";
  const showLic = flow.mode === "lic" || flow.mode === "both";
  const lines2d = useMemo(() => Object.fromEntries(sel.map((id) => {
    const p = vecs[id];
    return [id, p && showLines ? traceStreamlines(toVec2(p), flow.density) : null];
  })), [vecs, showLines, flow.density, sel.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!showLic) { setLics({}); return; }
    let live = true;
    sel.forEach((id, i) => {
      const p = vecs[id], u = vecUrls[i];
      if (p && u) runLic(u, toVec2(p), flow.licScale, flow.licL)
        .then((out) => live && setLics((m) => ({ ...m, [id]: out })));
    });
    return () => { live = false; };
  }, [vecs, showLic, flow.licScale, flow.licL]); // eslint-disable-line react-hooks/exhaustive-deps
  const overlayOf = (id: string): Overlay | undefined => flow.mode === "none" ? undefined : {
    lines: lines2d[id], lic: showLic ? lics[id] ?? null : null, licScale: flow.licScale,
    licMode: flow.licMode, lineColor: flow.lineColor,
  };

  // 3D streamlines seeded on the plane; colored by speed when the field is that vector's magnitude
  const lines3d: Record<string, LineLayer[]> = Object.fromEntries(sel.map((id) => {
    const f = frameOf(id);
    if (!flow.stream3d || !vecOk || !f || f[0].type !== "volume") return [id, []];
    return [id, [{ key: "stream", url: api.streamlinesUrl(pathOf(id), f[0].files[f[1]][0], flow.vec, axis, pos,
                                                           flow.seeds3d, f[0].file_size > 4e8 ? 2 : 1),
                   color: array === flow.vec && comp === "mag" ? null : flow.color3d, cmap, range: [0, 0], log }]];
  }));
  const lines3dKey = JSON.stringify(lines3d);

  // playback: advance once the frame is complete (planes of every case and all 3D meshes),
  // at most `fps` frames per second; the next two frames are fetched and decoded meanwhile
  const busyTotal = Object.values(busy3d).reduce((a, b) => a + b, 0);
  useEffect(() => {
    if (!playing || !kind) return;
    if (planesFor !== urlsKey || (layout !== "2d" && busyTotal > 0)) return;
    const n = kind.times.length;
    const next = (ti + 1) % n;
    for (const step of [1, 2]) {
      const tt = kind.times[(ti + step) % n];
      sel.forEach((id) => {
        const k = invs[id]?.kinds.find((x) => x.kind === kindName);
        if (!k) return;
        const u = urlFor(pathOf(id), k, id === ref ? (ti + step) % n : nearest(k, tt));
        if (u) fetchPlane(u).catch(() => {});
      });
      if (layout !== "2d") Object.values(buildLayers(tt)).flat().forEach((l) => l.visible && l.key !== "iso" && prefetchMesh(l.url));
    }
    const wait = Math.max(0, 1000 / fps - (performance.now() - lastAdvance.current));
    const id = setTimeout(() => { lastAdvance.current = performance.now(); setTi(next); }, wait);
    return () => clearTimeout(id);
  }, [playing, planesFor, urlsKey, busyTotal, ti, kind, layout, fps]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = sel.map((id) => planes[id]).filter((p): p is Plane => !!p);
  const rangeKey = shown.map((p) => `${p.p01},${p.p99},${p.vmin},${p.vmax}`).join("|");
  const range: [number, number] = useMemo(() => {
    if (rangeMode === "manual" || !shown.length) return manual;
    return rangeMode === "robust"
      ? [Math.min(...shown.map((p) => p.p01)), Math.max(...shown.map((p) => p.p99))]
      : [Math.min(...shown.map((p) => p.vmin)), Math.max(...shown.map((p) => p.vmax))];
  }, [rangeMode, manual, rangeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // "shared": views of the same field share one color range (with the main rows when it is the main field)
  const rangeOf = (e: Extra): [number, number] => {
    if (e.range === "manual") return e.manual;
    const span = (ps: Plane[], mode: RangeMode): [number, number] => mode === "auto"
      ? [Math.min(...ps.map((p) => p.vmin)), Math.max(...ps.map((p) => p.vmax))]
      : [Math.min(...ps.map((p) => p.p01)), Math.max(...ps.map((p) => p.p99))];
    if (e.range !== "shared") {
      const p = xPlanes[e.key];
      return p ? span([p], e.range) : [0, 1];
    }
    const same = (x: Extra) => x.range === "shared" && x.array === e.array && extraComp(x) === extraComp(e);
    if (e.array === array && extraComp(e) === comp) return range;
    const ps = shownExtras.filter(same).map((x) => xPlanes[x.key]).filter((p): p is Plane => !!p);
    return ps.length ? span(ps, rangeMode === "auto" ? "auto" : "robust") : [0, 1];
  };
  const labelOf = (name: string, c: string, ncomp: number) =>
    `${name}${ncomp > 1 ? (c === "mag" ? " |mag|" : ` (${AXES[Number(c)] ?? c})`) : ""}`;

  const onLine = async (p0: number[], p1: number[]) => {
    try {
      const out = await Promise.all(sel.map(async (id) => {
        const f = frameOf(id);
        if (!f) return null;
        return { id, ...await api.line(pathOf(id), f[0].files[f[1]][0], array, comp, p0, p1) };
      }));
      setProfiles(out.filter((x): x is Profile => !!x));
    } catch (e) { setError((e as Error).message); }
  };

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
    const vol = inv.kinds.find((k) => k.type === "volume");
    if (iso.on && vol && iso.array) {
      const a = vol.arrays.find((x) => x.name === iso.array);
      out.push({ key: "iso", url: api.isoUrl(path, vol.files[nearest(vol, tt)][0], iso.array,
        a && a.ncomp > 1 ? "mag" : "", iso.level, vol.file_size > 4e8 ? 2 : 1, detail),
        color: "#e07b39", opacity: 0.85, visible: true, smooth: true });
    }
    return [id, out];
  }));
  const layersBy: Record<string, MeshLayer[]> = useMemo(() => buildLayers(t),
    [sel.join("|"), invs, geo, surf, iso, t, detail]); // eslint-disable-line react-hooks/exhaustive-deps

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

  if (!cases.length) return <div className="panel muted">Include at least one case on the Cases tab.</div>;
  const imgKinds = invA?.kinds.filter((k) => k.type === "volume" || k.type === "slice") ?? [];
  const volKind = invA?.kinds.find((k) => k.type === "volume");
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
            <label>Output <select value={kindName} onChange={(e) => setKindName(e.target.value)}>
              {imgKinds.map((k) => <option key={k.kind} value={k.kind}>{k.kind} ({k.type}, {k.times.length})</option>)}
            </select></label>
            {kind && (
              <>
                <SliderNum label={`Time [s] (${ti + 1}/${kind.times.length})`} min={0} max={kind.times.length - 1} step={1}
                           value={ti} onChange={setTi} num={t} numMin={kind.times[0]} numMax={kind.times[kind.times.length - 1]}
                           onNum={(v) => setTi(nearest(kind, v))} title="time [s]; snaps to the nearest output time" />
                <div className="row">
                  <button onClick={() => setTi(Math.max(0, ti - 1))}>&lt;</button>
                  <button onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
                  <button onClick={() => setTi(Math.min(kind.times.length - 1, ti + 1))}>&gt;</button>
                  <button onClick={() => setTi(kind.times.length - 1)}>Last</button>
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
                    <label>Normal <select value={axis} onChange={(e) => setAxis(Number(e.target.value))}>
                      {AXES.map((a, i) => <option key={a} value={i}>{a}</option>)}</select></label>
                    <SliderNum label={`${AXES[axis]} [m]`} min={lo} max={hi} step={(hi - lo) / 500 || 1}
                               value={pos ?? lo} onChange={setPos} />
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
                <label><input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} /> mask solids</label>
                <label title="VTK-style cell-to-point shading as in M-Star Post: 1-2-1 average over the neighbouring cells in all three directions, then bilinear interpolation; solid edges stay sharp. Hover values are then smoothed too; the line probe stays raw.">
                  <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} /> smooth shading</label>
                <label><input type="checkbox" checked={lineMode} onChange={(e) => setLineMode(e.target.checked)} /> line probe (2 clicks)</label>
              </>
            )}
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
                      {cp.yAuto ? <span className="muted"> {fmt(fluidC[`${ref}|${cpFiles[0]}`]?.[1])}</span>
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
                                   lineMode={lineMode} onLine={onLine} legend={legend} overlay={overlayOf(id)}
                                   background={bg} smooth={smooth}
                                   exportName={`${id}_${kindName}_t${fmt(t)}`} />
                    )}
                    {layout !== "2d" && invs[id] && (
                      <Viewer3D layers={layersBy[id] ?? []} plane={planeIn3d ? planes[id] ?? null : null}
                                cmap={cmap} range={range} log={log} height={paneH} background={bg} smooth={smooth}
                                legend={legend} overlay={overlayOf(id)} lines={lines3dBy[id]}
                                extraPlanes={cp.on ? cplanes[id] : undefined}
                                exportName={`${id}_3d_t${fmt(t)}`}
                                onLoading={(n) => setBusy3d((b) => (b[id] === n ? b : { ...b, [id]: n }))}
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
                                   lineMode={false} onLine={onLine} legend={lg} overlay={overlayOf(e.id)}
                                   background={bg} smooth={smooth} exportName={`${e.id}_${e.array}_t${fmt(t)}`} />
                    )}
                    {layout !== "2d" && invs[e.id] && (
                      <Viewer3D layers={layersBy[e.id] ?? []} plane={planeIn3d ? p : null}
                                cmap={e.cmap} range={r} log={e.log} height={paneH} background={bg} smooth={smooth}
                                legend={lg} overlay={overlayOf(e.id)}
                                exportName={`${e.id}_${e.array}_3d_t${fmt(t)}`}
                                onLoading={(n) => setBusy3d((b) => (b[`x${e.key}`] === n ? b : { ...b, [`x${e.key}`]: n }))}
                                sync={syncCams ? camSync : undefined} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {profiles && (
          <div className="card">
            <div className="row"><b className="grow">Line profile</b>
              <button onClick={() => download("line_profile.csv", toCsv(
                ["distance_m", ...profiles.map((p) => p.id)],
                profiles[0]?.distance.map((d, i) => [d, ...profiles.map((p) => p.value[i])]) ?? []))}>Export CSV</button>
              <button onClick={() => setProfiles(null)}>Close</button></div>
            <Plot height={300} exportName="line_profile" data={profiles.map((p) => (
              { type: "scatter" as const, mode: "lines" as const, x: p.distance, y: p.value, name: p.id }))}
              layout={{ xaxis: { title: { text: "distance [m]" } },
                        yaxis: { title: { text: `${fieldLabel} [${profiles[0]?.unit || "-"}]` } } }} />
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
