// Published snapshot keeps the occasion only when the book shows the occasion accent sticker
// (bug: scrapbook viewer showed the "other" accent while editor/PDF showed the occasion's one).

import { describe, expect, it } from "vitest";
import { devSampleDoc } from "@/lib/book/dev-sample";
import { coverRenderModel, pageRenderModel } from "@/lib/book/render";
import type { BookDoc } from "@/lib/book/types";
import { OCCASION_ACCENT } from "@/lib/design/stickers";
import { getLayout } from "@/lib/layouts";
import { parsePublicDoc, publicDocToRenderDoc, toPublicDoc } from "@/lib/publish/public-doc";
import { representativeDoc } from "./golden/m9-inputs";

const usesAccent = (d: BookDoc) =>
  [d.cover.layout, ...d.pages.map((p) => p.layout)].some((id) => {
    const l = getLayout(id);
    return !!l?.decorations?.some((x) => x.id === OCCASION_ACCENT) || !!l?.texts?.some((t) => t.plate?.id === OCCASION_ACCENT);
  });

function scrapbook(occasion: BookDoc["occasion"]): BookDoc {
  const d = devSampleDoc("scrapbook-portrait");
  return { ...d, occasion };
}

const art = (d: BookDoc) =>
  JSON.stringify([coverRenderModel(d, {}, "en"), ...d.pages.map((_, i) => pageRenderModel(d, i, {}, "en"))].map((m) => m?.decorations ?? null));

describe("published snapshot occasion", () => {
  it("the scrapbook sample uses the occasion accent (precondition)", () => {
    expect(usesAccent(scrapbook("family"))).toBe(true);
  });

  it("keeps the occasion for an accent book; the viewer draws the same stickers as the editor", () => {
    for (const occ of ["wedding", "travel", "baby", "graduation", "family"] as const) {
      const doc = scrapbook(occ);
      const pub = toPublicDoc(doc);
      expect(pub.version).toBe(2);
      expect(pub.version === 2 && pub.occasion).toBe(occ);
      const parsed = parsePublicDoc(JSON.parse(JSON.stringify(pub)));
      expect(parsed.ok).toBe(true);
      const view = publicDocToRenderDoc(parsed.ok ? parsed.doc : pub);
      expect(view.occasion).toBe(occ);
      expect(art(view)).toBe(art(doc));
    }
    // and the occasion really changes the art, so the check above is meaningful
    expect(art(scrapbook("wedding"))).not.toBe(art(scrapbook("other")));
  });

  it("omits it for occasion 'other' and for books without the accent (snapshots byte-identical)", () => {
    expect("occasion" in toPublicDoc(scrapbook("other"))).toBe(false);
    const classic = { ...representativeDoc(), occasion: "wedding" as const };
    expect(usesAccent(classic)).toBe(false);
    expect("occasion" in toPublicDoc(classic)).toBe(false);
  });

  it("older snapshots without the key still parse and fall back to 'other'", () => {
    const pub = toPublicDoc(scrapbook("family"));
    const old = JSON.parse(JSON.stringify(pub));
    delete old.occasion;
    const parsed = parsePublicDoc(old);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && publicDocToRenderDoc(parsed.doc).occasion).toBe("other");
  });

  it("v1 snapshots never carry it", () => {
    const pub = toPublicDoc({ ...representativeDoc(), occasion: "family" });
    expect(pub.version).toBe(1);
    expect(parsePublicDoc({ ...JSON.parse(JSON.stringify(pub)), occasion: "family" }).ok).toBe(false);
  });
});
