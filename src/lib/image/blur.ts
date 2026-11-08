// Blur score = variance of the 3×3 Laplacian (pure, DOM-free). Higher = sharper.
//
// Scores depend on resolution: only compare scores computed at the SAME image size
// (callers pass the grayscale of the downscaled thumb, longest side ≤512px, e.g. via
// toGrayscale/resizeGray from ./phash). Expects luma in 0..255.

/** Kernel [0 1 0; 1 -4 1; 0 1 0] over interior pixels; returns the variance of the response. */
export function laplacianVariance(gray: Float32Array, w: number, h: number): number {
  if (gray.length < w * h) throw new RangeError("gray buffer smaller than w*h");
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  const n = (w - 2) * (h - 2);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v;
      sumSq += v * v;
    }
  }
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}
