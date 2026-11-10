// M8 T7: exports bucket helpers (src/lib/db/exports.ts) + listPrintPhotoSources (src/lib/db/print.ts)
// over a mocked admin client.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type StorageResult = { data?: unknown; error: { statusCode?: string; message?: string } | null };

const fake = vi.hoisted(() => {
  const state = {
    storage: [] as { bucket: string; op: string; args: unknown[] }[],
    storageResults: [] as StorageResult[],
    chains: [] as { table: string; calls: unknown[][] }[],
    results: [] as { data?: unknown; error: { code?: string } | null }[],
  };
  const next = () => Promise.resolve(state.storageResults.shift() ?? { data: null, error: null });
  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: (...args: unknown[]) => (state.storage.push({ bucket, op: "upload", args }), next()),
        remove: (...args: unknown[]) => (state.storage.push({ bucket, op: "remove", args }), next()),
        createSignedUrl: (...args: unknown[]) => (state.storage.push({ bucket, op: "sign", args }), next()),
      }),
    },
    from: (table: string) => {
      const entry = { table, calls: [] as unknown[][] };
      state.chains.push(entry);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "in"]) {
        b[m] = (...args: unknown[]) => {
          entry.calls.push([m, ...args]);
          return b;
        };
      }
      b.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(state.results.shift() ?? { data: [], error: null }).then(resolve, reject);
      return b;
    },
  };
  return { state, client };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.client }));

import {
  EXPORTS_BUCKET,
  EXPORT_MAX_BYTES,
  ExportStorageError,
  removeExportObjects,
  signExportUrl,
  uploadExportPdf,
} from "@/lib/db/exports";
import { listPrintPhotoSources } from "@/lib/db/print";

const U = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const PATH = `${U}/${B}/33333333-3333-4333-8333-333333333333.pdf`;
const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BYTES = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  fake.state.storage.length = 0;
  fake.state.storageResults.length = 0;
  fake.state.chains.length = 0;
  fake.state.results.length = 0;
});

describe("exports bucket", () => {
  it("bucket name and the 0200 size limit", () => {
    expect(EXPORTS_BUCKET).toBe("exports");
    expect(EXPORT_MAX_BYTES).toBe(52428800);
  });

  it("uploads application/pdf without upsert", async () => {
    await uploadExportPdf(PATH, BYTES);
    expect(fake.state.storage).toEqual([
      { bucket: "exports", op: "upload", args: [PATH, BYTES, { contentType: "application/pdf", upsert: false, cacheControl: "0" }] },
    ]);
  });

  it("409 (leftover of an earlier attempt) → remove + one retry", async () => {
    fake.state.storageResults.push({ error: { statusCode: "409" } }, { data: [], error: null }, { data: {}, error: null });
    await uploadExportPdf(PATH, BYTES);
    expect(fake.state.storage.map((s) => s.op)).toEqual(["upload", "remove", "upload"]);
  });

  it("other upload errors throw a code-only error (no path)", async () => {
    fake.state.storageResults.push({ error: { statusCode: "413", message: `too big ${PATH}` } });
    const err = await uploadExportPdf(PATH, BYTES).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportStorageError);
    expect((err as ExportStorageError).code).toBe("413");
    expect((err as Error).message).not.toContain(U);
  });

  it("removes in batches of 100", async () => {
    await removeExportObjects(Array.from({ length: 150 }, (_, i) => `${U}/${B}/${i}.pdf`));
    expect(fake.state.storage.map((s) => (s.args[0] as string[]).length)).toEqual([100, 50]);
  });

  it("signs with a download filename; missing object → null; other errors throw", async () => {
    fake.state.storageResults.push({ data: { signedUrl: "https://x/signed" }, error: null });
    expect(await signExportUrl(PATH, 600, "book.pdf")).toBe("https://x/signed");
    expect(fake.state.storage[0].args).toEqual([PATH, 600, { download: "book.pdf" }]);

    fake.state.storageResults.push({ error: { statusCode: "404", message: "Object not found" } });
    expect(await signExportUrl(PATH, 600, "book.pdf")).toBeNull();
    fake.state.storageResults.push({ error: { statusCode: "400", message: "Object not found" } });
    expect(await signExportUrl(PATH, 600, "book.pdf")).toBeNull();

    fake.state.storageResults.push({ error: { statusCode: "500", message: "boom" } });
    await expect(signExportUrl(PATH, 600, "book.pdf")).rejects.toBeInstanceOf(ExportStorageError);
  });
});

describe("listPrintPhotoSources", () => {
  it("filters by book AND owner, ready with an original; dedupes ids; drops malformed ids", async () => {
    fake.state.results.push({
      data: [
        { id: P(1), width: 10, height: 20, original_path: `${U}/${B}/${P(1)}-original.jpg` },
        { id: P(2), width: null, height: null, original_path: null },
      ],
      error: null,
    });
    const rows = await listPrintPhotoSources(B, U, [P(1), P(1), "nope", P(2)]);
    expect(rows).toEqual([{ id: P(1), width: 10, height: 20, original_path: `${U}/${B}/${P(1)}-original.jpg` }]);
    expect(fake.state.chains[0].table).toBe("photos");
    expect(fake.state.chains[0].calls).toEqual([
      ["select", "id, width, height, original_path"],
      ["eq", "book_id", B],
      ["eq", "user_id", U],
      ["eq", "upload_state", "ready"],
      ["not", "original_path", "is", null],
      ["in", "id", [P(1), P(2)]],
    ]);
  });

  it("no query for bad book/user ids or no ids", async () => {
    expect(await listPrintPhotoSources("x", U, [P(1)])).toEqual([]);
    expect(await listPrintPhotoSources(B, "x", [P(1)])).toEqual([]);
    expect(await listPrintPhotoSources(B, U, [])).toEqual([]);
    expect(fake.state.chains).toHaveLength(0);
  });

  it("query errors carry the code only", async () => {
    fake.state.results.push({ error: { code: "42501" } });
    await expect(listPrintPhotoSources(B, U, [P(1)])).rejects.toThrow("(42501)");
  });
});
