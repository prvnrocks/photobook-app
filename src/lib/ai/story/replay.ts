// Replay synthesisers of the story pipeline (AI_MODE=replay — local dev, previews, tests).
// Deterministic, built only from request.scenarioMeta, and GROUNDED by construction: the text is
// made of plain scene words (no name, place, date, number, relationship, occasion, feeling,
// quotation or stock phrase) and cites the photos of its page, so it passes grounding.ts exactly
// like real output has to.
//
// No two generated texts share an opening or a 4-word sequence: every clause uses one
// (adjective, noun) pair, and the pairs are handed out from one book-wide counter (block number ×
// CLAUSES_PER_BLOCK + clause), so each pair — and each pair of neighbours — occurs once.
// Capacity: LIST² / CLAUSES_PER_BLOCK blocks (≈ 110), more than a 100-page book has.

import type { ReplaySynth } from "@/lib/ai/transport-replay";
import type { NarrativeKind } from "@/lib/storybook/types";
import { countWords } from "./grounding";

const EN = {
  adjectives: "quiet amber pale soft golden gentle bright dusty silver warm open narrow wide distant still blue green low tall clear faded woven painted wooden shaded sunlit curved plain small round smooth cool rosy hazy mellow glassy leafy".split(" "),
  nouns: "lantern doorway window pathway garden table curtain shadow horizon courtyard staircase balcony fountain archway hillside shoreline rooftop meadow corner bench lamp ribbon basket blanket terrace harbour orchard bridge tower market kitchen hallway canopy pebble candle mirror river".split(" "),
  verbs: ["glows", "waits", "rests", "gleams", "lingers"],
};
const AR = {
  adjectives: "الهادئ الذهبي الناعم الواسع الضيق الساكن الأزرق الأخضر العالي الصافي الباهت الخشبي المضيء المنحني البسيط الصغير المستدير الأملس البارد الوردي الضبابي اللامع المورق الفضي الدافئ المفتوح الطويل القديم الرملي الحجري الأبيض الرمادي الفاتح الداكن الملون المظلل النحاسي".split(" "),
  nouns: "الفانوس الممر الظل الأفق الفناء الدرج الجسر البرج السوق المطبخ الرواق المصباح الشريط الغطاء الميناء البستان الركن المقعد الستار النهر الحجر السقف الجدار الطريق الشاطئ التل المرج الوادي القوس الحقل الرصيف الزقاق المدخل الكرسي الرف الإطار الحوض".split(" "),
  verbs: ["يلمع", "ينتظر", "يستريح", "يتوهج", "يمتد"],
};
const LIST = 37;
export const REPLAY_CLAUSES_PER_BLOCK = 12;

const CLAUSES: Record<"en" | "ar", Record<NarrativeKind, number>> = {
  en: { intro: 10, paragraph: 9, caption: 3, pull_quote: 3, closing: 10 }, // 4 words per clause
  ar: { intro: 10, paragraph: 9, caption: 3, pull_quote: 3, closing: 10 }, // 3 words per clause
};

function clause(lang: "en" | "ar", g: number, first: boolean): string {
  const lists = lang === "ar" ? AR : EN;
  const a = g % LIST;
  const n = (Math.floor(g / LIST) + a) % LIST;
  const verb = lists.verbs[g % lists.verbs.length]!;
  if (lang === "ar") return `${lists.nouns[n]} ${lists.adjectives[a]} ${verb}`;
  return `${first ? "The" : "the"} ${lists.adjectives[a]} ${lists.nouns[n]} ${verb}`;
}

/**
 * Deterministic text for block number `index` (1-based: b7 → 7). `clauses` clauses, starting at
 * clause `offset` of the block's own range of REPLAY_CLAUSES_PER_BLOCK (a rewrite uses another
 * offset → different wording). The window never wraps, so neighbours stay unique.
 */
export function replayText(lang: "en" | "ar", index: number, clauses: number, offset = 0): string {
  const count = Math.max(1, Math.min(REPLAY_CLAUSES_PER_BLOCK, clauses));
  const start = Math.max(0, Math.min(offset, REPLAY_CLAUSES_PER_BLOCK - count));
  const base = (Math.max(1, index) - 1) * REPLAY_CLAUSES_PER_BLOCK + start;
  const parts: string[] = [];
  for (let j = 0; j < count; j++) {
    const g = (base + j) % (LIST * LIST);
    const first = j % 2 === 0;
    parts.push(clause(lang, g, first) + (first && j + 1 < count ? (lang === "ar" ? "،" : ",") : "."));
  }
  return parts.join(" ");
}

const blockNumber = (id: unknown) => (typeof id === "string" && /^b\d+$/.test(id) ? Number(id.slice(1)) : 1);
const langOf = (meta: Record<string, unknown>) => (meta.lang === "ar" ? "ar" : "en");
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Planner: the rule outline the service put into scenarioMeta (already grounded). */
export const storyPlanReplaySynth: ReplaySynth = (meta, ctx) => {
  if (ctx.scenario === "invalid") return { chapters: "not a list" };
  const chapters = Array.isArray(meta.chapters) ? (meta.chapters as Record<string, unknown>[]) : [];
  return {
    title: null,
    subtitle: null,
    chapters: chapters.map((c) => ({
      title: String(c.title ?? ""),
      arc: String(c.arc ?? ""),
      momentIds: strings(c.momentIds),
      heroPhoto: String(c.heroPhoto ?? ""),
      paragraphMoments: strings(c.paragraphMoments),
    })),
  };
};

/** Writer: one grounded text per requested block, citing the first photo listed for it. */
export const storyWriteReplaySynth: ReplaySynth = (meta, ctx) => {
  if (ctx.scenario === "invalid") return { blocks: "not a list" };
  const lang = langOf(meta);
  const fallbackPhoto = strings(meta.photos)[0];
  const blocks = Array.isArray(meta.blocks) ? (meta.blocks as Record<string, unknown>[]) : [];
  return {
    blocks: blocks.map((b) => {
      const kind = (typeof b.kind === "string" && b.kind in CLAUSES.en ? b.kind : "caption") as NarrativeKind;
      const photo = strings(b.photos)[0] ?? fallbackPhoto;
      return { blockId: String(b.id ?? ""), text: replayText(lang, blockNumber(b.id), CLAUSES[lang][kind]), photoRefs: photo ? [photo] : [], factRefs: [] };
    }),
  };
};

/**
 * Rewriter: another wording for the same block (a window of its clause range shifted by `rev`),
 * really shorter for "shorter" and longer for "longer" when the bounds leave room.
 */
export const storyRewriteReplaySynth: ReplaySynth = (meta, ctx) => {
  if (ctx.scenario === "invalid") return { text: 7 };
  const lang = langOf(meta);
  const kind = (typeof meta.kind === "string" && meta.kind in CLAUSES.en ? meta.kind : "caption") as NarrativeKind;
  const per = lang === "ar" ? 3 : 4;
  const min = typeof meta.min === "number" ? meta.min : 1;
  const max = typeof meta.max === "number" ? meta.max : 70;
  const now = Math.max(1, Math.round((typeof meta.words === "number" ? meta.words : countWords(String(meta.text ?? ""))) / per));
  let clauses = CLAUSES[lang][kind];
  if (meta.instruction === "shorter") clauses = now - 1;
  if (meta.instruction === "longer") clauses = now + 1;
  clauses = Math.max(Math.ceil(min / per), Math.min(Math.floor(max / per), REPLAY_CLAUSES_PER_BLOCK, clauses));
  const rev = typeof meta.rev === "number" ? meta.rev : 1;
  const photo = strings(meta.photos)[0];
  return { text: replayText(lang, blockNumber(meta.blockId), clauses, 1 + (rev % 2)), photoRefs: photo ? [photo] : [], factRefs: [] };
};
