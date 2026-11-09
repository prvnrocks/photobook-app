// Replay synthesiser for the Critic (D-024): a deterministic Critique built only from
// request.scenarioMeta (CriticScenarioMeta). Registered in ./replay-synths.ts.
//
// - scenario "plant_bad_caption" (the Caption Writer replay plants a sentinel mismatch caption at
//   PLANTED_MISMATCH_KEY): score 5 + one caption_mismatch issue (fix rewrite_caption) on the page
//   holding that key; if that page is missing or holds a user caption, the first AI-captioned page
// - otherwise ("ok"): score 8, no issues
// - "invalid": an object of the wrong shape (fails the lean AI schema → parse_failed)

import type { ReplaySynth } from "../transport-replay";
import type { CriticScenarioMeta } from "./critic";

// A page captionKey "m{n}:{k}" (see src/lib/ai/repair.ts), owned by the Caption Writer replay.
import { PLANTED_MISMATCH_KEY } from "./caption-writer-replay";
export { PLANTED_MISMATCH_KEY };

export const PLANT_SCENARIO = "plant_bad_caption";

export const criticReplaySynth: ReplaySynth = (meta, ctx) => {
  const scenario = ctx.scenario as string;
  if (scenario === "invalid") return { verdict: "fine", problems: "none" };

  const pages = (Array.isArray(meta.pages) ? meta.pages : []) as CriticScenarioMeta["pages"];
  if (scenario !== PLANT_SCENARIO) return { score: 8, issues: [] };

  const ai = (p: CriticScenarioMeta["pages"][number]) => p.source !== null && p.source !== "user";
  const target = pages.find((p) => p.key === PLANTED_MISMATCH_KEY && ai(p)) ?? pages.find(ai);
  return {
    score: 5,
    issues: target
      ? [
          {
            type: "caption_mismatch",
            pageIndex: target.pageIndex,
            detail: "Replay: the caption does not describe the photos on this page.",
            fix: "rewrite_caption",
          },
        ]
      : [],
  };
};
