// M29 T1 (D-080) — autoPick:false covers are invisible to every automatic picker. With a test-only
// autoPick:false cover per design added to the catalogue (tests/fixtures/test-m29-covers.ts,
// prefers "any" so it WOULD win if a filter were missing) — appended (the real M29 position) and
// even placed before every real layout — bestCoverLayout, coverPhotoOrientation and the
// Storyteller catalogue / system text return exactly what the real catalogue returns, while
// coverStylesFor offers the extra cover to the editor and the frozen classic portrait prompt (v4)
// and classic landscape prompt (v5) fixtures still match byte for byte.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FitOrientation } from "@/lib/layouts/fit";
import { TEST_M29_COVERS, testCoverId } from "./fixtures/test-m29-covers";

vi.mock("server-only", () => ({}));

const STYLES = ["classic", "modern", "geometric", "scrapbook"] as const;
const FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const;
const DESIGNS = STYLES.flatMap((designStyle) => FORMATS.map((format) => ({ format, designStyle })));
const ORIENTS: (FitOrientation | null)[] = ["portrait", "landscape", "square", null];
const fixture = (f: string) => readFileSync(join(process.cwd(), "tests/fixtures/ai/storyteller", f), "utf8");

interface Snapshot {
  best: Record<string, string>;
  orient: Record<string, string | null>;
  catalogue: Record<string, string>;
  system: Record<string, string>;
  coverStyles: Record<string, string[]>;
}

/** Loads fit / storyteller / spreads fresh (after the current mocks) and records their answers. */
async function snapshot(): Promise<Snapshot> {
  const fit = await import("@/lib/layouts/fit");
  const st = await import("@/lib/ai/prompts/storyteller");
  const spreads = await import("@/lib/book/spreads");
  const out: Snapshot = { best: {}, orient: {}, catalogue: {}, system: {}, coverStyles: {} };
  for (const d of DESIGNS) {
    const k = `${d.designStyle}/${d.format}`;
    for (const o of ORIENTS) out.best[`${k} ${o}`] = fit.bestCoverLayout(d, o);
    out.orient[k] = fit.coverPhotoOrientation(d);
    out.catalogue[k] = st.layoutCatalogue(d);
    out.system[k] = st.storytellerSystemText(d);
    out.coverStyles[k] = spreads.coverStylesFor(d.format, d.designStyle).map((l) => l.id);
  }
  out.best.default = fit.bestCoverLayout();
  return out;
}

async function withMock(factory: "withTestCovers" | "withTestCoversFirst"): Promise<Snapshot> {
  vi.resetModules();
  vi.doMock("@/lib/layouts", async (orig) => {
    const fx = await import("./fixtures/test-m29-covers");
    return fx[factory](await orig<typeof import("@/lib/layouts")>());
  });
  return snapshot();
}

afterEach(() => {
  vi.doUnmock("@/lib/layouts");
  vi.resetModules();
});

describe("M29 autoPick:false covers are never picked automatically", () => {
  for (const factory of ["withTestCovers", "withTestCoversFirst"] as const) {
    it(`${factory}: same bestCoverLayout / coverPhotoOrientation / Storyteller text as the real catalogue`, async () => {
      vi.resetModules();
      const real = await snapshot();
      const mocked = await withMock(factory);

      // The mock is live: the editor's cover list offers the extra cover for every design.
      for (const d of DESIGNS) {
        const k = `${d.designStyle}/${d.format}`;
        const id = testCoverId(d.designStyle, d.format);
        expect(mocked.coverStyles[k]).toContain(id);
        expect(real.coverStyles[k]).not.toContain(id);
        expect(mocked.catalogue[k]).not.toContain(id);
      }
      expect(TEST_M29_COVERS).toHaveLength(8);

      expect(mocked.best).toEqual(real.best);
      expect(mocked.orient).toEqual(real.orient);
      expect(mocked.catalogue).toEqual(real.catalogue);
      expect(mocked.system).toEqual(real.system);
      expect(mocked.best.default).toBe("cover");
      expect(mocked.system["classic/A5_PORTRAIT"]).toBe(fixture("system-v4-classic-portrait.txt"));
      expect(mocked.system["classic/A5_LANDSCAPE"]).toBe(fixture("system-v5-classic-landscape.txt"));
    });
  }

  it("without the filter the extra cover WOULD be picked (the mock is a real trap)", async () => {
    await withMock("withTestCoversFirst");
    const spreads = await import("@/lib/book/spreads");
    for (const d of DESIGNS) {
      // First one-photo cover in catalogue order = what an unfiltered bestCoverLayout(d, null) returns.
      const first = spreads.coverStylesFor(d.format, d.designStyle).find((l) => l.photoCount === 1);
      expect(first?.id).toBe(testCoverId(d.designStyle, d.format));
      expect(spreads.autoCoversFor(d.format, d.designStyle).map((l) => l.id)).not.toContain(first?.id);
    }
  });
});
