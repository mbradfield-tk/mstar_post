// In-plane flow visualisation on a vector plane: evenly spaced streamlines and
// line integral convolution (LIC). Grid coordinates: x = column (u), y = row (v),
// row 0 at the lowest v (as in Plane.data).
export type Vec2 = { w: number; h: number; u: Float32Array; v: Float32Array; du: number; dv: number };

// bilinear (u, v) at grid point (x, y), converted to cells per unit time, into su / sv;
// false outside or at NaN (no tuple per sample: this runs ~80 times per LIC pixel)
let su = 0, sv = 0;
function sample(f: Vec2, x: number, y: number): boolean {
  if (!(x >= 0 && y >= 0 && x <= f.w - 1 && y <= f.h - 1)) return false;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, f.w - 1), y1 = Math.min(y0 + 1, f.h - 1);
  const fx = x - x0, fy = y - y0;
  const i00 = y0 * f.w + x0, i10 = y0 * f.w + x1, i01 = y1 * f.w + x0, i11 = y1 * f.w + x1;
  const a = f.u[i00], b = f.u[i10], c = f.u[i01], d = f.u[i11];
  const p = f.v[i00], q = f.v[i10], r = f.v[i01], s = f.v[i11];
  const u = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  const v = (p * (1 - fx) + q * fx) * (1 - fy) + (r * (1 - fx) + s * fx) * fy;
  if (u - u !== 0 || v - v !== 0) return false;
  su = u / f.du;
  sv = v / f.dv;
  return true;
}

function maxSpeed(f: Vec2): number {
  let m = 0;
  for (let i = 0; i < f.u.length; i++) {
    const a = f.u[i] / f.du, b = f.v[i] / f.dv, s = Math.sqrt(a * a + b * b);
    if (s > m) m = s;
  }
  return m;
}

// unit-length RK2 step of h cells along the field (dir = +1 / -1) into px / py
let px = 0, py = 0;
function step(f: Vec2, x: number, y: number, h: number, dir: number, eps: number): boolean {
  if (!sample(f, x, y)) return false;
  const ax = su, ay = sv, sa = Math.sqrt(ax * ax + ay * ay);
  if (sa <= eps) return false;
  if (!sample(f, x + dir * 0.5 * h * ax / sa, y + dir * 0.5 * h * ay / sa)) return false;
  const sb = Math.sqrt(su * su + sv * sv);
  if (sb <= eps) return false;
  px = x + dir * h * su / sb;
  py = y + dir * h * sv / sb;
  return true;
}

/** Evenly spaced streamlines (about `density` lines across the larger side);
 *  each polyline is [x0, y0, x1, y1, ...] ordered along the flow. */
export function traceStreamlines(f: Vec2, density = 30): Float32Array[] {
  const sep = Math.max(f.w, f.h) / Math.max(4, density);
  const cell = sep / 2;
  const gw = Math.ceil(f.w / cell), gh = Math.ceil(f.h / cell);
  const occ = new Int32Array(gw * gh).fill(-1);
  const eps = maxSpeed(f) * 1e-4;
  const maxSteps = 4 * (f.w + f.h);
  // a line that finds no cell of its own for this many steps (4 cells of travel) is going
  // round a closed loop over itself: stop instead of retracing it up to maxSteps
  const stale = Math.ceil(8 * cell);
  const cellOf = (x: number, y: number) => Math.floor(y / cell) * gw + Math.floor(x / cell);
  const lines: Float32Array[] = [];
  for (let gy = 0; gy < gh; gy += 2) {
    for (let gx = 0; gx < gw; gx += 2) {
      const sx = (gx + 1) * cell, sy = (gy + 1) * cell;
      if (sx > f.w - 1 || sy > f.h - 1 || occ[cellOf(sx, sy)] >= 0) continue;
      const id = lines.length;
      const mine: number[] = [cellOf(sx, sy)];
      occ[mine[0]] = id;
      const half = (dir: number) => {
        const pts: number[] = [];
        let x = sx, y = sy, since = 0;
        for (let i = 0; i < maxSteps; i++) {
          if (!step(f, x, y, 0.5, dir, eps)) break;
          x = px; y = py;
          const c = cellOf(x, y);
          if (occ[c] < 0) { occ[c] = id; mine.push(c); since = 0; }
          else if (occ[c] !== id || ++since > stale) break;
          pts.push(x, y);
        }
        return pts;
      };
      const back = half(-1), fwd = half(1);
      if (back.length + fwd.length < 8) {
        for (const c of mine) occ[c] = -1;
        continue;
      }
      const out = new Float32Array(back.length + 2 + fwd.length);
      for (let i = 0, j = back.length - 2; j >= 0; j -= 2, i += 2) { out[i] = back[j]; out[i + 1] = back[j + 1]; }
      out[back.length] = sx;
      out[back.length + 1] = sy;
      out.set(fwd, back.length + 2);
      lines.push(out);
    }
  }
  return lines;
}

// white noise of the LIC, the same for every strip of an image (remembered for the last size)
let noiseOf: { n: number; seed: number; a: Float32Array } | null = null;
function licNoise(n: number, seed: number): Float32Array {
  if (noiseOf && noiseOf.n === n && noiseOf.seed === seed) return noiseOf.a;
  const a = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    a[i] = s / 4294967296;
  }
  noiseOf = { n, seed, a };
  return a;
}

/** Rows first, first + every, ... of the averaged noise (not yet stretched) of the LIC image at
 *  `scale` x the grid resolution: box kernel of L steps of half an output pixel each way, NaN outside
 *  the fluid. Interleaved rows of one image can be computed by several workers and joined (lic.ts):
 *  every worker then gets the same share of the fluid, wherever it is in the plane. */
export function licRows(f: Vec2, scale: number, L: number, first = 0, every = 1, seed = 12345): Float32Array {
  const W = f.w * scale, H = f.h * scale;
  const noise = licNoise(W * H, seed);
  const eps = maxSpeed(f) * 1e-4;
  const out = new Float32Array(W * Math.ceil((H - first) / every));
  const h = 0.5 / scale;
  for (let Y = first, o = 0; Y < H; Y += every, o += W) {
    for (let X = 0; X < W; X++) {
      const sx = Math.min(Math.max((X + 0.5) / scale - 0.5, 0), f.w - 1), sy = Math.min(Math.max((Y + 0.5) / scale - 0.5, 0), f.h - 1);
      if (!sample(f, sx, sy)) {
        out[o + X] = NaN;
        continue;
      }
      let sum = noise[Y * W + X], n = 1;
      for (let dir = 1; dir >= -1; dir -= 2) {
        let x = sx, y = sy;
        for (let i = 0; i < L; i++) {
          if (!step(f, x, y, h, dir, eps)) break;
          x = px; y = py;
          const qx = Math.min(W - 1, Math.max(0, Math.round((x + 0.5) * scale - 0.5)));
          const qy = Math.min(H - 1, Math.max(0, Math.round((y + 0.5) * scale - 0.5)));
          sum += noise[qy * W + qx];
          n++;
        }
      }
      out[o + X] = sum / n;
    }
  }
  return out;
}

/** Stretch the narrow distribution of the averaged noise of a whole image to 0..1 (in place). */
export function licFinish(out: Float32Array): Float32Array {
  let m = 0, m2 = 0, c = 0;
  for (let i = 0; i < out.length; i++) { const v = out[i]; if (v === v) { m += v; m2 += v * v; c++; } }
  if (c) {
    m /= c;
    const sd = Math.sqrt(Math.max(m2 / c - m * m, 1e-12));
    for (let i = 0; i < out.length; i++) {
      if (out[i] === out[i]) out[i] = Math.min(1, Math.max(0, 0.5 + 0.2 * (out[i] - m) / sd));
    }
  }
  return out;
}

/** LIC intensity (0..1, NaN outside the fluid) at `scale` x the grid resolution. */
export const lic = (f: Vec2, scale = 2, L = 20, seed = 12345): Float32Array =>
  licFinish(licRows(f, scale, L, 0, 1, seed));
