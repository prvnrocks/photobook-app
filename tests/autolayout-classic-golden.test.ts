// Classic A5 portrait output of the rule-based autolayout, Update album relayout, fillPages and
// bestPageLayout is frozen (M10b A10): adding formats / design styles must not change one byte of
// what existing books get. Hashes of JSON outputs over seeded photo sets, captured at dd48c42
// (before A10). Regenerate only for an intended classic change: GOLDEN_UPDATE=1 npx vitest run
// tests/autolayout-classic-golden.test.ts

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autolayout, fillPages, type AutoPhoto } from "@/lib/autolayout";
import { relayoutDoc, type RelayoutPhoto } from "@/lib/book/relayout";
import { bestPageLayout, type FitOrientation } from "@/lib/layouts/fit";
import { momentSet, rng, SET_SIZES } from "./fixtures/autolayout-sets";

const FILE = join(__dirname, "fixtures", "autolayout-classic-portrait.golden.json");
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

/** Review changes: drop ~15 % of kept photos, keep back ~half the dropped, add a few new photos. */
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

function cases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of SET_SIZES) {
    for (const seed of [1, 2, 3]) {
      const photos = momentSet(n, seed * 100 + n);
      for (const isPaid of [false, true]) {
        const doc = autolayout(photos, { occasion: "travel", title: null, captionLang: "en", isPaid });
        out[`auto:${n}:${seed}:${isPaid}`] = hash(doc);
        try {
          const r = relayoutDoc(doc, reviewed(photos, seed * 100 + n), { isPaid, maxPages: isPaid ? 100 : 20, captionLang: "en" });
          out[`relayout:${n}:${seed}:${isPaid}`] = hash(r);
        } catch (e) {
          out[`relayout:${n}:${seed}:${isPaid}`] = `error:${(e as Error).message}`;
        }
      }
      out[`fill:${n}:${seed}`] = hash([fillPages(photos), fillPages(photos, { opener: true, prevLayout: "two-vertical" })]);
    }
  }
  const O: FitOrientation[] = ["portrait", "landscape", "square"];
  const combos: FitOrientation[][] = [[]];
  for (let k = 1; k <= 5; k++) for (const c of combos.filter((x) => x.length === k - 1)) for (const o of O) combos.push([...c, o]);
  out.fit = hash(combos.map((c) => [bestPageLayout(c), bestPageLayout(c, { preferCaption: true })]));
  return out;
}

describe("classic A5 portrait golden (autolayout / relayout / fillPages / bestPageLayout)", () => {
  it("is byte-identical to the frozen hashes", () => {
    const now = cases();
    if (process.env.GOLDEN_UPDATE === "1" || !existsSync(FILE)) {
      writeFileSync(FILE, `${JSON.stringify(now, null, 2)}\n`);
    }
    const frozen = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>;
    expect(now).toEqual(frozen);
  });
});
