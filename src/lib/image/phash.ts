// Perceptual hashing for near-duplicate detection (pure, DOM-free).
// Feed it the RGBA of a downscaled image (e.g. the 512px thumb canvas) → toGrayscale → dhash.

/**
 * RGBA (canvas ImageData layout) → luma 0..255 (Rec. 601). Transparent pixels are
 * composited over white so transparent PNG screenshots hash like they display.
 */
export function toGrayscale(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Float32Array {
  const n = w * h;
  if (rgba.length < n * 4) throw new RangeError("rgba buffer smaller than w*h*4");
  const out = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const luma = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    const a = rgba[p + 3] / 255;
    out[i] = luma * a + 255 * (1 - a);
  }
  return out;
}

/** Per target index: first source index + fractional coverage weights (sum to 1). */
function areaWeights(src: number, dst: number): { start: number; weights: number[] }[] {
  const scale = src / dst;
  const res: { start: number; weights: number[] }[] = [];
  for (let t = 0; t < dst; t++) {
    const a = t * scale;
    const b = (t + 1) * scale;
    const start = Math.floor(a);
    const end = Math.min(src, Math.ceil(b));
    const weights: number[] = [];
    for (let s = start; s < end; s++) {
      weights.push((Math.min(b, s + 1) - Math.max(a, s)) / scale);
    }
    res.push({ start, weights });
  }
  return res;
}

/**
 * Resizes a grayscale image with area averaging (box filter with fractional coverage).
 * Works for down- and up-scaling; downscaling is the intended use.
 */
export function resizeGray(gray: Float32Array, w: number, h: number, tw: number, th: number): Float32Array {
  if (w < 1 || h < 1 || tw < 1 || th < 1) throw new RangeError("dimensions must be >= 1");
  if (gray.length < w * h) throw new RangeError("gray buffer smaller than w*h");
  const xw = areaWeights(w, tw);
  const yw = areaWeights(h, th);
  // Horizontal pass: h rows × tw cols.
  const tmp = new Float32Array(tw * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let tx = 0; tx < tw; tx++) {
      const { start, weights } = xw[tx];
      let acc = 0;
      for (let k = 0; k < weights.length; k++) acc += gray[row + start + k] * weights[k];
      tmp[y * tw + tx] = acc;
    }
  }
  // Vertical pass.
  const out = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const { start, weights } = yw[ty];
    for (let tx = 0; tx < tw; tx++) {
      let acc = 0;
      for (let k = 0; k < weights.length; k++) acc += tmp[(start + k) * tw + tx] * weights[k];
      out[ty * tw + tx] = acc;
    }
  }
  return out;
}

/**
 * 64-bit difference hash: resize to 9×8, bit = (left pixel > right pixel) for each of the
 * 8 adjacent pairs per row, rows top→bottom, MSB first. Returns 16 lowercase hex chars.
 * Insensitive to size and uniform brightness changes; compare with `hamming`.
 */
export function dhash(gray: Float32Array, w: number, h: number): string {
  const small = resizeGray(gray, w, h, 9, 8);
  let hex = "";
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) {
      const i = y * 9 + x;
      byte = (byte << 1) | (small[i] > small[i + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

const NIBBLE_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Number of differing bits between two equal-length hex hashes (0–64 for dhash). */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) throw new RangeError("hash lengths differ");
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16);
    const y = parseInt(b[i], 16);
    if (Number.isNaN(x) || Number.isNaN(y)) throw new RangeError("not a hex hash");
    d += NIBBLE_BITS[x ^ y];
  }
  return d;
}
