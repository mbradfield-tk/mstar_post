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

export const hexRgb = (hex: string): number[] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// RGBA pixels of a float plane; rows are flipped so +v points up on screen.
// NaN (masked solid) cells get the nan color.
export function colorize(data: Float32Array, w: number, h: number, lut: Uint8ClampedArray,
                         vmin: number, vmax: number, log = false,
                         flip = true, nan: number[] = NAN_RGB): Uint8ClampedArray<ArrayBuffer> {
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
        out[o] = nan[0]; out[o + 1] = nan[1]; out[o + 2] = nan[2]; out[o + 3] = 255;
        continue;
      }
      if (log) v = Math.log10(v);
      const k = Math.max(0, Math.min(255, Math.round((v - lo) * scale))) * 4;
      out[o] = lut[k]; out[o + 1] = lut[k + 1]; out[o + 2] = lut[k + 2]; out[o + 3] = 255;
    }
  }
  return out;
}

/** Colorized image (w x h, from colorize with the same flip) shaded by a LIC
 *  texture at `scale` x resolution: field colors darkened by LIC, or grey LIC. */
export function shadeLic(base: Uint8ClampedArray, w: number, h: number, lic: Float32Array, scale: number,
                         mode: "field" | "grey", flip = true): Uint8ClampedArray<ArrayBuffer> {
  const W = w * scale, H = h * scale;
  const out = new Uint8ClampedArray(new ArrayBuffer(W * H * 4));
  for (let R = 0; R < H; R++) {
    const lrow = (flip ? H - 1 - R : R) * W;
    const brow = Math.floor(R / scale) * w;
    for (let C = 0; C < W; C++) {
      const b = (brow + Math.floor(C / scale)) * 4, o = (R * W + C) * 4;
      const l = lic[lrow + C];
      if (!Number.isFinite(l)) {
        out[o] = base[b]; out[o + 1] = base[b + 1]; out[o + 2] = base[b + 2];
      } else if (mode === "grey") {
        out[o] = out[o + 1] = out[o + 2] = l * 255;
      } else {
        const f = 0.35 + 0.65 * l;
        out[o] = base[b] * f; out[o + 1] = base[b + 1] * f; out[o + 2] = base[b + 2] * f;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

export const legendTicks = ([lo, hi]: [number, number], log: boolean, n = 5): number[] =>
  Array.from({ length: n }, (_, i) => {
    const f = 1 - i / (n - 1);
    return log && lo > 0 && hi > 0
      ? 10 ** (Math.log10(lo) + f * (Math.log10(hi) - Math.log10(lo))) : lo + f * (hi - lo);
  });

/** Relative luminance of a #rrggbb color (0 dark .. 1 light). */
export const luminance = (hex: string): number => {
  const n = parseInt(hex.replace("#", ""), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};
