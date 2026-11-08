import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FINGERPRINT_EDGE_BYTES, fingerprint } from "@/lib/image/fingerprint";
import { Sha256, sha256Hex } from "@/lib/image/sha256";
import { mulberry32 } from "./helpers/synthetic-images";

const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function bytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (rnd() * 256) | 0;
  return out;
}

function sizeBE(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/** Reference implementation of the documented s1 scheme with node:crypto. */
function expected(data: Uint8Array): string {
  const h = createHash("sha256");
  if (data.length <= FINGERPRINT_EDGE_BYTES * 2) h.update(data);
  else h.update(data.subarray(0, FINGERPRINT_EDGE_BYTES)).update(data.subarray(data.length - FINGERPRINT_EDGE_BYTES));
  return "s1:" + h.update(sizeBE(data.length)).digest("hex");
}

describe("pure-JS SHA-256", () => {
  it("matches known vectors", () => {
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it.each([0, 1, 55, 56, 63, 64, 65, 119, 1000, 100_000, 8 * 1024 * 1024 + 13])(
    "matches node crypto for %i bytes",
    (n) => {
      const data = bytes(n, n + 1);
      expect(sha256Hex(data)).toBe(nodeSha(data));
    },
  );

  it("gives the same digest for arbitrary update splits", () => {
    const data = bytes(5000, 9);
    const h = new Sha256();
    for (const [a, b] of [[0, 1], [1, 63], [63, 64], [64, 200], [200, 3333], [3333, 5000]])
      h.update(data.subarray(a, b));
    expect(Buffer.from(h.digest()).toString("hex")).toBe(nodeSha(data));
  });
});

describe("fingerprint", () => {
  const subtle = webcrypto.subtle as unknown as SubtleCrypto;

  it.each([0, 10, 4096, FINGERPRINT_EDGE_BYTES * 2, FINGERPRINT_EDGE_BYTES * 2 + 1, 9 * 1024 * 1024 + 7])(
    "s1 scheme for %i bytes, WebCrypto and JS fallback agree",
    async (n) => {
      const data = bytes(n, n + 3);
      const blob = new Blob([data]);
      const want = expected(data);
      expect(want).toMatch(/^s1:[0-9a-f]{64}$/);
      expect(await fingerprint(blob, { subtle })).toBe(want);
      expect(await fingerprint(blob, { subtle: null })).toBe(want);
    },
  );

  it("uses globalThis.crypto.subtle by default", async () => {
    const data = bytes(1234, 5);
    expect(await fingerprint(new Blob([data]))).toBe(expected(data));
  });

  it("differs when the middle is identical but size differs, and ignores the unhashed middle", async () => {
    const n = FINGERPRINT_EDGE_BYTES * 2 + 1000;
    const a = bytes(n, 1);
    const b = new Uint8Array(a);
    b[FINGERPRINT_EDGE_BYTES + 500] ^= 0xff; // inside the unsampled middle → same fingerprint (documented)
    expect(await fingerprint(new Blob([a]), { subtle: null })).toBe(await fingerprint(new Blob([b]), { subtle: null }));
    const c = new Uint8Array(a);
    c[10] ^= 1;
    expect(await fingerprint(new Blob([c]))).not.toBe(await fingerprint(new Blob([a])));
  });

  it("falls back to JS when subtle.digest throws", async () => {
    const broken = { digest: () => Promise.reject(new Error("nope")) } as unknown as SubtleCrypto;
    const data = bytes(300, 2);
    expect(await fingerprint(new Blob([data]), { subtle: broken })).toBe(expected(data));
  });
});
