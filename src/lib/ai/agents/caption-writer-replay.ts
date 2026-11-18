// Replay synthesiser for the Caption Writer (D-024): deterministic captions built only from
// request.scenarioMeta (CaptionWriterScenarioMeta) — never from photo content. Registered in
// ./replay-synths.ts.
//
// - English: short original lines from a pool (distinct opening words), picked by the page's
//   book-wide ordinal, plus a mood tail and (en only) the photo's place from the metadata.
// - Arabic: native Arabic lines from a pool (Arabic script only, no Latin), same selection.
// - captionLength 'short' (memory) → body only (≤ 10 words).
// - Every line passes the pre-check (caption-check.ts) for books up to 2 × pool size captionable
//   pages; beyond that openings may repeat (repair → null), which only matters for local dev.
//
// Scenario "plant_bad_caption", first attempt of batch 0 (meta.repair null):
//   (b) the page with key PLANTED_MISMATCH_KEY ("m1:1") gets PLANTED_MISMATCH_TEXT, which passes
//       the pre-check; the Critic replay flags that page caption_mismatch. If "m1:1" is not in
//       the batch, the LAST page of the batch gets it (when the batch has ≥ 2 pages).
//   (a) the first OTHER page of the batch gets PLANTED_PRECHECK_TEXT (22 words incl. "Paris" and
//       "Ahmed") → pre-check issues too_long + unknown_name (en) / too_long + latin_word (ar).
//   With meta.repair set → clean captions for the requested keys only.
//
// Contract for the Critic replay (T5): PLANTED_MISMATCH_KEY is a page captionKey. The sentinel
// can also be found by text: isPlantedMismatch(text) / plantedMismatchPageIndexes(doc).
//
// Chapter descriptions (M30 T10, meta.descriptions = the variant call): every moment gets a
// `description` field — a deterministic 2-sentence paragraph (replayDescription: 26–38 words,
// English or native Arabic, no names / digits, unique per moment for up to 70 moments) when
// meta.moments[].wantDescription, else null. Base calls never carry the field.
// Scenario "plant_bad_caption", first attempt of batch 0: the FIRST wanted description is
// PLANTED_DESCRIPTION_TEXT (over 45 words, with an invented "Paris") → pre-check too_long +
// unknown_name (en) / latin_word (ar); the repair call returns a clean one.
//
// Scenario "invalid" → `{ moments: [] }` (passes the AI schema, fails the strict schema).

import type { CaptionLang } from "@/lib/book/options";
import type { BookDoc } from "@/lib/book/types";
import type { MomentCaptionsAi } from "../schemas";
import { MAX_QUOTE_WORDS } from "../schemas";
import type { ReplaySynth } from "../transport-replay";
import type { CaptionWriterScenarioMeta } from "./caption-writer";

/** captionKey of the page that gets the sentinel mismatch caption (when present in batch 0). */
export const PLANTED_MISMATCH_KEY = "m1:1";

/** Passes the pre-check but does not match any photo (a wedding/travel book never shows this). */
export const PLANTED_MISMATCH_TEXT: Readonly<Record<CaptionLang, string>> = {
  en: "A snowy mountain cabin under heavy winter clouds",
  ar: "كوخ ثلجي فوق جبل بعيد تحت غيوم الشتاء",
};

/** 22 words incl. invented "Paris" and "Ahmed" → always fails the pre-check. */
export const PLANTED_PRECHECK_TEXT: Readonly<Record<CaptionLang, string>> = {
  en: "We walked with Ahmed through the old streets of Paris and laughed until the sun went down over the quiet river tonight",
  ar: "مشينا مع Ahmed في شوارع Paris القديمة وضحكنا كثيرا حتى غابت الشمس فوق النهر الهادئ في تلك الليلة الجميلة التي لن ننساها",
};

/** Over 45 words incl. an invented "Paris" → a description that always fails the pre-check. */
export const PLANTED_DESCRIPTION_TEXT: Readonly<Record<CaptionLang, string>> = {
  en: "We spent the whole afternoon wandering slowly through the narrow streets, stopping at every corner to look around, and somebody said it felt exactly like a spring morning in Paris. Nobody wanted to leave, so we stayed until the lamps came on and the last tables were cleared away.",
  ar: "قضينا فترة العصر كلها نتجول على مهل في الأزقة الضيقة، ونتوقف عند كل زاوية لنتأمل ما حولنا، وقال أحدنا إن المكان يشبه صباحًا ربيعيًا في Paris تمامًا. لم يرغب أحد في المغادرة، فبقينا حتى أضيئت المصابيح وخلت آخر الطاولات من أصحابها ومضى الليل بهدوء من دون أي استعجال.",
};

export function isPlantedMismatch(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  return t === PLANTED_MISMATCH_TEXT.en || t === PLANTED_MISMATCH_TEXT.ar;
}

/** Doc page indexes whose caption is the planted mismatch sentinel. */
export function plantedMismatchPageIndexes(doc: Pick<BookDoc, "pages">): number[] {
  const out: number[] = [];
  doc.pages.forEach((p, i) => {
    if (isPlantedMismatch(p.caption?.text)) out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------------------- pools

/** Distinct first words; no capitalised words after the first; ≤ 7 words each. */
const EN_POOL = [
  "Laughter that fills the whole room",
  "Every glance here tells a story",
  "Soft light and softer smiles",
  "Nothing planned, everything remembered",
  "Small moments, big feelings",
  "Hearts full, hands held tight",
  "Golden light on a perfect day",
  "Side by side, just like always",
  "Quiet joy in every corner",
  "Where the day slowed down for us",
  "Simple things we will keep forever",
  "This is how happiness looks",
  "A table full of good company",
  "Colours we want to remember",
  "Stories shared over warm plates",
  "Little details that made the day",
  "One more look before we go",
  "Wide skies and open hearts",
  "Together is our favourite place",
  "Moments like this pass too fast",
  "Bright eyes and easy smiles",
  "Everything felt right just then",
] as const;

/** Native Arabic lines, Arabic script only, distinct first words. */
const AR_POOL = [
  "ضحكة صغيرة تملأ المكان",
  "لحظة هادئة بين الأصدقاء",
  "نور دافئ ووجوه مبتسمة",
  "تفاصيل بسيطة لا تُنسى",
  "قلوب قريبة وأيادٍ متشابكة",
  "يوم جميل بكل ما فيه",
  "معًا في أجمل الأوقات",
  "ذكرى نحملها معنا دائمًا",
  "سماء واسعة وقلب مطمئن",
  "هنا توقّف الوقت قليلًا",
  "فرحة تكفي لعمر كامل",
  "مائدة عامرة بالحب والحكايات",
  "ألوان نريد أن نتذكرها",
  "نظرة واحدة تقول الكثير",
  "بداية حكاية لا تنتهي",
  "أجمل ما في اليوم أنتم",
  "صباح هادئ ورفقة طيبة",
  "كل لحظة هنا لها معنى",
  "ابتسامات صادقة بلا تكلّف",
  "على مهل نعيش اللحظة",
] as const;

type Mood = "joyful" | "romantic" | "calm" | "adventurous" | "nostalgic" | "formal" | "neutral";
const TAILS: Record<CaptionLang, [Record<Mood, string>, Record<Mood, string>]> = {
  en: [
    {
      joyful: "full of joy",
      romantic: "with love in the air",
      calm: "calm and unhurried",
      adventurous: "ready for what comes next",
      nostalgic: "worth remembering",
      formal: "dressed for the occasion",
      neutral: "just as it was",
    },
    {
      joyful: "and nobody stopped smiling",
      romantic: "and hearts beating together",
      calm: "as time drifted by",
      adventurous: "with the road still calling",
      nostalgic: "and we will never forget",
      formal: "in all its elegance",
      neutral: "simple and true",
    },
  ],
  ar: [
    {
      joyful: "بكل فرح",
      romantic: "بكل حب",
      calm: "في هدوء تام",
      adventurous: "نحو مغامرة جديدة",
      nostalgic: "تبقى في الذاكرة",
      formal: "في أبهى حلة",
      neutral: "كما كانت تمامًا",
    },
    {
      joyful: "والضحكة لا تغيب",
      romantic: "والقلب حاضر",
      calm: "والوقت يمضي بهدوء",
      adventurous: "والطريق ينادينا",
      nostalgic: "ولن ننساها",
      formal: "بكل أناقة",
      neutral: "ببساطة وصدق",
    },
  ],
};
const SHORT_SUFFIX: Record<CaptionLang, string> = { en: "again", ar: "من جديد" };

/** Sentence case, no names. */
const HEADINGS: Record<CaptionLang, readonly string[]> = {
  en: [
    "Where it all began",
    "Golden hours",
    "Little moments",
    "Side by side",
    "Together again",
    "The best part",
    "Slow afternoons",
    "Bright memories",
    "Close to home",
    "Last light",
  ],
  ar: [
    "حيث بدأ كل شيء",
    "ساعات ذهبية",
    "لحظات صغيرة",
    "جنبًا إلى جنب",
    "معًا من جديد",
    "أجمل ما في الحكاية",
    "عصر هادئ",
    "ذكريات مشرقة",
    "قريبًا من القلب",
    "آخر الضوء",
  ],
};

// --- chapter descriptions (M30) -------------------------------------------------------------
// First sentence × second sentence: 10 × 7 (coprime) → index i picks (i % 10, i % 7), unique for
// i < 70. Repairs use REPAIR second sentences, so a repaired text never equals an original one.
// Sentence case, no capitalised word mid-sentence, no digits, no quotes; 26–38 words in total.

const DESC_FIRST: Record<CaptionLang, readonly string[]> = {
  en: [
    "This part of the day moved slowly, with everyone close together and nobody in a hurry to be anywhere else.",
    "There was a calm in these hours that is hard to plan for, the kind that settles when good company is near.",
    "Faces kept turning toward the light here, and each small pause between the photos held a quiet kind of happiness.",
    "It began with a few easy smiles and grew into one of those stretches that people talk about for a long time.",
    "Nothing here was staged, only people being themselves while the afternoon carried on gently around them.",
    "Some hours ask for nothing more than attention, and these were full of small details worth looking at twice.",
    "What stands out in these pictures is how relaxed everybody looks, as if the clock had been set aside for a while.",
    "Between the wide views and the close ones, a simple story unfolds of time spent well and shared without effort.",
    "Laughter came easily in this chapter, and the camera only had to stay nearby to catch it as it happened.",
    "A soft mood runs through all of these frames, from the first glance to the last one before moving on.",
  ],
  ar: [
    "مضى هذا الجزء من اليوم على مهل، والجميع قريبون من بعضهم ولا أحد يستعجل الذهاب إلى مكان آخر.",
    "كان في هذه الساعات هدوء يصعب التخطيط له، من النوع الذي يحلّ حين تكون الصحبة الطيبة قريبة.",
    "ظلت الوجوه تتجه نحو الضوء هنا، وفي كل وقفة قصيرة بين الصور سعادة هادئة لا تحتاج إلى كلام.",
    "بدأ الأمر بابتسامات بسيطة ثم صار واحدًا من تلك الأوقات الجميلة التي يتحدث عنها الناس طويلًا بعد انتهائها.",
    "لا شيء هنا مرتّب مسبقًا، فقط أناس على طبيعتهم يضحكون ويتحدثون والعصر يمضي بلطف وهدوء من حولهم.",
    "بعض الساعات لا تطلب منا أكثر من الانتباه، وهذه الساعات كانت مليئة بتفاصيل صغيرة تستحق نظرة ثانية متأنية.",
    "ما يلفت النظر في هذه الصور هو ارتياح الجميع وهدوؤهم، كأن الساعة وُضعت جانبًا لبعض الوقت دون أن ينتبه أحد.",
    "بين اللقطات الواسعة واللقطات القريبة تتكشف أمامنا حكاية بسيطة عن وقت جميل قضيناه معًا بلا تكلّف ولا استعجال.",
    "جاءت الضحكات بسهولة في هذا الفصل من اليوم، وكان يكفي أن تبقى الكاميرا قريبة لتلتقطها كما هي تمامًا.",
    "يسري مزاج ناعم وهادئ في كل هذه اللقطات، من النظرة الأولى حتى النظرة الأخيرة قبل أن نمضي في طريقنا.",
  ],
};
const DESC_SECOND: Record<CaptionLang, readonly string[]> = {
  en: [
    "Looking back, it is the ordinary moments like these that end up meaning the most.",
    "These are the pictures we will return to whenever we want to feel that warmth again.",
    "By the end, everyone carried a little of that ease home with them.",
    "It is a chapter to keep, exactly as it was.",
    "Every frame adds a line to a memory that will only grow fonder with time.",
    "We would gladly live this part of the story all over again.",
    "Small as they seem, these scenes hold the heart of the whole album.",
  ],
  ar: [
    "وحين نعود بالذاكرة نجد أن اللحظات العادية مثل هذه هي الأغلى على القلب.",
    "هذه هي الصور التي سنعود إليها كلما اشتقنا إلى ذلك الدفء.",
    "وفي النهاية حمل كل واحد منا شيئًا من تلك الطمأنينة إلى بيته.",
    "إنه فصل من الحكاية يستحق أن يبقى في الذاكرة كما هو تمامًا.",
    "كل لقطة تضيف سطرًا إلى ذكرى تزداد جمالًا مع الأيام.",
    "ولو عاد بنا الوقت لعشنا هذا الجزء من الحكاية مرة أخرى بكل سرور.",
    "وعلى بساطتها تحمل هذه المشاهد الصغيرة في داخلها روح الألبوم كله.",
  ],
};
const DESC_SECOND_REPAIR: Record<CaptionLang, readonly string[]> = {
  en: [
    "It deserves a page of its own, and a slow second look.",
    "Moments this unhurried are rare, which is why they are here.",
    "That feeling stayed with us long after the last photo was taken.",
  ],
  ar: [
    "إنه يستحق صفحة خاصة به في هذا الألبوم ونظرة ثانية متأنية.",
    "لحظات بهذا القدر من الهدوء نادرة جدًا، ولهذا السبب هي هنا.",
    "وبقي ذلك الشعور الجميل معنا وقتًا طويلًا بعد التقاط آخر صورة.",
  ],
};

/** Deterministic clean chapter description for a moment ("m3"). `repair` → a different second sentence. */
export function replayDescription(momentId: string, lang: CaptionLang, repair = false): string {
  const i = Math.max(1, Number(/^m(\d+)$/.exec(momentId)?.[1] ?? "1")) - 1;
  const first = DESC_FIRST[lang][i % DESC_FIRST[lang].length];
  const seconds = repair ? DESC_SECOND_REPAIR[lang] : DESC_SECOND[lang];
  return `${first} ${seconds[i % seconds.length]}`;
}

const MOODS: readonly Mood[] = ["joyful", "romantic", "calm", "adventurous", "nostalgic", "formal", "neutral"];
const asMood = (m: unknown): Mood => (MOODS.includes(m as Mood) ? (m as Mood) : "neutral");

function clipWords(s: string, max: number): string {
  const w = s.split(/\s+/).filter(Boolean);
  return w.length <= max ? w.join(" ") : w.slice(0, max).join(" ");
}

type MetaPage = CaptionWriterScenarioMeta["moments"][number]["pages"][number];

/** Deterministic clean caption for one page. `shift` varies repair answers. */
export function replayCaption(page: MetaPage, lang: CaptionLang, short: boolean, shift = 0): string {
  const pool: readonly string[] = lang === "ar" ? AR_POOL : EN_POOL;
  const ord = Math.max(0, Math.floor(page.ordinal)) + shift;
  const body = pool[ord % pool.length];
  const round = Math.floor(ord / pool.length) + (shift ? 1 : 0);
  if (short) return clipWords(round > 0 ? `${body} ${SHORT_SUFFIX[lang]}` : body, 10);
  const tail = TAILS[lang][Math.min(round, 1)][asMood(page.mood)];
  const sep = lang === "ar" ? "، " : ", ";
  let line = `${body}${sep}${tail}`;
  if (lang === "en" && page.place && !/[0-9]/.test(page.place) && !/["@#]/.test(page.place)) line += ` in ${page.place.trim()}`;
  return clipWords(line, MAX_QUOTE_WORDS);
}

export function replayHeading(momentId: string, lang: CaptionLang): string {
  const n = Number(/^m(\d+)$/.exec(momentId)?.[1] ?? "1");
  const list = HEADINGS[lang];
  return list[(Math.max(1, n) - 1) % list.length];
}

function readMeta(raw: Record<string, unknown>): CaptionWriterScenarioMeta {
  const m = raw as Partial<CaptionWriterScenarioMeta>;
  return {
    lang: m.lang === "ar" ? "ar" : "en",
    tone: m.tone ?? "minimal",
    occasion: m.occasion ?? "other",
    captionLength: m.captionLength ?? null,
    batchIndex: typeof m.batchIndex === "number" ? m.batchIndex : 0,
    attempt: typeof m.attempt === "number" ? m.attempt : 1,
    moments: Array.isArray(m.moments) ? m.moments : [],
    repair: Array.isArray(m.repair) ? m.repair.filter((k): k is string => typeof k === "string") : null,
    descriptions: m.descriptions === true,
  };
}

export const captionWriterReplaySynth: ReplaySynth = (raw, ctx) => {
  if (ctx.scenario === "invalid") return { moments: [] };
  const meta = readMeta(raw);
  const short = meta.captionLength === "short";
  const repair = meta.repair ? new Set(meta.repair) : null;
  const plant = ctx.scenario === "plant_bad_caption" && !repair && meta.batchIndex === 0 && meta.attempt === 1;

  const allKeys = meta.moments.flatMap((m) => m.pages.map((p) => p.key));
  const mismatchKey = !plant || allKeys.length < 2
    ? undefined
    : allKeys.includes(PLANTED_MISMATCH_KEY)
      ? PLANTED_MISMATCH_KEY
      : allKeys[allKeys.length - 1];
  const precheckKey = plant ? allKeys.find((k) => k !== mismatchKey) : undefined;

  // M30 variant: one description per wanted moment (the first one planted in the plant scenario).
  const plantedDescription = plant ? meta.moments.find((m) => m.wantDescription)?.momentId : undefined;
  const description = (m: CaptionWriterScenarioMeta["moments"][number]): { description?: string | null } => {
    if (!meta.descriptions) return {};
    if (!m.wantDescription) return { description: null };
    if (m.momentId === plantedDescription) return { description: PLANTED_DESCRIPTION_TEXT[meta.lang] };
    return { description: replayDescription(m.momentId, meta.lang, repair !== null) };
  };

  const moments: Array<MomentCaptionsAi & { description?: string | null }> = meta.moments.map((m) => ({
    momentId: m.momentId,
    heading: replayHeading(m.momentId, meta.lang),
    ...description(m),
    pageCaptions: m.pages
      .filter((p) => !repair || repair.has(p.key))
      .map((p) => ({
        pageIndex: p.pageIndex,
        text:
          p.key === precheckKey
            ? PLANTED_PRECHECK_TEXT[meta.lang]
            : p.key === mismatchKey
              ? PLANTED_MISMATCH_TEXT[meta.lang]
              : replayCaption(p, meta.lang, short, repair ? 11 : 0),
      })),
  }));
  return { moments };
};
