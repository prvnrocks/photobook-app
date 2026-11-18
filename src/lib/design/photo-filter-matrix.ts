// Photo filters as colour maths (D-089): each CSS filter function as a 3×3 matrix + offset, and a
// filter's functions composed into one affine transform — what the PDF export bakes into the print
// copy of a photo (lib/pdf/images.ts). Split from photo-filters.ts so the editor / viewer bundles
// carry only the catalogue and the CSS string. Pure, no DOM, no sharp.

import { photoFilterById, type FilterOp } from "./photo-filters";

/** Row-major 3×3 colour matrix. */
export type Matrix3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
/** out = matrix · rgb + offset, channels 0..1, clamped once at the end. */
export interface FilterAffine {
  matrix: Matrix3;
  offset: readonly [number, number, number];
}

const IDENTITY: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const scale = (k: number): Matrix3 => [
  [k, 0, 0],
  [0, k, 0],
  [0, 0, k],
];

/** The colour matrix of one function (W3C Filter Effects 1, §"Filter primitives" shorthands). */
function opMatrix([fn, v]: FilterOp): FilterAffine {
  switch (fn) {
    case "brightness":
      return { matrix: scale(v), offset: [0, 0, 0] };
    case "contrast": {
      const o = 0.5 * (1 - v);
      return { matrix: scale(v), offset: [o, o, o] };
    }
    case "saturate":
      return {
        matrix: [
          [0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v],
          [0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v],
          [0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v],
        ],
        offset: [0, 0, 0],
      };
    case "grayscale": {
      const k = 1 - Math.min(1, Math.max(0, v));
      return {
        matrix: [
          [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k],
          [0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k],
          [0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k],
        ],
        offset: [0, 0, 0],
      };
    }
    case "sepia": {
      const k = 1 - Math.min(1, Math.max(0, v));
      return {
        matrix: [
          [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k],
          [0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k],
          [0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k],
        ],
        offset: [0, 0, 0],
      };
    }
    case "hueRotate": {
      const a = (v * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      return {
        matrix: [
          [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
          [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
          [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
        ],
        offset: [0, 0, 0],
      };
    }
  }
}

/** b after a: (Mb, ob) ∘ (Ma, oa) = (Mb·Ma, Mb·oa + ob). */
function compose(a: FilterAffine, b: FilterAffine): FilterAffine {
  const row = (i: 0 | 1 | 2): [number, number, number] => [0, 1, 2].map((j) => b.matrix[i][0] * a.matrix[0][j] + b.matrix[i][1] * a.matrix[1][j] + b.matrix[i][2] * a.matrix[2][j]) as [number, number, number];
  const off = (i: 0 | 1 | 2) => b.matrix[i][0] * a.offset[0] + b.matrix[i][1] * a.offset[1] + b.matrix[i][2] * a.offset[2] + b.offset[i];
  return { matrix: [row(0), row(1), row(2)], offset: [off(0), off(1), off(2)] };
}

/** The filter as one affine colour transform (PDF print copies); null for none / unknown. */
export function filterAffine(id: string | null | undefined): FilterAffine | null {
  const f = photoFilterById(id);
  if (!f) return null;
  return f.ops.map(opMatrix).reduce(compose, { matrix: IDENTITY, offset: [0, 0, 0] });
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Apply an affine to one colour (0..1 channels), clamped. Exported for tests. */
export function applyAffine(t: FilterAffine, rgb: readonly [number, number, number]): [number, number, number] {
  return [0, 1, 2].map((i) => clamp01(t.matrix[i][0] * rgb[0] + t.matrix[i][1] * rgb[1] + t.matrix[i][2] * rgb[2] + t.offset[i])) as [number, number, number];
}

/** What the browser does: every function in turn, clamped after each. Exported for tests. */
export function applyCssOps(id: string, rgb: readonly [number, number, number]): [number, number, number] {
  const f = photoFilterById(id);
  let out: [number, number, number] = [rgb[0], rgb[1], rgb[2]];
  for (const op of f?.ops ?? []) out = applyAffine(opMatrix(op), out);
  return out;
}
