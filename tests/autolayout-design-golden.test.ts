// Modern (portrait + landscape) and classic landscape output of the rule-based autolayout, Update
// album relayout, fillPages and the fit helpers is frozen (M10c T10): enabling geometric +
// scrapbook (shape-aware fitting, per-style spread rules) must not change one byte of what M10b
// designs get. Hashes captured at 57a540a (before T10). Classic A5 portrait has its own golden
// (autolayout-classic-golden.test.ts). Regenerate only for an intended change:
// GOLDEN_UPDATE=1 npx vitest run tests/autolayout-design-golden.test.ts

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autolayout, fillPages, type AutoPhoto } from "@/lib/autolayout";
import type { BookDesign } from "@/lib/book/book-design";
import { relayoutDoc, type RelayoutPhoto } from "@/lib/book/relayout";
import { stripPhotoFromDoc } from "@/lib/book/strip-photos";
import { bestCoverLayout, bestPageLayout, fullPageLayout, type FitOrientation } from "@/lib/layouts/fit";
import { momentSet, rng, SET_SIZES } from "./fixtures/autolayout-sets";

const FILE = join(__dirname, "fixtures", "autolayout-m10b-designs.golden.json");
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

const DESIGNS: readonly BookDesign[] = [
  { format: "A5_PORTRAIT", designStyle: "modern" },
  { format: "A5_LANDSCAPE", designStyle: "modern" },
  { format: "A5_LANDSCAPE", designStyle: "classic" },
];

function reviewed(photos: AutoPhoto[], seed: number): RelayoutPhoto[] {
  const r = rng(seed * 7 + 3);
  const changed = photos.map((p) => {
    const status: "kept" | "dropped" = p.status === "kept" ? (r() < 0.15 ? "dropped" : "kept") : r() < 0.5 ? "kept" : "dropped";
    return { ...p, status };
  });
  const extra = momentSet(Math.max(1, Math.floor(photos.length / 10)), seed + 1000).map((p) => ({
    ...p,
    id: `n-${p.id}`,
    status: "kept" as const,
  }));
  return [...changed, ...extra];
}

function cases(design: BookDesign): Record<string, string> {
  const out: Record<string, string> = {};
  const opts = { occasion: "travel" as const, title: null, captionLang: "en" as const, design };
  for (const n of SET_SIZES) {
    for (const seed of [1, 2]) {
      const photos = momentSet(n, seed * 100 + n);
      for (const isPaid of [false, true]) {
        const doc = autolayout(photos, { ...opts, isPaid });
        out[`auto:${n}:${seed}:${isPaid}`] = hash(doc);
        try {
          const r = relayoutDoc(doc, reviewed(photos, seed * 100 + n), { isPaid, maxPages: isPaid ? 100 : 20, captionLang: "en" });
          out[`relayout:${n}:${seed}:${isPaid}`] = hash(r);
        } catch (e) {
          out[`relayout:${n}:${seed}:${isPaid}`] = `error:${(e as Error).message}`;
        }
        // Photo-delete reflow (D-066) of the first and a middle placed photo.
        const placed = doc.pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((x): x is string => x !== null));
        const dims = photos.map((p) => ({ id: p.id, width: p.width, height: p.height, takenAt: p.takenAt }));
        for (const id of [placed[0], placed[Math.floor(placed.length / 2)]].filter((x): x is string => !!x)) {
          out[`strip:${n}:${seed}:${isPaid}:${id}`] = hash(stripPhotoFromDoc(doc, id, dims));
        }
      }
      out[`fill:${n}:${seed}`] = hash([
        fillPages(photos, { design }),
        fillPages(photos, { opener: true, prevLayout: "two-vertical", design }),
      ]);
    }
  }
  const O: FitOrientation[] = ["portrait", "landscape", "square"];
  const combos: FitOrientation[][] = [[]];
  for (let k = 1; k <= 6; k++) for (const c of combos.filter((x) => x.length === k - 1)) for (const o of O) combos.push([...c, o]);
  out.fit = hash(
    combos.map((c) => [
      bestPageLayout(c, { design }),
      bestPageLayout(c, { preferCaption: true, design }),
      bestPageLayout(c, { design, role: "spread" }),
    ]),
  );
  out.cover = hash([null, ...O].map((o) => bestCoverLayout(design, o)));
  out.full = fullPageLayout(design);
  return out;
}

describe("M10b designs golden (modern ×2 + classic landscape: autolayout / relayout / strip / fill / fit)", () => {
  it("is byte-identical to the frozen hashes", () => {
    const now: Record<string, Record<string, string>> = {};
    for (const d of DESIGNS) now[`${d.format}/${d.designStyle}`] = cases(d);
    if (process.env.GOLDEN_UPDATE === "1" || !existsSync(FILE)) {
      writeFileSync(FILE, `${JSON.stringify(now, null, 2)}\n`);
    }
    const frozen = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Record<string, string>>;
    expect(now).toEqual(frozen);
  });
});
