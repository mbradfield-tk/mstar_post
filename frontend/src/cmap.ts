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

/** Positive lower bound of a log scale: lo when it is positive, else six decades below hi.
 *  colorize and legendTicks both use it, so the legend always matches the picture. */
export const logLo = (lo: number, hi: number): number => (lo > 0 ? lo : hi > 0 ? hi * 1e-6 : 1e-30);

const minPos = new WeakMap<Float32Array, number>();
// smallest positive finite value of a plane (Infinity if none), remembered per array
function minPositive(d: Float32Array): number {
  let m = minPos.get(d);
  if (m === undefined) {
    m = Infinity;
    for (let i = 0; i < d.length; i++) { const v = d[i]; if (v > 0 && v < m) m = v; }
    minPos.set(d, m);
  }
  return m;
}

const finite = new WeakMap<Float32Array, boolean>();
/** Whether a plane has any finite (fluid) cell; a fully masked plane has no range of its own. */
export function hasFinite(d: Float32Array): boolean {
  let f = finite.get(d);
  if (f === undefined) {
    f = false;
    for (let i = 0; i < d.length && !f; i++) f = d[i] - d[i] === 0;
    finite.set(d, f);
  }
  return f;
}

/** Range for a log scale over the shown data: a lower bound <= 0 becomes the smallest positive
 *  value of the data, at most six decades below the upper bound (hi * 1e-6 when the data has
 *  none below hi). Pass the result to both colorize and the legend; a usable range is returned as is. */
export function logRange(r: [number, number], data: Float32Array[]): [number, number] {
  const [lo, hi] = r;
  if (lo > 0 || !(hi > 0)) return r;
  const m = Math.min(Infinity, ...data.map(minPositive));
  return [Math.max(m < hi ? m : 0, hi * 1e-6), hi];
}

// colormap as 256 packed RGBA words (one 32-bit write per pixel), remembered per LUT
const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const pack = (r: number, g: number, b: number): number =>
  (LE ? (255 << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
const luts32 = new WeakMap<Uint8ClampedArray, Uint32Array>();
function lut32(lut: Uint8ClampedArray): Uint32Array {
  let t = luts32.get(lut);
  if (!t) {
    t = new Uint32Array(256);
    for (let k = 0; k < 256; k++) t[k] = pack(lut[4 * k], lut[4 * k + 1], lut[4 * k + 2]);
    luts32.set(lut, t);
  }
  return t;
}

// RGBA pixels of a float plane; rows are flipped so +v points up on screen.
// NaN (masked solid) cells get the nan color.
export function colorize(data: Float32Array, w: number, h: number, lut: Uint8ClampedArray,
                         vmin: number, vmax: number, log = false,
                         flip = true, nan: number[] = NAN_RGB): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  const px = new Uint32Array(out.buffer), t = lut32(lut), bad = pack(nan[0], nan[1], nan[2]);
  const lo = log ? Math.log10(logLo(vmin, vmax)) : vmin;
  const hi = log ? Math.log10(Math.max(vmax, 1e-30)) : vmax;
  const scale = hi > lo ? 255 / (hi - lo) : 0;
  for (let r = 0; r < h; r++) {
    const src = r * w;
    const dst = (flip ? h - 1 - r : r) * w;
    for (let c = 0; c < w; c++) {
      let v = data[src + c];
      if (v - v !== 0 || (log && v <= 0)) { px[dst + c] = bad; continue; }  // NaN or infinite
      if (log) v = Math.log10(v);
      const k = (v - lo) * scale;
      px[dst + c] = t[k >= 255 ? 255 : k > 0 ? (k + 0.5) | 0 : 0];
    }
  }
  return out;
}

/** In-plane [1 2 1]/4 tent filter over fluid neighbours (NaN cells stay NaN): the in-plane
 *  part of VTK's cell-to-point averaging sampled back at the cell centres. */
export function tent(data: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = data[y * w + x];
    if (!Number.isFinite(c)) { out[y * w + x] = NaN; continue; }
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      const wy = dy ? 1 : 2;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const v = data[yy * w + xx];
        if (Number.isFinite(v)) { const wt = wy * (dx ? 1 : 2); s += v * wt; n += wt; }
      }
    }
    out[y * w + x] = s / n;
  }
  return out;
}

// Tent-filtered and upsampled copies of the planes used last (smooth shading), so a change of
// range, colormap or a re-render does not redo them; the least recently used planes go first.
const DERIVED_BYTES = 256 * 1024 * 1024;
const derived = new Map<Float32Array, Map<string, Float32Array>>();
let derivedBytes = 0;
function remember(data: Float32Array, key: string, make: () => Float32Array): Float32Array {
  let m = derived.get(data);
  if (m) derived.delete(data); else m = new Map();
  derived.set(data, m);
  let a = m.get(key);
  if (!a) {
    a = make();
    m.set(key, a);
    derivedBytes += a.byteLength;
    for (const [d, mm] of derived) {
      if (derivedBytes <= DERIVED_BYTES || d === data) break;
      for (const x of mm.values()) derivedBytes -= x.byteLength;
      derived.delete(d);
    }
  }
  return a;
}

/** tent() of a plane, computed once per plane: the values that are drawn, shown on hover and
 *  averaged in a region when smooth shading is on. */
export const smoothed = (data: Float32Array, w: number, h: number): Float32Array =>
  remember(data, "t", () => tent(data, w, h));

/** Bilinear upsample of a plane by an integer factor between cell centres; masked (NaN)
 *  cells stay NaN at their own pixels and are left out of the neighbour average, so
 *  solid edges stay crisp while the field is smooth. Remembered per plane and factor. */
export function upsample(data: Float32Array, w: number, h: number, scale: number, filter = true): Float32Array {
  const src = filter ? smoothed(data, w, h) : data;
  if (scale <= 1) return src;
  return remember(data, `${scale}|${filter}`, () => bilinear(src, w, h, scale));
}

function bilinear(data: Float32Array, w: number, h: number, scale: number): Float32Array {
  const W = w * scale, H = h * scale;
  const out = new Float32Array(W * H);
  // per output column: left and right cell, weight of the right one, nearest cell
  const x0s = new Int32Array(W), x1s = new Int32Array(W), nxs = new Int32Array(W), fxs = new Float64Array(W);
  for (let X = 0; X < W; X++) {
    const gx = (X + 0.5) / scale - 0.5;
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(gx)));
    x0s[X] = x0;
    x1s[X] = Math.min(w - 1, x0 + 1);
    fxs[X] = Math.min(1, Math.max(0, gx - x0));
    nxs[X] = Math.min(w - 1, Math.max(0, Math.round(gx)));
  }
  for (let Y = 0; Y < H; Y++) {
    const gy = (Y + 0.5) / scale - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(gy))), y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, gy - y0));
    const r0 = y0 * w, r1 = y1 * w, rn = Math.min(h - 1, Math.max(0, Math.round(gy))) * w, o = Y * W;
    for (let X = 0; X < W; X++) {
      const near = data[rn + nxs[X]];
      if (near - near !== 0) { out[o + X] = NaN; continue; }
      const fx = fxs[X], x0 = x0s[X], x1 = x1s[X];
      const a = data[r0 + x0], b = data[r0 + x1], c = data[r1 + x0], d = data[r1 + x1];
      const wa = (1 - fx) * (1 - fy), wb = fx * (1 - fy), wc = (1 - fx) * fy, wd = fx * fy;
      let s = 0, n = 0;
      if (a - a === 0 && wa > 0) { s += a * wa; n += wa; }
      if (b - b === 0 && wb > 0) { s += b * wb; n += wb; }
      if (c - c === 0 && wc > 0) { s += c * wc; n += wc; }
      if (d - d === 0 && wd > 0) { s += d * wd; n += wd; }
      out[o + X] = n ? s / n : near;
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
    const l = log && hi > 0 ? Math.log10(logLo(lo, hi)) : 0;
    return log && hi > 0 ? 10 ** (l + f * (Math.log10(hi) - l)) : lo + f * (hi - lo);
  });

/** Relative luminance of a #rrggbb color (0 dark .. 1 light). */
export const luminance = (hex: string): number => {
  const n = parseInt(hex.replace("#", ""), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};
