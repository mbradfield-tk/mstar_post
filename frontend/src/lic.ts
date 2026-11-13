import { licFinish, type Vec2 } from "./flow";

// LIC in Web Workers. One image at a time, its rows dealt out over up to POOL workers; finished images
// are remembered by key (plane URL + parameters) within a byte budget. An image still waiting is
// dropped when its owner (a case) asks for another one, so the workers never compute for frames
// that will not be shown (at most the image already started is finished).
const POOL = Math.max(1, Math.min(4, ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2) - 1));
const CACHE_BYTES = 128 * 1024 * 1024;
type Job = { k: string; owner: string; f: Vec2; scale: number; L: number;
             resolve: (a: Float32Array) => void; reject: (e: Error) => void };
type Hit = { p: Promise<Float32Array>; out?: Float32Array };
const cache = new Map<string, Hit>();  // in use order, oldest first
let bytes = 0;
const queue: Job[] = [];
let active: { job: Job; left: number; out: Float32Array } | null = null;
let workers: Worker[] = [];
let run = 0;  // id of the image being computed; rows of an abandoned one are ignored

const superseded = () => Object.assign(new Error("superseded"), { name: "AbortError" });
const touch = (k: string): Hit | undefined => {
  const h = cache.get(k);
  if (h) { cache.delete(k); cache.set(k, h); }
  return h;
};

/** The finished LIC of a key, or null (not computed yet, dropped or no longer remembered). */
export const licNow = (key: string, scale: number, L: number): Float32Array | null =>
  touch(`${key}|${scale}|${L}`)?.out ?? null;

function stop(): void {
  run++;
  workers.forEach((w) => w.terminate());
  workers = [];
  const a = active;
  active = null;
  if (a) { cache.delete(a.job.k); a.job.reject(superseded()); }
}

export function clearLicCache(): void {
  for (const j of queue.splice(0)) j.reject(superseded());
  stop();
  cache.clear();
  bytes = 0;
}

function onRows(e: MessageEvent<{ id: number; first: number; step: number; out: Float32Array }>): void {
  const a = active;
  if (!a || e.data.id !== run) return;
  const { first, step, out } = e.data, W = a.job.f.w * a.job.scale, H = a.job.f.h * a.job.scale;
  for (let Y = first, o = 0; Y < H; Y += step, o += W) a.out.set(out.subarray(o, o + W), Y * W);
  if (--a.left) return;
  active = null;
  a.job.resolve(licFinish(a.out));
  pump();
}

function pump(): void {
  if (active || !queue.length) return;
  const job = queue.shift()!;
  const H = job.f.h * job.scale;
  const n = Math.max(1, Math.min(POOL, Math.ceil(H / 32)));
  const id = ++run;
  active = { job, left: n, out: new Float32Array(job.f.w * job.scale * H) };
  for (let i = 0; i < n; i++) {
    if (!workers[i]) {
      workers[i] = new Worker(new URL("./lic.worker.ts", import.meta.url), { type: "module" });
      workers[i].onmessage = onRows;
      workers[i].onerror = () => { stop(); pump(); };
    }
    // interleaved rows: every worker gets the same share of the fluid
    workers[i].postMessage({ id, f: job.f, scale: job.scale, L: job.L, first: i, step: n });
  }
}

/** LIC of a vector plane. `owner` (the case): asking for a new image drops the owner's images that
 *  have not been started; their promises reject with an AbortError (see plane.isAbort). */
export function runLic(key: string, f: Vec2, scale: number, L: number, owner = ""): Promise<Float32Array> {
  const k = `${key}|${scale}|${L}`;
  const hit = touch(k);
  if (hit) return hit.p;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].owner !== owner) continue;
    const [j] = queue.splice(i, 1);
    cache.delete(j.k);
    j.reject(superseded());
  }
  const h = {} as Hit;
  h.p = new Promise<Float32Array>((resolve, reject) => queue.push({ k, owner, f, scale, L, resolve, reject }));
  h.p.then((out) => {
    h.out = out;
    if (cache.get(k) !== h) return;
    bytes += out.byteLength;
    for (const [kk, hh] of cache) {
      if (bytes <= CACHE_BYTES) break;
      if (kk === k || !hh.out) continue;
      bytes -= hh.out.byteLength;
      cache.delete(kk);
    }
  }, () => { if (cache.get(k) === h) cache.delete(k); });
  cache.set(k, h);
  pump();
  return h.p;
}
