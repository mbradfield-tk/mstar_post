import { lic, type Vec2 } from "./flow";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (msg: unknown, transfer: Transferable[]) => void;
};

ctx.onmessage = (e: MessageEvent<{ id: number; f: Vec2; scale: number; L: number }>) => {
  const { id, f, scale, L } = e.data;
  const out = lic(f, scale, L);
  ctx.postMessage({ id, out }, [out.buffer]);
};
