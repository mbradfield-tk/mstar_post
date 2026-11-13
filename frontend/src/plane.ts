// Float32 planes from /api/case/plane with an LRU cache (ported from tak_lbm SliceView).
export type Plane = {
  w: number; h: number; data: Float32Array;
  axis: number; index: number; count: number; pos: number;
  uAxis: number; vAxis: number; u0: number; v0: number; du: number; dv: number;
  vmin: number; vmax: number; p01: number; p99: number; mean: number; unit: string; time: number | null;
};

const CACHE_BYTES = 512 * 1024 * 1024;

/** True for the rejection of a fetch that was aborted (superseded request): not an error to show. */
export const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === "AbortError";

// users = callers with a live AbortSignal still waiting; keep = asked for without a signal (prefetch)
type Entry<T> = { p: Promise<T>; ctrl: AbortController; users: number; keep: boolean; done: boolean; v?: T; bytes: number };

/** Shared, abortable loads by URL, remembered within a byte budget. The least recently used entry
 *  goes first, but never one that is on screen (a held URL, or a value `inUse`). */
export class LoadCache<T> {
  private map = new Map<string, Entry<T>>();  // in use order, oldest first
  private total = 0;
  private held = new Set<string>();
  constructor(private budget: number, private load: (url: string, signal: AbortSignal) => Promise<T>,
              private size: (v: T) => number, private inUse: (v: T) => boolean = () => false,
              private drop: (v: T) => void = () => undefined) {}

  /** The value of a URL, shared by all callers. With a signal the caller can give up: the load is
   *  aborted (and forgotten) once every caller that asked for it has, unless one asked without a signal. */
  get(url: string, signal?: AbortSignal): Promise<T> {
    let e = this.map.get(url);
    if (e) this.map.delete(url); else e = this.start(url);
    this.map.set(url, e);
    const ent = e;
    if (!signal) ent.keep = true;
    else if (!ent.done && !signal.aborted) {
      ent.users++;
      signal.addEventListener("abort", () => {
        ent.users--;
        // after the current task: an effect re-run asking for the same URL keeps the request
        queueMicrotask(() => {
          if (ent.users > 0 || ent.keep || ent.done) return;
          ent.done = true;
          if (this.map.get(url) === ent) this.map.delete(url);
          ent.ctrl.abort();
        });
      }, { once: true });
    }
    return ent.p;
  }

  /** The loaded value of a URL if it is there (does not count as a use). */
  peek(url: string): T | undefined { return this.map.get(url)?.v; }

  /** The URLs on screen: they are never dropped (replaces the previous set). */
  hold(urls: Iterable<string>): void { this.held = new Set(urls); }

  /** Forget everything (files may have changed); loads under way are aborted. */
  clear(): void {
    for (const e of this.map.values()) {
      if (e.v !== undefined) { if (!this.inUse(e.v)) this.drop(e.v); }
      else if (!e.done) { e.done = true; e.ctrl.abort(); }
    }
    this.map.clear();
    this.total = 0;
  }

  private start(url: string): Entry<T> {
    const ctrl = new AbortController();
    const ent: Entry<T> = { p: this.load(url, ctrl.signal), ctrl, users: 0, keep: false, done: false, bytes: 0 };
    ent.p.then((v) => {
      ent.done = true;
      if (this.map.get(url) !== ent) { if (!this.inUse(v)) this.drop(v); return; }  // forgotten meanwhile
      ent.v = v;
      ent.bytes = this.size(v);
      this.total += ent.bytes;
      for (const [k, x] of this.map) {
        if (this.total <= this.budget) break;
        if (k === url || x.v === undefined || this.held.has(k) || this.inUse(x.v)) continue;
        this.total -= x.bytes;
        this.map.delete(k);
        this.drop(x.v);
      }
    }, () => { ent.done = true; if (this.map.get(url) === ent) this.map.delete(url); });
    return ent;
  }
}

async function loadPlane(url: string, signal: AbortSignal): Promise<Plane> {
  const r = await fetch(url, { signal });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).detail ?? msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const h = r.headers;
  const n = (k: string) => Number(h.get(k));
  const buf = await r.arrayBuffer();
  return {
    w: n("x-width"), h: n("x-height"), data: new Float32Array(buf),
    axis: n("x-axis"), index: n("x-index"), count: n("x-count"), pos: n("x-pos"),
    uAxis: n("x-u-axis"), vAxis: n("x-v-axis"), u0: n("x-u0"), v0: n("x-v0"),
    du: n("x-du"), dv: n("x-dv"), vmin: n("x-vmin"), vmax: n("x-vmax"),
    p01: n("x-p01"), p99: n("x-p99"), mean: h.get("x-mean") ? n("x-mean") : NaN, unit: h.get("x-unit") ?? "",
    time: h.get("x-time") ? n("x-time") : null,
  };
}

const planes = new LoadCache<Plane>(CACHE_BYTES, loadPlane, (p) => p.data.byteLength);

/** Plane of a URL (see LoadCache.get for the signal). */
export const fetchPlane = (url: string, signal?: AbortSignal): Promise<Plane> => planes.get(url, signal);
/** The plane of a URL if it has been loaded. */
export const planeNow = (url: string): Plane | undefined => planes.peek(url);
/** The plane URLs on screen (main, extra, centre and vector planes): never dropped from the cache. */
export const holdPlanes = (urls: Iterable<string>): void => planes.hold(urls);
export const clearPlaneCache = (): void => planes.clear();
