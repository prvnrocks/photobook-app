// Pixel size from the file header, WITHOUT decoding (S6). Pure and DOM-free so it runs in
// node tests; resize.ts uses it to refuse > 100 MP photos before the browser allocates a
// full bitmap, and to decode 16–100 MP photos straight at a reduced size.
//
// Supported: JPEG (SOFn marker + EXIF Orientation from APP1), PNG (IHDR, eXIf presence),
// WebP (VP8 / VP8L / VP8X), HEIF/HEIC/AVIF (`ispe` boxes in meta/iprp/ipco). Everything
// else, or a header that doesn't fit in the first HEADER_SCAN_BYTES, → null (caller then
// decodes as before and checks the size afterwards).

/** The first 256 KB hold the size for every format above (JPEG APP segments are ≤ 64 KB each). */
export const HEADER_SCAN_BYTES = 256 * 1024;

export interface HeaderSize {
  format: "jpeg" | "png" | "webp" | "heif";
  /** Stored (un-rotated) pixel size. width·height is orientation-independent. */
  width: number;
  height: number;
  /**
   * Whether the browser will display the image rotated by 90°/270° (axes swapped):
   * true / false when the header tells us, null when it can't be known cheaply
   * (HEIF `irot`, PNG/WebP with EXIF).
   */
  swapsAxes: boolean | null;
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u32le = (b: Uint8Array, o: number) => u16le(b, o) + u16le(b, o + 2) * 0x10000;
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

function valid(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
}

// ---------- JPEG ----------

/** EXIF Orientation (1–8) from an APP1 payload starting at "Exif\0\0", or null. */
function exifOrientation(b: Uint8Array, start: number, end: number): number | null {
  if (end - start < 14 || ascii(b, start, 4) !== "Exif" || b[start + 4] !== 0 || b[start + 5] !== 0) return null;
  const tiff = start + 6;
  const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const be = b[tiff] === 0x4d && b[tiff + 1] === 0x4d;
  if (!le && !be) return null;
  const r16 = (o: number) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o: number) => (le ? u32le(b, o) : u32be(b, o));
  if (r16(tiff + 2) !== 42) return null;
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return null;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

function jpegSize(b: Uint8Array): HeaderSize | null {
  let orientation: number | null = null;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null; // lost sync → not a well-formed header
    let marker = b[o + 1];
    while (marker === 0xff && o + 2 < b.length) {
      o += 1; // fill bytes
      marker = b[o + 1];
    }
    o += 2;
    // Standalone markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan before any SOF
    if (o + 2 > b.length) return null;
    const len = u16be(b, o);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (o + 7 > b.length) return null;
      const height = u16be(b, o + 3);
      const width = u16be(b, o + 5);
      if (!valid(width, height)) return null;
      return { format: "jpeg", width, height, swapsAxes: orientation !== null && orientation >= 5 };
    }
    if (marker === 0xe1 && orientation === null) {
      orientation = exifOrientation(b, o + 2, Math.min(b.length, o + len));
    }
    o += len;
  }
  return null;
}

// ---------- PNG ----------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(b: Uint8Array): HeaderSize | null {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  if (!valid(width, height)) return null;
  // eXIf must precede IDAT; walk the chunks until then.
  let swapsAxes: boolean | null = false;
  let o = 8;
  while (o + 8 <= b.length) {
    const len = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    if (type === "IDAT" || type === "IEND") break;
    if (type === "eXIf") {
      swapsAxes = null;
      break;
    }
    o += 12 + len;
    if (o > b.length) swapsAxes = null; // couldn't see far enough
  }
  return { format: "png", width, height, swapsAxes };
}

// ---------- WebP ----------

function webpSize(b: Uint8Array): HeaderSize | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  const d = 20; // chunk data
  if (chunk === "VP8 ") {
    // Frame tag (3 bytes) + start code 9d 01 2a, then 14-bit width/height (+2-bit scale).
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return null;
    const width = u16le(b, d + 6) & 0x3fff;
    const height = u16le(b, d + 8) & 0x3fff;
    return valid(width, height) ? { format: "webp", width, height, swapsAxes: false } : null;
  }
  if (chunk === "VP8L") {
    if (b[d] !== 0x2f) return null;
    const bits = u32le(b, d + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { format: "webp", width, height, swapsAxes: false };
  }
  if (chunk === "VP8X") {
    const hasExif = (b[d] & 0x08) !== 0;
    const width = u24le(b, d + 4) + 1;
    const height = u24le(b, d + 7) + 1;
    return { format: "webp", width, height, swapsAxes: hasExif ? null : false };
  }
  return null;
}

// ---------- HEIF (ISO BMFF) ----------

interface Box {
  type: string;
  /** Payload start / end (exclusive), clamped to the buffer. */
  start: number;
  end: number;
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let o = from;
  while (o + 8 <= to) {
    let size = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > to) return;
      const hi = u32be(b, o + 8);
      size = hi * 0x1_0000_0000 + u32be(b, o + 12);
      header = 16;
    } else if (size === 0) {
      size = to - o;
    }
    if (size < header) return;
    yield { type, start: o + header, end: Math.min(to, o + size) };
    o += size;
  }
}

function child(b: Uint8Array, parent: Box, type: string, fullBox = false): Box | null {
  for (const bx of boxes(b, parent.start + (fullBox ? 4 : 0), parent.end)) if (bx.type === type) return bx;
  return null;
}

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis"]);

function heifSize(b: Uint8Array): HeaderSize | null {
  const top = [...boxes(b, 0, b.length)];
  const ftyp = top[0];
  if (!ftyp || ftyp.type !== "ftyp") return null;
  const brands: string[] = [];
  for (let o = ftyp.start; o + 4 <= ftyp.end; o += 4) if (o !== ftyp.start + 4) brands.push(ascii(b, o, 4));
  if (!brands.some((x) => HEIF_BRANDS.has(x))) return null;

  const meta = top.find((x) => x.type === "meta") ?? null;
  const iprp = meta && child(b, meta, "iprp", true);
  const ipco = iprp && child(b, iprp, "ipco");
  if (!ipco) return null;

  // A HEIC has one ispe per item: the primary image (iPhone: a grid item), its 512×512
  // tiles, a thumbnail… The primary image is the largest — the right one to check.
  let best: { width: number; height: number } | null = null;
  let rotated = false;
  for (const p of boxes(b, ipco.start, ipco.end)) {
    if (p.type === "ispe" && p.start + 12 <= p.end) {
      const width = u32be(b, p.start + 4);
      const height = u32be(b, p.start + 8);
      if (valid(width, height) && (!best || width * height > best.width * best.height)) best = { width, height };
    } else if (p.type === "irot" && p.start < p.end && (b[p.start] & 0x03) % 2 === 1) {
      rotated = true; // may belong to any item (no ipma lookup) → treat as unknown
    }
  }
  if (!best) return null;
  return { format: "heif", ...best, swapsAxes: rotated ? null : false };
}

// ---------- entry points ----------

/** Pixel size from the first bytes of an image file, or null when unknown. Never throws. */
export function readHeaderSize(bytes: Uint8Array): HeaderSize | null {
  try {
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegSize(bytes);
    if (bytes.length >= 8 && PNG_SIG.every((v, i) => bytes[i] === v)) return pngSize(bytes);
    if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpSize(bytes);
    if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") return heifSize(bytes);
  } catch {
    // malformed header → unknown
  }
  return null;
}

/** Reads only the first HEADER_SCAN_BYTES of the file. */
export async function readBlobHeaderSize(blob: Blob): Promise<HeaderSize | null> {
  try {
    const buf = await blob.slice(0, HEADER_SCAN_BYTES).arrayBuffer();
    return readHeaderSize(new Uint8Array(buf));
  } catch {
    return null;
  }
}

export interface ReducedDecodeSize {
  resizeWidth: number;
  /** Omitted when the display orientation is unknown: the browser then keeps the aspect itself. */
  resizeHeight?: number;
}

/**
 * createImageBitmap resize options for decoding a > maxPixels image straight at ≤ maxPixels,
 * keeping the aspect ratio; null when it already fits.
 *
 * Browsers differ in whether resizeWidth/Height refer to the stored or the EXIF-rotated
 * size. When the image is (or may be) shown rotated, passing both would squash it, so we
 * pass only resizeWidth = the SHORT side scaled: whichever axis the browser calls "width",
 * the result stays ≤ maxPixels and is never distorted (at worst a bit smaller).
 */
export function reducedDecodeSize(h: Pick<HeaderSize, "width" | "height" | "swapsAxes">, maxPixels: number): ReducedDecodeSize | null {
  const { width: w, height: hh } = h;
  if (!valid(w, hh) || w * hh <= maxPixels) return null;
  const scale = Math.sqrt(maxPixels / (w * hh));
  if (h.swapsAxes === false) {
    let width = Math.max(1, Math.floor(w * scale));
    let height = Math.max(1, Math.floor(hh * scale));
    while (width * height > maxPixels && width > 1) {
      width -= 1;
      height = Math.max(1, Math.floor((width * hh) / w));
    }
    return { resizeWidth: width, resizeHeight: height };
  }
  const short = Math.min(w, hh);
  const long = Math.max(w, hh);
  let resizeWidth = Math.max(1, Math.floor(short * scale));
  // Browsers round the derived side UP (Chromium: 3464 → 4619 for 6048×8064).
  while (resizeWidth > 1 && resizeWidth * Math.ceil((resizeWidth * long) / short) > maxPixels) resizeWidth -= 1;
  return { resizeWidth };
}

/**
 * Display-oriented full size of the file, given its stored header size and the
 * (display-oriented) size of a reduced decode: picks the axis order whose aspect matches.
 */
export function displaySizeFromDecode(
  stored: { width: number; height: number },
  decoded: { width: number; height: number },
): { width: number; height: number } {
  const a = decoded.width / decoded.height;
  const same = Math.abs(a - stored.width / stored.height);
  const swapped = Math.abs(a - stored.height / stored.width);
  return swapped < same ? { width: stored.height, height: stored.width } : { width: stored.width, height: stored.height };
}
