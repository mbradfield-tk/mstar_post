// Float32 planes from /api/case/plane with an LRU cache (ported from tak_lbm SliceView).
export type Plane = {
  w: number; h: number; data: Float32Array;
  axis: number; index: number; count: number; pos: number;
  uAxis: number; vAxis: number; u0: number; v0: number; du: number; dv: number;
  vmin: number; vmax: number; p01: number; p99: number; unit: string; time: number | null;
};

const CACHE_BYTES = 512 * 1024 * 1024;
const cache = new Map<string, Promise<Plane>>();
const sizes = new Map<string, number>();

function evict() {
  let total = 0;
  for (const n of sizes.values()) total += n;
  for (const k of sizes.keys()) {
    if (total <= CACHE_BYTES) break;
    total -= sizes.get(k)!;
    sizes.delete(k);
    cache.delete(k);
  }
}

export function clearPlaneCache(): void {
  cache.clear();
  sizes.clear();
}

export function fetchPlane(url: string): Promise<Plane> {
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    cache.set(url, hit);
    return hit;
  }
  const p = (async () => {
    const r = await fetch(url);
    if (!r.ok) {
      let msg = `${r.status}`;
      try { msg = (await r.json()).detail ?? msg; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    const h = r.headers;
    const n = (k: string) => Number(h.get(k));
    const buf = await r.arrayBuffer();
    sizes.set(url, buf.byteLength);
    evict();
    return {
      w: n("x-width"), h: n("x-height"), data: new Float32Array(buf),
      axis: n("x-axis"), index: n("x-index"), count: n("x-count"), pos: n("x-pos"),
      uAxis: n("x-u-axis"), vAxis: n("x-v-axis"), u0: n("x-u0"), v0: n("x-v0"),
      du: n("x-du"), dv: n("x-dv"), vmin: n("x-vmin"), vmax: n("x-vmax"),
      p01: n("x-p01"), p99: n("x-p99"), unit: h.get("x-unit") ?? "",
      time: h.get("x-time") ? n("x-time") : null,
    };
  })();
  p.catch(() => { cache.delete(url); sizes.delete(url); });
  cache.set(url, p);
  return p;
}
