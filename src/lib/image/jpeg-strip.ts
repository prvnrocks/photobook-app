// Lossless JPEG metadata stripper. Pure and DOM-free (node + browser).
//
// Used for the AI analysis copy (the 512 px thumb): before the bytes leave our storage for the
// model, every segment that can carry personal data is removed — EXIF (APP1: GPS, capture time,
// camera, embedded preview), XMP (APP1), IPTC / Photoshop (APP13), comments (COM) and all other
// application segments. Kept: JFIF (APP0), ICC profile (APP2 "ICC_PROFILE") and the Adobe marker
// (APP14) — decoders need those for correct colours. The compressed image data is copied byte
// for byte, so the pixels are unchanged.
//
// Never throws: a malformed file returns null (the caller then refuses to send it).

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const COM = 0xfe;

export interface StripResult {
  bytes: Uint8Array;
  /** Number of metadata segments removed (0 = input was already clean; `bytes` is the input). */
  removed: number;
  /** Pixel size from the SOFn marker. */
  width: number;
  height: number;
}

const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
const isStandalone = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);
const startsWith = (b: Uint8Array, at: number, text: string) => {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

function keepSegment(marker: number, b: Uint8Array, payloadAt: number): boolean {
  if (marker === COM) return false;
  if (marker >= 0xe0 && marker <= 0xef) {
    if (marker === 0xe0) return startsWith(b, payloadAt, "JFIF\0") || startsWith(b, payloadAt, "JFXX\0");
    if (marker === 0xe2) return startsWith(b, payloadAt, "ICC_PROFILE\0");
    if (marker === 0xee) return startsWith(b, payloadAt, "Adobe");
    return false;
  }
  return true; // DQT, DHT, SOFn, DRI, …
}

export function stripJpegMetadata(input: Uint8Array): StripResult | null {
  const b = input;
  if (b.length < 4 || b[0] !== 0xff || b[1] !== SOI) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let removed = 0;
  let width = 0;
  let height = 0;
  let o = 2;
  while (o < b.length) {
    if (b[o] !== 0xff) return null;
    // fill bytes before a marker
    let m = o + 1;
    while (m < b.length && b[m] === 0xff) m++;
    if (m >= b.length) return null;
    const marker = b[m];
    if (marker === 0x00 || marker === SOI) return null;
    if (marker === EOI) return null; // no image data
    if (isStandalone(marker)) {
      parts.push(b.subarray(m - 1, m + 1));
      o = m + 1;
      continue;
    }
    if (m + 2 >= b.length) return null;
    const len = (b[m + 1] << 8) | b[m + 2];
    if (len < 2 || m + 1 + len > b.length) return null;
    if (marker === SOS) {
      if (width === 0) return null; // scan before a frame header
      // header + entropy-coded data + everything after it (EOI) verbatim, minus trailing junk
      // after the LAST EOI (some writers append metadata blobs behind the image).
      let end = b.length;
      const lastEoi = lastIndexOfEoi(b, m + 1 + len);
      if (lastEoi === -1) return null;
      if (lastEoi + 2 < end) {
        end = lastEoi + 2;
        removed++;
      }
      parts.push(b.subarray(m - 1, end));
      const bytes = removed === 0 ? input : concat(parts);
      return { bytes, removed, width, height };
    }
    if (isSof(marker)) {
      if (len < 8) return null;
      height = (b[m + 4] << 8) | b[m + 5];
      width = (b[m + 6] << 8) | b[m + 7];
      if (width === 0 || height === 0) return null;
    }
    if (keepSegment(marker, b, m + 3)) parts.push(b.subarray(m - 1, m + 1 + len));
    else removed++;
    o = m + 1 + len;
  }
  return null; // ran out of data before the scan
}

function lastIndexOfEoi(b: Uint8Array, from: number): number {
  for (let i = b.length - 2; i >= from; i--) if (b[i] === 0xff && b[i + 1] === EOI) return i;
  return -1;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
