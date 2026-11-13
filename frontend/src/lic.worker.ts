import { licRows, type Vec2 } from "./flow";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (msg: unknown, transfer: Transferable[]) => void;
};

// every step-th row of a LIC image, from row `first`; lic.ts joins the rows and stretches the result
ctx.onmessage = (e: MessageEvent<{ id: number; f: Vec2; scale: number; L: number; first: number; step: number }>) => {
  const { id, f, scale, L, first, step } = e.data;
  const out = licRows(f, scale, L, first, step);
  ctx.postMessage({ id, first, step, out }, [out.buffer]);
};
