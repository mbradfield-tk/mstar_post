import type { Vec2 } from "./flow";

// LIC in a Web Worker, results cached by key (plane URL + parameters).
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (out: Float32Array) => void>();
const cache = new Map<string, Promise<Float32Array>>();

export function runLic(key: string, f: Vec2, scale: number, L: number): Promise<Float32Array> {
  const k = `${key}|${scale}|${L}`;
  const hit = cache.get(k);
  if (hit) return hit;
  if (!worker) {
    worker = new Worker(new URL("./lic.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; out: Float32Array }>) => {
      pending.get(e.data.id)?.(e.data.out);
      pending.delete(e.data.id);
    };
  }
  const id = nextId++;
  const p = new Promise<Float32Array>((resolve) => pending.set(id, resolve));
  worker.postMessage({ id, f, scale, L });
  cache.set(k, p);
  if (cache.size > 24) cache.delete(cache.keys().next().value!);
  return p;
}
