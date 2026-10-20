// In-plane flow visualisation on a vector plane: evenly spaced streamlines and
// line integral convolution (LIC). Grid coordinates: x = column (u), y = row (v),
// row 0 at the lowest v (as in Plane.data).
export type Vec2 = { w: number; h: number; u: Float32Array; v: Float32Array; du: number; dv: number };

// bilinear (u, v) at grid point (x, y), converted to cells per unit time; null outside or at NaN
function sample(f: Vec2, x: number, y: number): [number, number] | null {
  if (!(x >= 0 && y >= 0 && x <= f.w - 1 && y <= f.h - 1)) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, f.w - 1), y1 = Math.min(y0 + 1, f.h - 1);
  const fx = x - x0, fy = y - y0;
  const i00 = y0 * f.w + x0, i10 = y0 * f.w + x1, i01 = y1 * f.w + x0, i11 = y1 * f.w + x1;
  const a = f.u[i00], b = f.u[i10], c = f.u[i01], d = f.u[i11];
  const p = f.v[i00], q = f.v[i10], r = f.v[i01], s = f.v[i11];
  const u = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  const v = (p * (1 - fx) + q * fx) * (1 - fy) + (r * (1 - fx) + s * fx) * fy;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return [u / f.du, v / f.dv];
}

function maxSpeed(f: Vec2): number {
  let m = 0;
  for (let i = 0; i < f.u.length; i++) {
    const s = Math.hypot(f.u[i] / f.du, f.v[i] / f.dv);
    if (s > m) m = s;
  }
  return m;
}

// unit-length RK2 step of h cells along the field (dir = +1 / -1)
function step(f: Vec2, x: number, y: number, h: number, dir: number, eps: number): [number, number] | null {
  const a = sample(f, x, y);
  if (!a) return null;
  const sa = Math.hypot(a[0], a[1]);
  if (sa <= eps) return null;
  const mx = x + dir * 0.5 * h * a[0] / sa, my = y + dir * 0.5 * h * a[1] / sa;
  const b = sample(f, mx, my);
  if (!b) return null;
  const sb = Math.hypot(b[0], b[1]);
  if (sb <= eps) return null;
  return [x + dir * h * b[0] / sb, y + dir * h * b[1] / sb];
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
  const cellOf = (x: number, y: number) => Math.floor(y / cell) * gw + Math.floor(x / cell);
  const lines: Float32Array[] = [];
  for (let gy = 0; gy < gh; gy += 2) {
    for (let gx = 0; gx < gw; gx += 2) {
      const sx = (gx + 1) * cell, sy = (gy + 1) * cell;
      if (sx > f.w - 1 || sy > f.h - 1 || occ[cellOf(sx, sy)] >= 0) continue;
      const id = lines.length;
      const half = (dir: number) => {
        const pts: number[] = [];
        let x = sx, y = sy;
        for (let i = 0; i < maxSteps; i++) {
          const n = step(f, x, y, 0.5, dir, eps);
          if (!n) break;
          [x, y] = n;
          const c = cellOf(x, y);
          if (occ[c] >= 0 && occ[c] !== id) break;
          pts.push(x, y);
        }
        return pts;
      };
      const back = half(-1), fwd = half(1);
      if (back.length + fwd.length < 8) continue;
      const out = new Float32Array(back.length + 2 + fwd.length);
      for (let i = 0, j = back.length - 2; j >= 0; j -= 2, i += 2) { out[i] = back[j]; out[i + 1] = back[j + 1]; }
      out[back.length] = sx;
      out[back.length + 1] = sy;
      out.set(fwd, back.length + 2);
      for (let i = 0; i < out.length; i += 2) occ[cellOf(out[i], out[i + 1])] = id;
      lines.push(out);
    }
  }
  return lines;
}

/** LIC intensity (0..1, NaN outside the fluid) at `scale` x the grid
 *  resolution, box kernel of L steps of half an output pixel each way. */
export function lic(f: Vec2, scale = 2, L = 20, seed = 12345): Float32Array {
  const W = f.w * scale, H = f.h * scale;
  const noise = new Float32Array(W * H);
  let s = seed >>> 0;
  for (let i = 0; i < noise.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    noise[i] = s / 4294967296;
  }
  const eps = maxSpeed(f) * 1e-4;
  const out = new Float32Array(W * H);
  const h = 0.5 / scale;
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      const gx = (X + 0.5) / scale - 0.5, gy = (Y + 0.5) / scale - 0.5;
      if (!sample(f, Math.min(Math.max(gx, 0), f.w - 1), Math.min(Math.max(gy, 0), f.h - 1))) {
        out[Y * W + X] = NaN;
        continue;
      }
      let sum = noise[Y * W + X], n = 1;
      for (const dir of [1, -1]) {
        let x = Math.min(Math.max(gx, 0), f.w - 1), y = Math.min(Math.max(gy, 0), f.h - 1);
        for (let i = 0; i < L; i++) {
          const p = step(f, x, y, h, dir, eps);
          if (!p) break;
          [x, y] = p;
          const px = Math.min(W - 1, Math.max(0, Math.round((x + 0.5) * scale - 0.5)));
          const py = Math.min(H - 1, Math.max(0, Math.round((y + 0.5) * scale - 0.5)));
          sum += noise[py * W + px];
          n++;
        }
      }
      out[Y * W + X] = sum / n;
    }
  }
  // stretch the narrow distribution of the averaged noise to the full range
  let m = 0, m2 = 0, c = 0;
  for (const v of out) if (Number.isFinite(v)) { m += v; m2 += v * v; c++; }
  if (c) {
    m /= c;
    const sd = Math.sqrt(Math.max(m2 / c - m * m, 1e-12));
    for (let i = 0; i < out.length; i++) {
      if (Number.isFinite(out[i])) out[i] = Math.min(1, Math.max(0, 0.5 + 0.2 * (out[i] - m) / sd));
    }
  }
  return out;
}
