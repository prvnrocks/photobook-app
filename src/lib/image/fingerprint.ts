// Content fingerprint for resumable upload / de-dup (D-013).
//
// Format: "s1:" + SHA-256 hex of   head ‖ tail ‖ size
//   head = first 4 MiB of the file (the whole file if it is ≤ 8 MiB)
//   tail = last 4 MiB (empty if the file is ≤ 8 MiB)
//   size = file size in bytes as a 64-bit big-endian integer
// Sampling keeps hashing fast on phones for 20–50 MB originals. Two different files
// with identical first+last 4 MiB and identical size would collide — acceptable for
// de-duplicating one user's own uploads. Bump the "s1:" prefix if the scheme changes.
import { Sha256, toHex } from "./sha256";

export const FINGERPRINT_PREFIX = "s1:";
export const FINGERPRINT_EDGE_BYTES = 4 * 1024 * 1024;

export interface FingerprintOptions {
  /** Override WebCrypto (tests). `null` forces the pure-JS fallback. */
  subtle?: SubtleCrypto | null;
}

function sizeBytes(size: number): Uint8Array {
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, Math.floor(size / 0x100000000));
  dv.setUint32(4, size >>> 0);
  return out;
}

async function parts(blob: Blob): Promise<Uint8Array[]> {
  const size = blob.size;
  const read = async (start: number, end: number) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
  if (size <= FINGERPRINT_EDGE_BYTES * 2) return [await read(0, size), sizeBytes(size)];
  return [
    await read(0, FINGERPRINT_EDGE_BYTES),
    await read(size - FINGERPRINT_EDGE_BYTES, size),
    sizeBytes(size),
  ];
}

function defaultSubtle(): SubtleCrypto | null {
  // undefined in insecure contexts (plain-HTTP LAN), so check at call time.
  return globalThis.crypto?.subtle ?? null;
}

export async function fingerprint(blob: Blob, opts: FingerprintOptions = {}): Promise<string> {
  const chunks = await parts(blob);
  const subtle = opts.subtle === undefined ? defaultSubtle() : opts.subtle;
  if (subtle) {
    try {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.length;
      }
      const digest = await subtle.digest("SHA-256", buf);
      return FINGERPRINT_PREFIX + toHex(new Uint8Array(digest));
    } catch {
      // fall through to the JS implementation
    }
  }
  const h = new Sha256();
  for (const c of chunks) h.update(c);
  return FINGERPRINT_PREFIX + toHex(h.digest());
}
