// Colormap lookup tables from the server's 256x1 PNG strips (cached per name).
const lutCache = new Map<string, Promise<Uint8ClampedArray>>();

export function cmapLut(name: string): Promise<Uint8ClampedArray> {
  let p = lutCache.get(name);
  if (!p) {
    p = (async () => {
      const img = new Image();
      img.src = `/api/case/cmap/${name}`;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = 256;
      cv.height = 1;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(img, 0, 0, 256, 1);
      return ctx.getImageData(0, 0, 256, 1).data;
    })();
    p.catch(() => lutCache.delete(name));
    lutCache.set(name, p);
  }
  return p;
}

export const NAN_RGB = [215, 215, 215];

// RGBA pixels of a float plane; rows are flipped so +v points up on screen.
export function colorize(data: Float32Array, w: number, h: number, lut: Uint8ClampedArray,
                         vmin: number, vmax: number, log = false,
                         flip = true): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  const lo = log ? Math.log10(Math.max(vmin, 1e-30)) : vmin;
  const hi = log ? Math.log10(Math.max(vmax, 1e-30)) : vmax;
  const scale = hi > lo ? 255 / (hi - lo) : 0;
  for (let r = 0; r < h; r++) {
    const src = r * w;
    const dst = (flip ? h - 1 - r : r) * w;
    for (let c = 0; c < w; c++) {
      let v = data[src + c];
      const o = (dst + c) * 4;
      if (!Number.isFinite(v) || (log && v <= 0)) {
        out[o] = NAN_RGB[0]; out[o + 1] = NAN_RGB[1]; out[o + 2] = NAN_RGB[2]; out[o + 3] = 255;
        continue;
      }
      if (log) v = Math.log10(v);
      const k = Math.max(0, Math.min(255, Math.round((v - lo) * scale))) * 4;
      out[o] = lut[k]; out[o + 1] = lut[k + 1]; out[o + 2] = lut[k + 2]; out[o + 3] = 255;
    }
  }
  return out;
}
