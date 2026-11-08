// Deterministic synthetic grayscale/RGBA images for image-module tests.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A "photo-like" scene: background gradient + a few soft blobs, as RGBA. */
export function scene(seed: number, w = 256, h = 192): Uint8ClampedArray {
  const rnd = mulberry32(seed);
  const blobs = Array.from({ length: 14 }, () => ({
    x: rnd() * w,
    y: rnd() * h,
    r: (0.04 + rnd() * 0.12) * w,
    c: [rnd() * 255, rnd() * 255, rnd() * 255],
    s: rnd() > 0.5 ? 1 : -1,
  }));
  const gx = rnd() * 2 - 1;
  const gy = rnd() * 2 - 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const base = 128 + 30 * gx * (x / w - 0.5) * 2 + 30 * gy * (y / h - 0.5) * 2;
      const px = [base, base, base];
      for (const b of blobs) {
        const d2 = ((x - b.x) ** 2 + (y - b.y) ** 2) / (b.r * b.r);
        const k = Math.exp(-d2) * b.s * 1.6;
        for (let c = 0; c < 3; c++) px[c] += k * (b.c[c] - 64);
      }
      const p = (y * w + x) * 4;
      out[p] = px[0];
      out[p + 1] = px[1];
      out[p + 2] = px[2];
      out[p + 3] = 255;
    }
  }
  return out;
}

export function adjust(rgba: Uint8ClampedArray, brighten: number, noise: number, seed = 7): Uint8ClampedArray {
  const rnd = mulberry32(seed);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = rgba[i + c] + brighten + (rnd() * 2 - 1) * noise;
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

export function checkerboard(w: number, h: number, cell: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out[y * w + x] = ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) * 255;
  return out;
}

export function noiseGray(w: number, h: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  return Float32Array.from({ length: w * h }, () => rnd() * 255);
}

/** Separable box blur with clamped edges, radius r. */
export function boxBlur(gray: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const clamp = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += gray[y * w + clamp(x + k, w - 1)];
      tmp[y * w + x] = s / (2 * r + 1);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[clamp(y + k, h - 1) * w + x];
      out[y * w + x] = s / (2 * r + 1);
    }
  return out;
}
