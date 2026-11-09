// Replay synthesiser for the Rewriter (D-024): a deterministic caption built only from
// request.scenarioMeta (RewriterScenarioMeta) — never from the caption text or photo content.
// Registered in ./replay-synths.ts. Works offline.
//
// - Script follows meta.targetLang (English pool / native Arabic pool, Arabic script only), so
//   "translate" yields the target script.
// - "shorter": the pick has fewer words AND fewer code points than the input (meta.inputWords /
//   inputChars); when nothing in the pool is shorter (a 1-word input) the shortest line is
//   returned and the agent's pre-check reports not_shorter.
// - "tone:<Tone>": a line from that tone's pool; "rewrite"/"translate": the book tone's pool.
// - The pick depends on (instruction, lang, tone, inputHash, attempt), so a retry (attempt 2)
//   returns a different line. Every line passes the pre-check (no names, no digits, sentence case).
// - scenario "invalid" → an object of the wrong shape (fails the AI schema → parse_failed).

import type { CaptionLang, Tone } from "@/lib/book/options";
import { wordCount } from "../schemas";
import type { ReplaySynth } from "../transport-replay";
import type { RewriterScenarioMeta } from "./rewriter";

/** Pools per language and tone: distinct lines, ≤ 9 words, no capitals after the first word. */
export const REWRITE_POOLS: Readonly<Record<CaptionLang, Readonly<Record<Tone, readonly string[]>>>> = {
  en: {
    romantic: ["Two hearts, one quiet evening", "Close enough to hear each other smile", "Every look said stay a little longer", "Held close in the softest light"],
    fun: ["Pure chaos, best kind of day", "Snacks first, questions later", "We laughed until our cheeks hurt", "Officially the loudest table here"],
    nostalgic: ["A day we keep coming back to", "Old smiles, still warm", "Remember how slow that afternoon felt", "Back when the light lasted forever"],
    minimal: ["Together, simply", "Light and stillness", "A quiet table for two", "Just this moment"],
  },
  ar: {
    romantic: ["قلبان في مساء هادئ", "قريبان حتى نسمع ابتسامتنا", "كل نظرة كانت تقول ابقَ قليلاً", "في أنعم ضوء كنا معاً"],
    fun: ["فوضى جميلة ويوم لا ينسى", "الحلويات أولاً والأسئلة لاحقاً", "ضحكنا حتى تعبت وجوهنا", "أعلى طاولة صوتاً هنا"],
    nostalgic: ["يوم نعود إليه دائماً", "ابتسامات قديمة ما زالت دافئة", "تذكر كم كان ذلك العصر هادئاً", "حين كان الضوء لا ينتهي"],
    minimal: ["معاً ببساطة", "ضوء وسكون", "طاولة هادئة لاثنين", "هذه اللحظة فقط"],
  },
};

/** Extra-short lines for "shorter" (1–3 words). */
export const SHORT_POOL: Readonly<Record<CaptionLang, readonly string[]>> = {
  en: ["Together", "Pure joy", "Simply us", "Golden light", "Side by side", "Still smiling"],
  ar: ["معاً", "فرح خالص", "نحن ببساطة", "ضوء ذهبي", "جنباً إلى جنب", "ما زلنا نبتسم"],
};

const TONES_ORDER: readonly Tone[] = ["romantic", "fun", "nostalgic", "minimal"];
const cp = (s: string) => Array.from(s).length;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export const rewriterReplaySynth: ReplaySynth = (raw, ctx) => {
  if (ctx.scenario === "invalid") return { caption: null, words: [] };
  const meta = raw as Partial<RewriterScenarioMeta>;
  const lang: CaptionLang = meta.targetLang === "ar" ? "ar" : "en";
  const tone: Tone = TONES_ORDER.includes(meta.tone as Tone) ? (meta.tone as Tone) : "minimal";
  const attempt = Math.max(1, Math.trunc(num(meta.attempt, 1)));
  const seed = Math.abs(Math.trunc(num(meta.inputHash, 0))) + (attempt - 1);

  if (meta.instruction === "shorter") {
    const words = num(meta.inputWords, 0);
    const chars = num(meta.inputChars, 0);
    const all = [...REWRITE_POOLS[lang][tone], ...SHORT_POOL[lang]];
    const fits = all.filter((l) => wordCount(l) < words && cp(l) < chars);
    if (fits.length === 0) return { text: [...all].sort((a, b) => cp(a) - cp(b))[0] };
    return { text: fits[seed % fits.length] };
  }
  const pool = REWRITE_POOLS[lang][tone];
  return { text: pool[seed % pool.length] };
};
