import { useEffect, useMemo, useState } from "react";
import { api, AXES, download, fmt, toCsv, type Inventory, type OutputKind, type Project } from "./api";
import { fetchPlane, type Plane } from "./plane";
import Plot from "./Plot";
import SliceCanvas from "./SliceCanvas";
import Viewer3D, { layerColor, type MeshLayer } from "./Viewer3D";

type RangeMode = "auto" | "robust" | "manual";
const nearest = (k: OutputKind, t: number) => {
  let best = 0;
  k.times.forEach((x, i) => { if (Math.abs(x - t) < Math.abs(k.times[best] - t)) best = i; });
  return best;
};
const bounds = (k: OutputKind, axis: number): [number, number] => {
  const e = k.extent!, o = k.origin!, s = k.spacing!;
  return [o[axis] + e[2 * axis] * s[axis], o[axis] + e[2 * axis + 1] * s[axis]];
};

export default function ViewerView({ project }: { project: Project }) {
  const cases = project.cases.filter((c) => c.included);
  const [caseA, setCaseA] = useState(project.ref_case && cases.some((c) => c.id === project.ref_case)
    ? project.ref_case : cases[0]?.id ?? "");
  const [caseB, setCaseB] = useState("");
  const [invA, setInvA] = useState<Inventory | null>(null);
  const [invB, setInvB] = useState<Inventory | null>(null);
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
  const [planeA, setPlaneA] = useState<Plane | null>(null);
  const [planeB, setPlaneB] = useState<Plane | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [lineMode, setLineMode] = useState(false);
  const [profile, setProfile] = useState<{ a: Awaited<ReturnType<typeof api.line>>; b?: Awaited<ReturnType<typeof api.line>> } | null>(null);
  // 3D state
  const [geo, setGeo] = useState<Record<string, { on: boolean; opacity: number }>>({});
  const [surf, setSurf] = useState<Record<string, boolean>>({});
  const [iso, setIso] = useState({ on: false, array: "", level: 0.5 });
  const [planeIn3d, setPlaneIn3d] = useState(true);

  const pathA = cases.find((c) => c.id === caseA)?.path ?? "";
  const pathB = cases.find((c) => c.id === caseB)?.path ?? "";

  useEffect(() => { api.cmaps().then(setCmaps); }, []);
  useEffect(() => {
    setInvA(null);
    if (!pathA) return;
    api.inventory(pathA).then((inv) => {
      setInvA(inv);
      const imgs = inv.kinds.filter((k) => k.type === "volume" || k.type === "slice");
      setKindName((cur) => imgs.some((k) => k.kind === cur) ? cur
        : (imgs.find((k) => k.type === "volume") ?? imgs[0])?.kind ?? "");
      // posed moving-body surfaces replace the static impeller STL
      const moving = inv.kinds.some((k) => k.type === "surface" && /movingbody/i.test(k.kind));
      setGeo(Object.fromEntries(inv.geometry.map((g) => [g.name, {
        on: !/fluid height|box/i.test(g.name)
          && !(moving && /moving|agitator|impeller|rotor/i.test(g.name)),
        opacity: /wall|vessel|static/i.test(g.name) ? 0.2 : 0.9,
      }])));
      setSurf(Object.fromEntries(inv.kinds.filter((k) => k.type === "surface").map((k) =>
        [k.kind, /^VolumeMovingBody/i.test(k.kind)])));
    }).catch((e) => setError(e.message));
  }, [pathA]);
  useEffect(() => {
    setInvB(null);
    if (pathB) api.inventory(pathB).then(setInvB).catch((e) => setError(e.message));
  }, [pathB]);

  const kind = invA?.kinds.find((k) => k.kind === kindName);
  const kindB = invB?.kinds.find((k) => k.kind === kindName);
  const arr = kind?.arrays.find((a) => a.name === array);
  const t = kind ? kind.times[Math.min(ti, kind.times.length - 1)] : 0;

  useEffect(() => {
    if (!kind) return;
    if (!kind.arrays.some((a) => a.name === array)) {
      const pick = kind.arrays.find((a) => /velocity/i.test(a.name)) ?? kind.arrays[0];
      setArray(pick?.name ?? "");
    }
    setTi((i) => Math.min(i, kind.times.length - 1) < 0 ? 0 : (i >= kind.times.length ? kind.times.length - 1 : i));
    if (kind.type === "slice" && kind.slice_axis !== null) setAxis(kind.slice_axis);
    const fr = kind.arrays.filter((a) => /volume fraction/i.test(a.name));
    setIso((s) => ({ ...s, array: s.array && kind.arrays.some((a) => a.name === s.array) ? s.array : (fr[fr.length - 1] ?? kind.arrays[0])?.name ?? "" }));
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (arr && arr.ncomp === 1) setComp(""); else if (arr && comp === "") setComp("mag"); }, [arr]); // eslint-disable-line react-hooks/exhaustive-deps

  const isVolume = kind?.type === "volume";
  const [lo, hi] = kind && kind.extent ? bounds(kind, axis) : [0, 0];
  useEffect(() => { if (isVolume) setPos((lo + hi) / 2); }, [kindName, axis, isVolume]); // eslint-disable-line react-hooks/exhaustive-deps

  const urlFor = (path: string, k: OutputKind | undefined, idx: number) =>
    k && array ? api.planeUrl(path, k.files[idx][0], array, comp, isVolume ? axis : null,
                              isVolume ? pos : null, mask) : null;
  const urlA = kind ? urlFor(pathA, kind, Math.min(ti, kind.times.length - 1)) : null;
  const urlB = kindB ? urlFor(pathB, kindB, nearest(kindB, t)) : null;

  useEffect(() => {
    if (!urlA || layout === "3d" && !planeIn3d) return;
    let live = true;
    setError(null);
    fetchPlane(urlA).then((p) => live && setPlaneA(p)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [urlA, layout, planeIn3d]);
  useEffect(() => {
    if (!urlB) { setPlaneB(null); return; }
    let live = true;
    fetchPlane(urlB).then((p) => live && setPlaneB(p)).catch((e) => live && setError(`B: ${e.message}`));
    return () => { live = false; };
  }, [urlB]);

  // playback: advance once the current frame is shown, prefetching the next
  useEffect(() => {
    if (!playing || !kind || !planeA) return;
    const next = (ti + 1) % kind.times.length;
    const u = urlFor(pathA, kind, next);
    if (u) fetchPlane(u).catch(() => {});
    const id = setTimeout(() => setTi(next), 350);
    return () => clearTimeout(id);
  }, [playing, planeA]); // eslint-disable-line react-hooks/exhaustive-deps

  const range: [number, number] = useMemo(() => {
    if (rangeMode === "manual" || !planeA) return manual;
    const ps = [planeA, planeB].filter((p): p is Plane => !!p);
    return rangeMode === "robust"
      ? [Math.min(...ps.map((p) => p.p01)), Math.max(...ps.map((p) => p.p99))]
      : [Math.min(...ps.map((p) => p.vmin)), Math.max(...ps.map((p) => p.vmax))];
  }, [rangeMode, manual, planeA, planeB]);

  const onLine = async (p0: number[], p1: number[]) => {
    if (!kind) return;
    const fA = kind.files[Math.min(ti, kind.times.length - 1)][0];
    try {
      const a = await api.line(pathA, fA, array, comp, p0, p1);
      const b = kindB ? await api.line(pathB, kindB.files[nearest(kindB, t)][0], array, comp, p0, p1) : undefined;
      setProfile({ a, b });
    } catch (e) { setError((e as Error).message); }
  };

  // 3D layers
  const layers: MeshLayer[] = useMemo(() => {
    if (!invA) return [];
    const out: MeshLayer[] = invA.geometry.map((g, i) => ({
      key: `geo:${g.name}`, url: api.surfaceUrl(pathA, g.file), color: layerColor(i),
      opacity: geo[g.name]?.opacity ?? 0.5, visible: !!geo[g.name]?.on,
    }));
    invA.kinds.filter((k) => k.type === "surface" && surf[k.kind]).forEach((k) => {
      const idx = nearest(k, t);
      k.files[idx].forEach((f, j) => out.push({
        key: `surf:${k.kind}:${j}`, url: api.surfaceUrl(pathA, f),
        color: /vof/i.test(k.kind) ? "#4aa3df" : "#9a9a9a", opacity: /vof/i.test(k.kind) ? 0.75 : 1, visible: true,
      }));
    });
    const vol = invA.kinds.find((k) => k.type === "volume");
    if (iso.on && vol && iso.array) {
      const a = vol.arrays.find((x) => x.name === iso.array);
      out.push({ key: "iso", url: api.isoUrl(pathA, vol.files[nearest(vol, t)][0], iso.array,
        a && a.ncomp > 1 ? "mag" : "", iso.level, vol.file_size > 4e8 ? 2 : 1),
        color: "#e07b39", opacity: 0.85, visible: true });
    }
    return out;
  }, [invA, geo, surf, iso, t, pathA]);

  if (!cases.length) return <div className="panel muted">Include at least one case on the Cases tab.</div>;
  const imgKinds = invA?.kinds.filter((k) => k.type === "volume" || k.type === "slice") ?? [];
  const volKind = invA?.kinds.find((k) => k.type === "volume");

  return (
    <div className="split">
      <div className="side controls">
        <label>Case <select value={caseA} onChange={(e) => setCaseA(e.target.value)}>
          {cases.map((c) => <option key={c.id}>{c.id}</option>)}</select></label>
        <label>Compare with <select value={caseB} onChange={(e) => setCaseB(e.target.value)}>
          <option value="">(none)</option>
          {cases.filter((c) => c.id !== caseA).map((c) => <option key={c.id}>{c.id}</option>)}</select></label>
        <label>View <select value={layout} onChange={(e) => setLayout(e.target.value as typeof layout)}>
          <option value="both">2D + 3D</option><option value="2d">2D</option><option value="3d">3D</option></select></label>
        {!invA && <div className="muted">scanning outputs...</div>}
        {invA && !imgKinds.length && <div className="muted">No .vti volume or slice output found.</div>}
        {!!imgKinds.length && (
          <fieldset>
            <legend>Plane</legend>
            <label>Output <select value={kindName} onChange={(e) => setKindName(e.target.value)}>
              {imgKinds.map((k) => <option key={k.kind} value={k.kind}>{k.kind} ({k.type}, {k.times.length})</option>)}
            </select></label>
            {kind && (
              <>
                <label>Time {fmt(t)} s ({ti + 1}/{kind.times.length})
                  <input type="range" min={0} max={kind.times.length - 1} value={ti}
                         onChange={(e) => setTi(Number(e.target.value))} /></label>
                <div className="row">
                  <button onClick={() => setTi(Math.max(0, ti - 1))}>&lt;</button>
                  <button onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
                  <button onClick={() => setTi(Math.min(kind.times.length - 1, ti + 1))}>&gt;</button>
                  <button onClick={() => setTi(kind.times.length - 1)}>Last</button>
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
                    <label>{AXES[axis]} = {fmt(pos)} m
                      <input type="range" min={lo} max={hi} step={(hi - lo) / 500 || 1} value={pos ?? lo}
                             onChange={(e) => setPos(Number(e.target.value))} /></label>
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
                <label><input type="checkbox" checked={lineMode} onChange={(e) => setLineMode(e.target.checked)} /> line probe (2 clicks)</label>
              </>
            )}
          </fieldset>
        )}
        {invA && layout !== "2d" && (
          <fieldset>
            <legend>3D</legend>
            <label><input type="checkbox" checked={planeIn3d} onChange={(e) => setPlaneIn3d(e.target.checked)} /> plane</label>
            {invA.geometry.map((g) => (
              <div key={g.name} className="row small">
                <label className="grow"><input type="checkbox" checked={!!geo[g.name]?.on}
                  onChange={(e) => setGeo({ ...geo, [g.name]: { ...geo[g.name], on: e.target.checked } })} />
                  <span title={g.file}>{g.name}</span></label>
                <input type="range" min={0.05} max={1} step={0.05} value={geo[g.name]?.opacity ?? 0.5} title="opacity"
                       onChange={(e) => setGeo({ ...geo, [g.name]: { ...geo[g.name], opacity: Number(e.target.value) } })} />
              </div>
            ))}
            {invA.kinds.filter((k) => k.type === "surface").map((k) => (
              <label key={k.kind} className="small"><input type="checkbox" checked={!!surf[k.kind]}
                onChange={(e) => setSurf({ ...surf, [k.kind]: e.target.checked })} />{k.kind}
                <span className="muted"> ({(k.file_size / 1e6).toFixed(0)} MB)</span></label>
            ))}
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
          </fieldset>
        )}
      </div>
      <div className="main">
        {error && <div className="error">{error}</div>}
        {layout !== "3d" && (
          <div className={caseB ? "pair" : ""}>
            <SliceCanvas plane={planeA} cmap={cmap} range={range} log={log} title={caseA}
                         lineMode={lineMode} onLine={onLine} />
            {caseB && <SliceCanvas plane={planeB} cmap={cmap} range={range} log={log}
                                   title={kindB ? caseB : `${caseB}: no '${kindName}' output`} />}
          </div>
        )}
        {profile && (
          <div className="card">
            <div className="row"><b className="grow">Line profile</b>
              <button onClick={() => download("line_profile.csv", toCsv(
                ["distance_m", caseA, ...(profile.b ? [caseB] : [])],
                profile.a.distance.map((d, i) => [d, profile.a.value[i], ...(profile.b ? [profile.b.value[i]] : [])])))}>Export CSV</button>
              <button onClick={() => setProfile(null)}>Close</button></div>
            <Plot height={300} exportName="line_profile" data={[
              { type: "scatter", mode: "lines", x: profile.a.distance, y: profile.a.value, name: caseA },
              ...(profile.b ? [{ type: "scatter" as const, mode: "lines" as const, x: profile.b.distance, y: profile.b.value, name: caseB }] : []),
            ]} layout={{ xaxis: { title: { text: "distance [m]" } }, yaxis: { title: { text: `${array} ${comp && comp !== "mag" ? AXES[Number(comp)] : ""}` } } }} />
          </div>
        )}
        {layout !== "2d" && invA && (
          <Viewer3D layers={layers} plane={planeIn3d ? planeA : null} cmap={cmap} range={range} log={log}
                    height={layout === "3d" ? 760 : 520} />
        )}
      </div>
    </div>
  );
}
