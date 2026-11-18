// Grounding checks for narrative text (Task 6). Pure: no I/O, no model calls, no logging.
//
// A block of narrative is accepted only when everything that looks like a FACT in it can be
// traced to a source the block cites:
//   - a memory fact (the user's own words: answers, people, places, facts, note, book title,
//     occasion), cited by id (`factRefs`), or
//   - the metadata of a photo it cites (`photoRefs`): the place name and the date label.
// What the vision model saw in a cited photo (description, objects, activities) counts as
// evidence for VISIBLE things only: ordinary words and counts ("two people"), never names,
// relationships, dates or occasions.
//
// The checks are deliberately conservative: a false rejection costs one repair call, an invented
// fact in a printed book is the failure this module exists to prevent. Each rejection is a typed
// issue with a code and a CATEGORY as detail — never the offending text.
//
// LIMITS OF THE HEURISTIC (known, accepted, documented for the reviewer):
//   1. English names are found by capitalisation. A name written in lower case ("sara") is only
//      caught when it is a person the user listed and the block did not cite that fact.
//   2. A capitalised word at the START of a sentence is accepted when it is a common opening
//      word (SENTENCE_STARTERS) or occurs in the cited photos' descriptions. A name that is
//      also such a word ("Will", "Rose" in a description) passes; an uncommon opening word is
//      rejected (false positive → one repair).
//   3. Arabic has no capitals: invented Arabic names and place names CANNOT be detected. For
//      Arabic the module checks the listed categories (relationships, months, weekdays, seasons,
//      milestones, ages, numbers, digits, speech, feelings, clichés) and uncited listed people.
//      Arabic morphology is handled with a small prefix / suffix table, not a stemmer: unusual
//      inflections are missed, and a few homographs are flagged ("مارس", "خالي").
//   4. Categories are word lists. A relationship, milestone or feeling expressed with a word that
//      is not on a list is not caught ("her better half", "tied the knot").
//   5. "Grounded" means the WORD occurs in a cited source, not that the sentence is true: a block
//      citing a fact that names Sara and a photo taken in Abu Dhabi may still claim that Sara was
//      in Abu Dhabi. The Critic / the user remain the judge of meaning.
//   6. Feelings are matched as "<person> felt / was / seemed <emotion>" and "<person> loved /
//      knew / hoped …" patterns; subtler mind-reading ("a smile that said everything") passes.
//   7. Paraphrased famous quotes or lyrics are not detected; only quotation marks, reported
//      speech verbs and a list of stock phrases are.
//   8. Repetition compares exact normalised word sequences; a paraphrase is not a repetition.

import type { NarrativeKind } from "@/lib/storybook/types";

export const WORD_BOUNDS: Record<NarrativeKind, { min: number; max: number; target: readonly [number, number] }> = {
  intro: { min: 30, max: 70, target: [35, 65] },
  paragraph: { min: 20, max: 60, target: [25, 55] },
  caption: { min: 5, max: 18, target: [6, 16] },
  pull_quote: { min: 5, max: 18, target: [6, 16] },
  closing: { min: 30, max: 70, target: [35, 65] },
};
export const TITLE_MAX_CHARS = 60;
export const ARC_MAX_CHARS = 200;
/** UTF-16 units — NarrativeBlockSchema.text (STORY_LIMITS.narrativeText). */
export const BLOCK_MAX_UNITS = 900;
export const MAX_PHOTO_REFS = 12;
export const MAX_FACT_REFS = 10;

export const GROUNDING_ISSUE_CODES = [
  "empty",
  "no_refs", // cites nothing (or, for anything but a closing, no photo)
  "unknown_ref", // a cited photo / fact does not exist
  "ref_outside_chapter", // a cited photo belongs to another chapter
  "too_many_refs",
  "ungrounded_name", // capitalised word (person / place) or an uncited listed person
  "ungrounded_relationship",
  "ungrounded_date", // month, weekday, year, season, duration, age
  "ungrounded_number",
  "ungrounded_milestone",
  "quoted_speech", // quotation that is not the user's own words, or reported speech
  "stated_feeling",
  "banned_phrase",
  "repetition", // same opening or a 4-word sequence used by another block
  "too_short",
  "too_long",
  "wrong_script",
  "avoided_topic", // something the user asked not to mention
  // rewrite only
  "unchanged",
  "not_shorter",
  "not_longer",
  // run level (writeStory): `blockId` is then a chapter id or "closing"
  "chapter_failed",
  "run_budget",
] as const;
export type GroundingIssueCode = (typeof GROUNDING_ISSUE_CODES)[number];

/** `detail` is a category ("proper_noun", "month", "cliche" …) — never text from the block or the user. */
export type GroundingIssue = { blockId: string; code: GroundingIssueCode; detail?: string };

export type GroundingPhoto = {
  /** Place name from metadata (reverse geocoding or the user) — never from the vision model. */
  place: string | null;
  /** Date label from the capture time, e.g. "12 Oct 2026". */
  dateLabel: string | null;
  /** What the vision model saw: description + objects + activities, as one string. */
  evidence: string;
};
export type GroundingFact = { kind: string; text: string };

export type GroundingContext = {
  lang: "en" | "ar";
  /** Photos the block may cite: its chapter's photos (the whole book for a closing). */
  photos: ReadonlyMap<string, GroundingPhoto>;
  /** Every photo alias of the book — tells "outside the chapter" from "unknown". */
  bookPhotos?: ReadonlySet<string>;
  /** All memory facts of the book by id. */
  facts: ReadonlyMap<string, GroundingFact>;
  /** Text of every OTHER block of the storybook (repetition check). */
  otherTexts: readonly string[];
  /** Things the user asked not to mention. */
  avoid?: readonly string[];
};

export type BlockDraft = { blockId: string; kind: NarrativeKind; text: string; photoRefs: readonly string[]; factRefs: readonly string[] };

// ---------------------------------------------------------------------------- normalisation

const AR_DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const AR_LETTER = /[ء-يٮ-ۓ]/;
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/;

function westernDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Arabic normal form: no diacritics / tatweel, alef and ya variants unified, ta marbuta → ha. */
export function normalizeArabic(s: string): string {
  return westernDigits(s)
    .replace(AR_DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

/** Lower case, accents folded, Arabic normalised, everything but letters / digits removed. */
export function normalizeToken(raw: string): string {
  const folded = normalizeArabic(raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")).toLowerCase();
  return folded.replace(/[^\p{L}\p{N}]/gu, "");
}

type Tok = {
  raw: string;
  norm: string;
  /** First word of the text or of a sentence. */
  initial: boolean;
  /** Starts with an upper-case letter. */
  cap: boolean;
};

const SENTENCE_END = /[.!?…؟。]["'”’»)\]]*$/;

/** Words in reading order. Hyphenated words are split; possessive 's is dropped. */
export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let initial = true;
  for (const chunk of text.normalize("NFC").split(/\s+/)) {
    if (!chunk) continue;
    const parts = chunk.split(/[-‐-―/]+/).filter(Boolean);
    let first = true;
    for (const part of parts) {
      const core = part.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "").replace(/['’]s$/i, "");
      const norm = normalizeToken(core);
      if (!norm) continue;
      out.push({ raw: core, norm, initial: initial && first, cap: /^\p{Lu}/u.test(core) });
      first = false;
    }
    if (!first) initial = SENTENCE_END.test(chunk);
  }
  return out;
}

/** Whitespace-separated words that contain a letter or a digit (English and Arabic alike). */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

// ---------------------------------------------------------------------------- word lists

const MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
/** Month words that are also ordinary English words: a month only when capitalised. */
const AMBIGUOUS_MONTHS = new Set(["may", "march"]);
// Gregorian (Gulf / Egypt) and Levantine month names, normalised. "اب" (August) is left to the
// relationship list (father).
const MONTHS_AR: Record<string, number> = {
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
  شباط: 2, اذار: 3, نيسان: 4, ايار: 5, حزيران: 6, تموز: 7, ايلول: 9,
};
const WEEKDAYS_EN = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mondays", "tuesdays", "wednesdays", "thursdays", "fridays", "saturdays", "sundays", "weekend", "weekends"]);
const WEEKDAYS_AR = new Set(["الاحد", "الاثنين", "الثلاثاء", "الاربعاء", "الخميس", "الجمعه", "السبت"]);
const SEASONS = new Set(["summer", "winter", "autumn", "summertime", "wintertime", "springtime", "الصيف", "الشتاء", "الخريف", "الربيع", "صيف", "شتاء", "خريف", "ربيع"]);
const DURATIONS = new Set(["year", "years", "decade", "decades", "century", "months", "سنه", "سنوات", "سنين", "عام", "اعوام", "عاما", "شهور", "اشهر"]);

const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, hundreds: 100, thousand: 1000, thousands: 1000, dozen: 12, dozens: 12,
  اثنان: 2, اثنين: 2, اثنتان: 2, اثنتين: 2, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5, ست: 6, سته: 6, سبع: 7, سبعه: 7,
  ثمان: 8, ثماني: 8, ثمانيه: 8, تسع: 9, تسعه: 9, عشر: 10, عشره: 10, عشرون: 20, عشرين: 20, ثلاثون: 30, ثلاثين: 30, مئه: 100, مائه: 100,
};
const ORDINALS = new Set(["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "twentieth", "thirtieth", "fortieth", "fiftieth"]);
const FIRST_NOUNS = new Set([
  "birthday", "steps", "step", "day", "time", "trip", "home", "house", "dance", "word", "words", "christmas", "eid", "anniversary", "date",
  "kiss", "tooth", "haircut", "visit", "holiday", "vacation", "flight", "car", "job", "year", "child", "baby", "born", "grandchild", "meeting",
]);

/** Relationship words → group. A block may use a word when a cited fact has a word of the same group. */
const REL_EN: Record<string, string> = {
  mother: "mother", mothers: "mother", mum: "mother", mums: "mother", mom: "mother", moms: "mother", mommy: "mother", mummy: "mother", mama: "mother", mamma: "mother", ma: "mother",
  father: "father", fathers: "father", dad: "father", dads: "father", daddy: "father", papa: "father", baba: "father",
  parent: "parent", parents: "parent",
  husband: "husband", husbands: "husband", wife: "wife", wives: "wife", spouse: "spouse", spouses: "spouse",
  partner: "partner", partners: "partner", fiance: "fiance", fiancee: "fiance", girlfriend: "partner", boyfriend: "partner", lover: "partner", lovers: "partner", sweetheart: "partner", sweethearts: "partner", soulmate: "partner", soulmates: "partner",
  sister: "sister", sisters: "sister", brother: "brother", brothers: "brother", sibling: "sibling", siblings: "sibling", twin: "twin", twins: "twin",
  son: "son", sons: "son", daughter: "daughter", daughters: "daughter", grandson: "grandchild", granddaughter: "grandchild", grandchild: "grandchild", grandchildren: "grandchild", grandkids: "grandchild",
  grandmother: "grandmother", grandmothers: "grandmother", grandma: "grandmother", granny: "grandmother", nana: "grandmother", nanny: "grandmother",
  grandfather: "grandfather", grandfathers: "grandfather", grandpa: "grandfather", grandad: "grandfather", granddad: "grandfather",
  grandparent: "grandparent", grandparents: "grandparent",
  aunt: "aunt", aunts: "aunt", auntie: "aunt", aunty: "aunt", uncle: "uncle", uncles: "uncle", cousin: "cousin", cousins: "cousin", niece: "niece", nieces: "niece", nephew: "nephew", nephews: "nephew",
  friend: "friend", friends: "friend", friendship: "friend", friendships: "friend", bestie: "friend", besties: "friend", buddy: "friend", buddies: "friend", pals: "friend",
  colleague: "colleague", colleagues: "colleague", coworker: "colleague", coworkers: "colleague", workmates: "colleague", boss: "colleague",
  classmate: "classmate", classmates: "classmate", teammate: "teammate", teammates: "teammate", roommate: "roommate", roommates: "roommate", neighbour: "neighbour", neighbours: "neighbour", neighbor: "neighbour", neighbors: "neighbour",
  bride: "bride", brides: "bride", groom: "groom", grooms: "groom", bridesmaid: "bridesmaid", bridesmaids: "bridesmaid", groomsmen: "groomsman", groomsman: "groomsman", newlyweds: "wedding", newlywed: "wedding",
  couple: "couple", couples: "couple", family: "family", families: "family", relative: "relative", relatives: "relative", godmother: "godparent", godfather: "godparent", godparents: "godparent",
  stepmother: "mother", stepfather: "father", stepson: "son", stepdaughter: "daughter", stepbrother: "brother", stepsister: "sister",
};
/** Arabic relationship stems (normalised) → group. `short` stems need a pronoun suffix or the bare word. */
const REL_AR: readonly (readonly [string, string])[] = [
  ["ام", "mother"], ["والده", "parent"], ["والدت", "mother"], ["ماما", "mother"], ["اب", "father"], ["والد", "parent"], ["بابا", "father"],
  ["زوج", "spouse"], ["زوجه", "spouse"], ["زوجت", "spouse"], ["اخ", "brother"], ["اخو", "brother"], ["اخت", "sister"], ["اخوه", "sibling"], ["اخوات", "sister"], ["اشقاء", "sibling"], ["شقيق", "brother"], ["شقيقه", "sister"], ["شقيقت", "sister"],
  ["ابن", "son"], ["ابنه", "daughter"], ["ابنت", "daughter"], ["بنت", "daughter"], ["ابناء", "son"], ["بنات", "daughter"], ["حفيد", "grandchild"], ["حفيده", "grandchild"], ["احفاد", "grandchild"],
  ["جد", "grandfather"], ["جده", "grandmother"], ["جدت", "grandmother"], ["اجداد", "grandparent"], ["عم", "uncle"], ["عمه", "aunt"], ["عمت", "aunt"], ["خال", "uncle"], ["خاله", "aunt"], ["خالت", "aunt"],
  ["صديق", "friend"], ["صديقه", "friend"], ["صديقت", "friend"], ["اصدقاء", "friend"], ["اصدقاي", "friend"], ["اصدقاو", "friend"], ["ابناي", "son"], ["ابناو", "son"], ["زملاي", "colleague"], ["زملاو", "colleague"], ["اشقاي", "sibling"], ["اشقاو", "sibling"], ["صديقات", "friend"], ["صداقه", "friend"], ["رفيق", "friend"], ["رفاق", "friend"],
  ["زميل", "colleague"], ["زميله", "colleague"], ["زملاء", "colleague"], ["عروس", "bride"], ["عريس", "groom"], ["عروسين", "wedding"], ["عروسان", "wedding"], ["خطيب", "fiance"], ["خطيبه", "fiance"], ["خطيبت", "fiance"],
  ["حبيب", "partner"], ["حبيبه", "partner"], ["حبيبت", "partner"], ["عايله", "family"], ["عايلت", "family"], ["اهل", "family"], ["اسره", "family"], ["اسرت", "family"], ["توام", "twin"], ["اقارب", "relative"], ["جار", "neighbour"], ["جيران", "neighbour"],
];
/** Groups that satisfy another group (the user said "my mum" → "parents" is not invented). */
const GROUP_IMPLIED_BY: Record<string, readonly string[]> = {
  parent: ["mother", "father"],
  spouse: ["husband", "wife"],
  husband: ["spouse"],
  wife: ["spouse"],
  sibling: ["brother", "sister"],
  grandparent: ["grandmother", "grandfather"],
  wedding: ["bride", "groom"],
  bride: ["wedding"],
  groom: ["wedding"],
  birthday: ["first_birthday"],
};

const MILESTONE_EN: Record<string, string> = {
  birthday: "birthday", birthdays: "birthday", bday: "birthday",
  anniversary: "anniversary", anniversaries: "anniversary",
  graduated: "graduation", graduation: "graduation", graduate: "graduation", graduates: "graduation", graduating: "graduation", diploma: "graduation",
  engaged: "engagement", engagement: "engagement", proposal: "engagement", proposed: "engagement", proposes: "engagement",
  wedding: "wedding", weddings: "wedding", married: "wedding", marriage: "wedding", marry: "wedding", nuptials: "wedding", vows: "wedding", bridal: "wedding",
  honeymoon: "honeymoon", newborn: "newborn", born: "newborn", birth: "newborn",
  pregnant: "pregnancy", pregnancy: "pregnancy", expecting: "pregnancy",
  retired: "retirement", retirement: "retirement", retiring: "retirement",
  christening: "christening", baptism: "christening", baptised: "christening", baptized: "christening",
  christmas: "christmas", xmas: "christmas", eid: "eid", ramadan: "ramadan", iftar: "ramadan", diwali: "diwali", easter: "easter", hanukkah: "hanukkah", thanksgiving: "thanksgiving", halloween: "halloween", valentine: "valentine", valentines: "valentine",
  reunion: "reunion", farewell: "farewell", promotion: "promotion", housewarming: "housewarming", funeral: "funeral", memorial: "funeral",
};
const MILESTONE_AR: readonly (readonly [string, string])[] = [
  ["ميلاد", "birthday"], ["سنويه", "anniversary"], ["سنوي", "anniversary"], ["زفاف", "wedding"], ["عرس", "wedding"], ["زواج", "wedding"], ["قران", "wedding"],
  ["خطوبه", "engagement"], ["خطبه", "engagement"], ["تخرج", "graduation"], ["مولود", "newborn"], ["مواليد", "newborn"], ["ولاده", "newborn"], ["حامل", "pregnancy"],
  ["تقاعد", "retirement"], ["رمضان", "ramadan"], ["افطار", "ramadan"], ["عيد", "eid"], ["كريسماس", "christmas"],
];
/** The book's occasion (a user choice) grants these groups when the occasion fact is cited. */
export const OCCASION_GROUPS: Record<string, readonly string[]> = {
  wedding: ["wedding"],
  birthday: ["birthday"],
  graduation: ["graduation"],
  family: ["family"],
  baby: [],
  travel: [],
  other: [],
};

const SPEECH_VERBS = new Set([
  "said", "says", "whispered", "whispers", "replied", "exclaimed", "announced", "promised", "told", "joked", "declared", "shouted", "murmured",
  "قال", "قالت", "قالوا", "قلنا", "همس", "همست", "اجاب", "اجابت", "وعد", "وعدت", "هتف", "صاح",
]);

const EMOTION_ADJ =
  "happy|happier|thrilled|excited|proud|nervous|overjoyed|delighted|sad|moved|touched|grateful|thankful|relieved|anxious|emotional|ecstatic|elated|joyful|content|surprised|amazed|overwhelmed|blessed|in love|at peace|homesick|heartbroken|speechless|eager|hopeful|worried|scared|afraid|lonely|fulfilled|giddy|smitten|pleased|glad|tearful|sentimental|nostalgic|carefree";
const MENTAL_VERBS =
  "loved|loves|adored|adores|enjoyed|enjoys|knew|thought|thinks|wished|wishes|hoped|hopes|wanted|believed|believes|realised|realized|remembered|remembers|dreamed|dreamt|cherished|treasured|missed|misses|longed|felt|feels|feel|couldn['’]?t believe|could not believe|couldn['’]?t wait|could not wait|fell in love|will never forget|would never forget|never forgot";
const PERSON_SUBJECT =
  "i|we|he|she|they|you|everyone|everybody|nobody|no one|each of us|each of them|all of us|all of them|both of us|both of them|both|the (?:two|three|four|five) of (?:us|them)|the (?:bride|groom|couple|family|children|kids|guests|boy|girl|boys|girls|man|woman|men|women|baby|child|crowd|group|newlyweds|parents|friends|birthday (?:girl|boy))|[A-Z][\\p{L}'’]+";
const ADVERB = "(?:(?:all|both|just|really|truly|still|never|always|simply|so|clearly|obviously|certainly|surely)\\s+)?";
const INTENSIFIER = "(?:(?:so|very|really|truly|absolutely|quite|deeply|a little|a bit|utterly|completely|more|too|incredibly)\\s+)?";
const FEELING_STATE = new RegExp(`(?<![\\p{L}])(?:${PERSON_SUBJECT})\\s+${ADVERB}(?:felt|feel|feels|was|were|is|are|am|seemed|seems|looked|looks|grew|became|got|must have been|must be)\\s+${INTENSIFIER}(${EMOTION_ADJ})(?![\\p{L}])`, "u");
const FEELING_STATE_I = new RegExp(FEELING_STATE.source.replace("[A-Z][\\p{L}'’]+", "\\b\\B"), "iu");
const FEELING_VERB = new RegExp(`(?<![\\p{L}])(?:${PERSON_SUBJECT})\\s+${ADVERB}(${MENTAL_VERBS})(?![\\p{L}])`, "u");
const FEELING_VERB_I = new RegExp(FEELING_VERB.source.replace("[A-Z][\\p{L}'’]+", "\\b\\B"), "iu");
const FEELING_NOUN = /(?<![\p{L}])(?:his|her|their|our|my|your)\s+(?:own\s+)?(joy|pride|excitement|happiness|delight|nerves|relief|gratitude|sadness|love|longing|heart|hearts|dream|dreams|wish|wishes|hopes|feelings|emotions)(?![\p{L}])/iu;
const EMOTION_AR = new Set(["سعيد", "سعيده", "سعداء", "سعيدين", "فخور", "فخوره", "فخورين", "فخورون", "متحمس", "متحمسه", "متحمسين", "حزين", "حزينه", "ممتن", "ممتنه", "ممتنين", "متوتر", "متوتره", "مسرور", "مسروره", "مبتهج", "مبتهجه", "فرحان", "فرحانه", "مشتاق", "مشتاقه", "مندهش", "منبهر"]);
const BE_AR = new Set(["كان", "كانت", "كانوا", "كنا", "كنت", "يبدو", "تبدو", "بدا", "بدت", "اصبح", "اصبحت"]);
const FEELING_VERBS_AR = new Set([
  "شعر", "شعرت", "شعروا", "شعرنا", "يشعر", "تشعر", "نشعر", "يشعرون", "احس", "احست", "احسسنا", "احسوا", "فرح", "فرحت", "فرحوا", "فرحنا",
  "احب", "احبت", "احببنا", "احبوا", "تمني", "تمنت", "تمنينا", "تمنوا", "عرف", "عرفت", "عرفنا", "ادرك", "ادركت", "ادركنا", "حلم", "حلمت", "حلمنا", "اشتاق", "اشتاقت", "اشتقنا",
]);

/** Stock phrases. `id` is safe to log; `example` is used by the tests. */
export const BANNED_PHRASES: readonly { id: string; re: RegExp; example: string }[] = [
  { id: "last_a_lifetime", re: /\bmemories\s+(?:that\s+)?(?:will\s+|to\s+)?last\s+a\s+lifetime\b/i, example: "memories that will last a lifetime" },
  { id: "unforgettable", re: /\bunforgettable\b/i, example: "an unforgettable evening" },
  { id: "cherish_forever", re: /\bcherish(?:ed)?\s+forever\b|\bforever\s+cherish(?:ed)?\b/i, example: "cherished forever" },
  { id: "day_to_remember", re: /\ba\s+(?:day|night|moment|trip|week|weekend|evening)\s+to\s+remember\b/i, example: "a day to remember" },
  { id: "moments_like_these", re: /\bmoments\s+like\s+(?:these|this)\b/i, example: "moments like these" },
  { id: "hearts_full", re: /\bhearts?\s+(?:(?:were|was|are|is|so|felt|feel)\s+){0,2}full\b|\bfull\s+hearts?\b/i, example: "our hearts were full" },
  { id: "truly_magical", re: /\b(?:truly|simply|purely|absolutely|utterly)\s+magical\b|\bpure\s+magic\b|\bmagical\s+(?:day|moment|evening|night|time)\b/i, example: "truly magical" },
  { id: "picture_perfect", re: /\bpicture[\s-]perfect\b/i, example: "a picture-perfect afternoon" },
  { id: "making_memories", re: /\bmaking\s+memories\b|\bmade\s+memories\b|\bmemories\s+(?:were\s+|being\s+|are\s+)?made\b|\bmemor(?:y|ies)\s+in\s+the\s+making\b/i, example: "making memories" },
  { id: "time_stood_still", re: /\btime\s+(?:stood|stands)\s+still\b|\btime\s+seemed\s+to\s+(?:stop|stand\s+still)\b/i, example: "time stood still" },
  { id: "once_in_a_lifetime", re: /\bonce[\s-]in[\s-]a[\s-]lifetime\b/i, example: "a once in a lifetime trip" },
  { id: "best_day_ever", re: /\bbest\s+(?:day|night|trip|time)\s+(?:ever|of\s+(?:our|my|their|his|her)\s+li(?:fe|ves))\b/i, example: "the best day ever" },
  { id: "love_in_the_air", re: /\blove\s+(?:is|was)\s+in\s+the\s+air\b/i, example: "love is in the air" },
  { id: "happily_ever_after", re: /\bhappily\s+ever\s+after\b/i, example: "happily ever after" },
  { id: "fairy_tale", re: /\bfairy[\s-]?tales?\b|\bstorybook\s+(?:ending|romance)\b/i, example: "a fairy tale ending" },
  { id: "dreams_come_true", re: /\bdreams?\s+(?:do\s+|really\s+)?c(?:o|a)mes?\s+true\b/i, example: "a dream come true" },
  { id: "words_cannot", re: /\bwords\s+(?:can(?:no|['’]?)t|could\s*n['’]?t|could\s+not|can\s+not)\s+(?:describe|express|capture)\b|\bbeyond\s+words\b/i, example: "words cannot describe it" },
  { id: "frozen_in_time", re: /\bfrozen\s+in\s+time\b/i, example: "a moment frozen in time" },
  { id: "priceless", re: /\bpriceless\b/i, example: "a priceless moment" },
  { id: "perfect_day", re: /\b(?:the|a)\s+perfect\s+(?:day|moment|ending|start|evening|night|way)\b/i, example: "the perfect day" },
  { id: "all_smiles", re: /\bsmiles?\s+all\s+a?round\b|\ball\s+smiles\b/i, example: "smiles all around" },
  { id: "good_times", re: /\bgood\s+times\b|\bgood\s+vibes\b/i, example: "good times with everyone" },
  { id: "best_life", re: /\bliving\s+(?:our|their|my|the|his|her|your)\s+best\s+li(?:fe|ves)\b/i, example: "living our best life" },
  { id: "blessed_beyond", re: /\bblessed\s+beyond\b|\btruly\s+blessed\b|\bso\s+blessed\b/i, example: "blessed beyond measure" },
  { id: "forever_and_always", re: /\bforever\s+and\s+(?:always|ever|a\s+day)\b|\bnow\s+and\s+forever\b/i, example: "forever and always" },
  { id: "adventure_begins", re: /\b(?:adventure|journey|story)\s+(?:begins|continues|awaits)\b|\blet\s+the\s+adventure\b|\band\s+so\s+it\s+begins\b|\bnew\s+chapter\b/i, example: "the adventure begins" },
  { id: "love_and_laughter", re: /\blove\s+and\s+laughter\b|\blaughter\s+and\s+love\b|\blive,?\s+laugh,?\s+love\b/i, example: "love and laughter" },
  { id: "filled_with_love", re: /\b(?:filled|full|overflowing)\s+(?:with|of)\s+(?:love|joy|laughter|happiness)\b/i, example: "a day filled with love" },
  { id: "never_forget", re: /\bnever\s+(?:be\s+)?forg(?:e|o)t(?:ten)?\b/i, example: "we will never forget this" },
  { id: "treasured", re: /\btreasured?\s+(?:memor(?:y|ies)|moments?)\b|\bprecious\s+(?:memor(?:y|ies)|moments?)\b/i, example: "treasured memories" },
  { id: "breathtaking", re: /\bbreath[\s-]?taking\b|\btook\s+(?:our|my|their|his|her)\s+breath\s+away\b|\btakes?\s+(?:your|our|my)\s+breath\s+away\b/i, example: "a breathtaking view" },
  { id: "heartwarming", re: /\bheart[\s-]?warming\b|\bwarms?\s+the\s+heart\b/i, example: "a heartwarming scene" },
  { id: "one_for_the_books", re: /\bone\s+for\s+the\s+books\b/i, example: "one for the books" },
  { id: "time_of_our_lives", re: /\btime\s+of\s+(?:our|their|my|his|her|your)\s+li(?:fe|ves)\b/i, example: "the time of our lives" },
  { id: "nothing_but", re: /\bnothing\s+but\s+(?:love|smiles|joy|happiness|good)\b/i, example: "nothing but smiles" },
  { id: "celebration_of_love", re: /\bcelebration\s+of\s+(?:love|life)\b/i, example: "a celebration of love" },
  { id: "last_forever", re: /\blast(?:s|ing|ed)?\s+forever\b/i, example: "a bond that lasts forever" },
  { id: "too_good", re: /\btoo\s+good\s+to\s+be\s+true\b/i, example: "almost too good to be true" },
  { id: "blink_of_an_eye", re: /\bblink\s+of\s+an\s+eye\b|\btime\s+flies\b/i, example: "gone in the blink of an eye" },
  { id: "little_things", re: /\b(?:it['’]?s|it\s+is)\s+the\s+little\s+things\b|\benjoy\s+the\s+little\s+things\b/i, example: "it's the little things" },
  { id: "home_is_where", re: /\bhome\s+is\s+where\b|\bnot\s+all\s+(?:those\s+)?who\s+wander\b|\bcarpe\s+diem\b|\bseize\s+the\s+day\b/i, example: "home is where the heart is" },
  // Arabic (matched on the normalised text)
  { id: "ar_la_tunsa", re: /لا\s+(?:تنسي|ينسي|تنسا)/u, example: "ذكريات لا تُنسى" },
  { id: "ar_la_tuawwad", re: /لا\s+(?:تعوض|يعوض)/u, example: "لحظات لا تعوض" },
  { id: "ar_forever", re: /(?:الي\s+|ل)الابد|للابد/u, example: "معًا إلى الأبد" },
  { id: "ar_best_day", re: /اجمل\s+(?:يوم|ايام|الايام|لحظه|اللحظات|لحظات)/u, example: "أجمل يوم في حياتنا" },
  { id: "ar_dream_true", re: /(?:حلم\s+(?:تحقق|يتحقق)|تحقق\s+الحلم)/u, example: "حلم تحقق" },
  { id: "ar_time_stopped", re: /(?:توقف\s+(?:الزمن|الوقت)|(?:الزمن|الوقت)\s+توقف)/u, example: "كأن الزمن توقف" },
  { id: "ar_magical", re: /(?:لحظ(?:ه|ات)|ليله|اجواء)\s+سحريه/u, example: "لحظات سحرية" },
  { id: "ar_beyond_words", re: /لا\s+(?:توصف|يوصف)/u, example: "سعادة لا توصف" },
  { id: "ar_fairy_tale", re: /(?:قصه|حكايه)\s+خياليه|كالحلم|مثل\s+الحلم/u, example: "قصة خيالية" },
  { id: "ar_memories_last", re: /ذكريات\s+(?:تدوم|خالده|ستبقي)/u, example: "ذكريات تدوم" },
  { id: "ar_heart_full", re: /(?:قلوب|قلب)\S*\s+(?:ملييه|مليء|ممتليه|عامره)/u, example: "قلوب مليئة بالحب" },
  { id: "ar_from_heart", re: /من\s+القلب\s+(?:الي|ل)\s*القلب/u, example: "من القلب إلى القلب" },
];

/** Opening words that may start a sentence capitalised without being a name. */
export const SENTENCE_STARTERS: ReadonlySet<string> = new Set(
  (
    "a an the this that these those there here it its we our us i my me you your he she they his her their them one some any every each all both many few several most much more less another other such no none nothing everything something everyone everybody someone nobody " +
    "in on at by with from into onto over under above below beside between among around across along through behind beyond before after during until since near inside outside within without toward towards past off up down out about against upon amid " +
    "and but or so yet nor for then now later soon still again once when while where as if though although because whenever wherever how why what who which whose " +
    "not never always often sometimes also even just only already almost nearly maybe perhaps finally slowly quietly gently softly together apart side " +
    "morning afternoon evening night midday noon dawn dusk sunrise sunset daylight light sunlight shade shadows today tonight " +
    "photos photographs pictures pages hands faces smiles laughter people everyone guests music colours colors flowers candles tables plates glasses lanterns waves water sand sky clouds wind rain trees streets doors windows steps footsteps voices " +
    "is are was were be has have had do does did can could will would may might let lets make take look see come go stay keep hold " +
    "first next last outside inside meanwhile afterwards afterward elsewhere nearby overhead ahead back away home little small big long short quiet soft warm cool bright dark golden new old late early"
  ).split(/\s+/),
);
const CAP_ALLOW = new Set(["i", "im", "ive", "ill", "id", "ok"]);

// ---------------------------------------------------------------------------- classification

const AR_PRONOUN_SUFFIX = ["", "ي", "نا", "ه", "ها", "هم", "هما", "هن", "ك", "كم", "ين", "ون", "ان", "ات", "ت", "وا", "تي", "ته", "تها", "تنا"];
const AR_SHORT_SUFFIX = ["ي", "نا", "ه", "ها", "هم", "ك", "كم"];

/**
 * Candidate stems of a normalised Arabic token. `level` says how much was removed:
 * 0 = nothing or the article, 1 = a conjunction (و / ف) or a preposition WITH the article
 * ("بالعيد"), 2 = a bare one-letter preposition (ب / ل / ك) — the risky one ("بعيد" is "far",
 * not "ب + عيد").
 */
function arForms(norm: string): { form: string; level: 0 | 1 | 2 }[] {
  const out: { form: string; level: 0 | 1 | 2 }[] = [{ form: norm, level: 0 }];
  if (!AR_LETTER.test(norm)) return out;
  const bases: { form: string; level: 0 | 1 }[] = [{ form: norm, level: 0 }];
  if (/^[وف]/u.test(norm) && norm.length >= 3) bases.push({ form: norm.slice(1), level: 1 });
  for (const b of bases) {
    if (b.level === 1) out.push(b);
    if (b.form.startsWith("ال") && b.form.length >= 4) out.push({ form: b.form.slice(2), level: b.level });
    else if (b.form.startsWith("لل") && b.form.length >= 4) out.push({ form: b.form.slice(2), level: 1 });
    else if (/^[بلك]ال/u.test(b.form) && b.form.length >= 5) out.push({ form: b.form.slice(3), level: 1 });
    else if (/^[بلك]/u.test(b.form) && b.form.length >= 3) out.push({ form: b.form.slice(1), level: 2 });
  }
  return out;
}

function arGroup(norm: string, table: readonly (readonly [string, string])[]): string | null {
  if (!AR_LETTER.test(norm)) return null;
  for (const { form, level } of arForms(norm)) {
    for (const [stem, group] of table) {
      if (!form.startsWith(stem)) continue;
      const rest = form.slice(stem.length);
      if (rest === "") {
        // the bare word: "اب" / "ام" / "جد" only unprefixed ("وجد" is "found"); 3-letter stems
        // not behind a bare preposition; longer stems always
        if (stem.length <= 2 ? level === 0 : stem.length === 3 ? level <= 1 : true) return group;
      } else if (stem.length <= 2 ? AR_SHORT_SUFFIX.includes(rest) : AR_PRONOUN_SUFFIX.includes(rest)) return group;
    }
  }
  return null;
}

type Classes = {
  rel?: string;
  milestone?: string;
  month?: number;
  weekday?: boolean;
  year?: boolean;
  num?: string;
  season?: boolean;
  duration?: boolean;
  speech?: boolean;
};

function classify(t: Tok, next: Tok | undefined, prev: Tok | undefined): Classes {
  const c: Classes = {};
  const n = t.norm;
  const rel = REL_EN[n] ?? arGroup(n, REL_AR);
  if (rel) c.rel = rel;
  let milestone: string | null = MILESTONE_EN[n] ?? arGroup(n, MILESTONE_AR);
  if (milestone === "eid" && next && arGroup(next.norm, MILESTONE_AR) === "birthday") milestone = null; // "عيد ميلاد"
  if (!milestone && n === "first" && next && FIRST_NOUNS.has(next.norm)) milestone = next.norm === "birthday" ? "first_birthday" : "first";
  if (!milestone && ORDINALS.has(n) && n !== "first" && next && (next.norm === "birthday" || next.norm === "anniversary" || next.norm === "child" || next.norm === "baby")) milestone = "ordinal";
  if (!milestone && n === "new" && next && (next.norm === "year" || next.norm === "years") && t.cap) milestone = "new_year";
  if (!milestone && n === "baby" && next && next.norm === "shower") milestone = "baby_shower";
  if (milestone) c.milestone = milestone;

  const monthIdx = MONTHS_EN.indexOf(n);
  if (monthIdx >= 0 && (!AMBIGUOUS_MONTHS.has(n) || (t.cap && !(n === "may" && t.initial)))) c.month = monthIdx + 1;
  else if (t.cap && MONTH_ABBR[n] !== undefined) c.month = MONTH_ABBR[n];
  else if (MONTHS_AR[n] !== undefined) c.month = MONTHS_AR[n];
  if (WEEKDAYS_EN.has(n) || WEEKDAYS_AR.has(n)) c.weekday = true;
  if (SEASONS.has(n)) c.season = true;
  // "three years old" is an age (checked on its own), "this year" is not a duration
  if (DURATIONS.has(n) && !(prev && (prev.norm === "new" || prev.norm === "this") && n === "year") && next?.norm !== "old") c.duration = true;
  if (/^(?:1[89]|20)\d\d$/.test(n)) c.year = true;
  else if (/\d/.test(n)) c.num = n.replace(/\D/g, "");
  else if (NUMBER_WORDS[n] !== undefined) c.num = String(NUMBER_WORDS[n]);
  if (SPEECH_VERBS.has(n)) c.speech = true;
  return c;
}

type Vocab = {
  tokens: Set<string>;
  groups: Set<string>;
  months: Set<number>;
  nums: Set<string>;
  /** 4-word sequences of the sources (a place name used twice is not a repetition). */
  grams: Set<string>;
};

const stem = (n: string) => (n.length > 3 && n.endsWith("s") ? n.slice(0, -1) : n);

function vocabOf(texts: readonly string[], extraGroups: readonly string[] = []): Vocab {
  const v: Vocab = { tokens: new Set(), groups: new Set(extraGroups), months: new Set(), nums: new Set(), grams: new Set() };
  for (const text of texts) {
    const toks = tokenize(text);
    toks.forEach((t, i) => {
      v.tokens.add(t.norm);
      v.tokens.add(stem(t.norm));
      for (const f of arForms(t.norm)) v.tokens.add(f.form);
      // a source is trusted: "May" / "march" in the user's own words count as the month too
      const c = classify({ ...t, cap: true, initial: false }, toks[i + 1], toks[i - 1]);
      if (c.rel) v.groups.add(c.rel);
      if (c.milestone) v.groups.add(c.milestone);
      if (c.month) v.months.add(c.month);
      if (c.num) v.nums.add(c.num);
      if (c.year) v.nums.add(t.norm);
      if (ORDINALS.has(t.norm)) v.tokens.add(`ord:${t.norm}`);
    });
    for (const g of grams(toks.map((t) => t.norm), 4)) v.grams.add(g);
  }
  return v;
}

function hasGroup(v: Vocab, group: string): boolean {
  if (v.groups.has(group)) return true;
  return (GROUP_IMPLIED_BY[group] ?? []).some((g) => v.groups.has(g));
}
const hasToken = (v: Vocab, norm: string) => v.tokens.has(norm) || v.tokens.has(stem(norm)) || arForms(norm).some((f) => v.tokens.has(f.form));

function grams(norms: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= norms.length; i++) out.push(norms.slice(i, i + n).join(" "));
  return out;
}

const collapse = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

// ---------------------------------------------------------------------------- the scan

type Found = { code: GroundingIssueCode; detail: string };

type ScanInput = {
  text: string;
  lang: "en" | "ar";
  /** Facts + metadata the text may take names, dates and events from. */
  trusted: Vocab;
  /** Vision evidence: ordinary words and visible counts only. */
  evidence: Vocab;
  /** Verbatim texts a quotation may come from (the user's own words). */
  quotable: readonly string[];
  /** Name words of listed people whose fact is NOT cited. */
  uncitedNames: ReadonlySet<string>;
  /** Things the user asked not to mention. */
  avoid: readonly string[];
};

function scan(input: ScanInput): Found[] {
  const { text, trusted, evidence } = input;
  const found: Found[] = [];
  const add = (code: GroundingIssueCode, detail: string) => {
    if (!found.some((f) => f.code === code && f.detail === detail)) found.push({ code, detail });
  };
  const toks = tokenize(text);

  toks.forEach((t, i) => {
    const c = classify(t, toks[i + 1], toks[i - 1]);
    const known = hasToken(trusted, t.norm);

    if (c.rel && !hasGroup(trusted, c.rel)) add("ungrounded_relationship", "relationship");
    if (c.milestone) {
      const ok = c.milestone === "first" || c.milestone === "ordinal" ? known : hasGroup(trusted, c.milestone) || (c.milestone === "first_birthday" && known && hasGroup(trusted, "birthday"));
      if (!ok) add("ungrounded_milestone", c.milestone === "first" || c.milestone === "first_birthday" || c.milestone === "ordinal" ? "ordinal_milestone" : "milestone");
    }
    if (c.month && !trusted.months.has(c.month)) add("ungrounded_date", "month");
    if (c.weekday && !known) add("ungrounded_date", "weekday");
    if (c.season && !known) add("ungrounded_date", "season");
    if (c.duration && !known) add("ungrounded_date", "duration");
    if (c.year && !trusted.nums.has(t.norm)) add("ungrounded_date", "year");
    if (c.num && !trusted.nums.has(c.num) && !evidence.nums.has(c.num)) add("ungrounded_number", "number");
    if (c.speech && !known) add("quoted_speech", "reported");

    // names: capitalised Latin words
    if (t.cap && LATIN_LETTER.test(t.raw) && !known && !CAP_ALLOW.has(t.norm) && !c.month && !c.weekday) {
      const ordinary = t.initial && (SENTENCE_STARTERS.has(t.norm) || hasToken(evidence, t.norm));
      // category words are reported under their own code, not as a name as well
      const categorised = !!(c.rel || c.milestone || c.season || c.duration || c.num || c.speech) && t.initial;
      if (!ordinary && !categorised) add("ungrounded_name", "proper_noun");
    }
    if (input.uncitedNames.has(t.norm) && !known) add("ungrounded_name", "uncited_person");
  });

  // ages: the number must come from a fact (a description cannot know an age)
  const lower = westernDigits(text).toLowerCase();
  const age =
    /(?<![\p{L}])([\p{L}\d]+)[\s-]+(?:years?|months?|weeks?)[\s-]+old(?![\p{L}])/u.exec(lower) ??
    /(?<![\p{L}])(?:turn(?:s|ed|ing)?|aged?)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?![\p{L}])/u.exec(lower);
  if (age) {
    const raw = age[1]!;
    const n = /^\d+$/.test(raw) ? raw : NUMBER_WORDS[raw] !== undefined ? String(NUMBER_WORDS[raw]) : null;
    if (n === null ? !hasToken(trusted, "old") : !trusted.nums.has(n)) add("ungrounded_date", "age");
  }
  const norms = toks.map((t) => t.norm);
  if (norms.some((n, i) => (/^عمر(?:ه|ها|ي|هم|نا)?$/u.test(n) || (n === "العمر" && norms[i - 1] === "من") || n === "بلغ" || n === "بلغت") && !hasToken(trusted, n))) add("ungrounded_date", "age");

  // quotations: only the user's own words, verbatim
  const quotable = input.quotable.map(collapse);
  const quoteRe = /“([^”]*)”|"([^"]*)"|«([^»]*)»|„([^“”]*)[“”]|‹([^›]*)›/gu;
  let rest = text;
  for (const m of text.matchAll(quoteRe)) {
    const inner = collapse(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "");
    rest = rest.replace(m[0], " ");
    if (!inner || !quotable.some((q) => q.includes(inner))) add("quoted_speech", "quotation");
  }
  if (/[“”"«»„‹›]/u.test(rest)) add("quoted_speech", "quotation");

  // feelings stated as fact
  for (const re of [FEELING_STATE, FEELING_STATE_I, FEELING_VERB, FEELING_VERB_I, FEELING_NOUN]) {
    const m = re.exec(text);
    if (!m) continue;
    const word = normalizeToken(m[1]!.split(/\s+/).pop()!);
    if (!hasToken(trusted, word)) add("stated_feeling", "feeling");
  }
  norms.forEach((n, i) => {
    if (FEELING_VERBS_AR.has(n) && !hasToken(trusted, n)) add("stated_feeling", "feeling");
    if (BE_AR.has(n)) {
      const adj = [norms[i + 1], norms[i + 2]].find((x) => x !== undefined && EMOTION_AR.has(x));
      if (adj && !hasToken(trusted, adj)) add("stated_feeling", "feeling");
    }
  });

  // stock phrases
  const normalizedText = normalizeArabic(text.normalize("NFC")).replace(/\s+/g, " ");
  if (BANNED_PHRASES.some((p) => p.re.test(normalizedText))) add("banned_phrase", "cliche");

  // things the user asked to leave out
  const joined = ` ${norms.join(" ")} `;
  for (const a of input.avoid) {
    const words = tokenize(a).map((t) => t.norm);
    if (words.length === 0 || words.join("").length < 3) continue;
    if (joined.includes(` ${words.join(" ")} `)) add("avoided_topic", "avoid");
  }
  return found;
}

function scriptIssue(text: string, lang: "en" | "ar", trusted: Vocab): boolean {
  let arabic = 0;
  let latin = 0;
  for (const t of tokenize(text)) {
    if (hasToken(trusted, t.norm)) continue; // a name the user typed in the other script
    for (const ch of t.raw) {
      if (AR_LETTER.test(ch)) arabic++;
      else if (LATIN_LETTER.test(ch)) latin++;
    }
  }
  const total = arabic + latin;
  if (total === 0) return false;
  return lang === "ar" ? arabic / total < 0.8 : latin / total < 0.8;
}

/** Name words of people the user listed ("Sara — my sister" → "sara"). */
function personNameWords(fact: GroundingFact): string[] {
  if (fact.kind !== "person") return [];
  const name = fact.text.split(/\s[—–-]\s/)[0] ?? "";
  return tokenize(name)
    .map((t) => t.norm)
    .filter((n) => n.length >= 3);
}

function occasionGroups(facts: readonly GroundingFact[]): string[] {
  return facts.filter((f) => f.kind === "occasion").flatMap((f) => OCCASION_GROUPS[f.text.trim().toLowerCase()] ?? []);
}

const evidenceText = (p: GroundingPhoto) => p.evidence;
const metaTexts = (p: GroundingPhoto) => [p.place, p.dateLabel].filter((x): x is string => !!x);

function repetitionIssue(text: string, others: readonly string[], exempt: Vocab): string | null {
  const norms = tokenize(text).map((t) => t.norm);
  if (norms.length === 0) return null;
  const opening = norms.slice(0, 3).join(" ");
  const own = grams(norms, 4).filter((g) => !exempt.grams.has(g));
  for (const other of others) {
    const o = tokenize(other).map((t) => t.norm);
    if (o.length === 0) continue;
    if (norms.length >= 3 && o.length >= 3 && o.slice(0, 3).join(" ") === opening) return "opening";
    if (own.length === 0) continue;
    const set = new Set(grams(o, 4));
    if (own.some((g) => set.has(g))) return "sequence";
  }
  return null;
}

/**
 * All grounding issues of one block. Empty array = accepted. The block is checked against the
 * sources it CITES: a name that is in the memory facts but not in a cited fact is rejected.
 */
export function checkBlock(block: BlockDraft, ctx: GroundingContext): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const push = (code: GroundingIssueCode, detail?: string) => {
    if (!issues.some((i) => i.code === code && i.detail === detail)) issues.push(detail ? { blockId: block.blockId, code, detail } : { blockId: block.blockId, code });
  };
  const text = block.text.trim();
  if (!text) return [{ blockId: block.blockId, code: "empty" }];

  // 1. sources
  const photoRefs = [...new Set(block.photoRefs)];
  const factRefs = [...new Set(block.factRefs)];
  if (photoRefs.length > MAX_PHOTO_REFS || factRefs.length > MAX_FACT_REFS) push("too_many_refs");
  if (photoRefs.length + factRefs.length === 0) push("no_refs");
  else if (block.kind !== "closing" && photoRefs.length === 0) push("no_refs", "no_photo");
  const citedPhotos: GroundingPhoto[] = [];
  for (const ref of photoRefs) {
    const p = ctx.photos.get(ref);
    if (p) citedPhotos.push(p);
    else if (ctx.bookPhotos?.has(ref)) push("ref_outside_chapter", "photo");
    else push("unknown_ref", "photo");
  }
  const citedFacts: GroundingFact[] = [];
  for (const ref of factRefs) {
    const f = ctx.facts.get(ref);
    if (f) citedFacts.push(f);
    else push("unknown_ref", "fact");
  }

  // 2. length
  const words = countWords(text);
  const bounds = WORD_BOUNDS[block.kind];
  if (words < bounds.min) push("too_short");
  if (words > bounds.max || text.length > BLOCK_MAX_UNITS) push("too_long");

  // 3. content against the cited sources
  const trusted = vocabOf([...citedFacts.map((f) => f.text), ...citedPhotos.flatMap(metaTexts)], occasionGroups(citedFacts));
  const evidence = vocabOf(citedPhotos.map(evidenceText));
  const citedSet = new Set(citedFacts);
  const uncitedNames = new Set<string>();
  for (const f of ctx.facts.values()) if (!citedSet.has(f)) for (const w of personNameWords(f)) uncitedNames.add(w);
  for (const f of scan({ text, lang: ctx.lang, trusted, evidence, quotable: citedFacts.map((x) => x.text), uncitedNames, avoid: ctx.avoid ?? [] })) push(f.code, f.detail);
  if (scriptIssue(text, ctx.lang, trusted)) push("wrong_script");

  // 4. repetition across the storybook
  const rep = repetitionIssue(text, ctx.otherTexts, trusted);
  if (rep) push("repetition", rep);
  return issues;
}

export type PlanTextContext = {
  lang: "en" | "ar";
  /** Every memory fact of the book (a title cites nothing, so all of them count). */
  facts: readonly GroundingFact[];
  /** Metadata + grounded labels of the chapter (places, date labels, moment labels). */
  metadata: readonly string[];
  /** Vision evidence of the chapter's photos. */
  evidence: readonly string[];
  avoid?: readonly string[];
};

/**
 * Grounding of an outline text — a book / chapter title (≤ 60 chars, printed) or a chapter arc
 * (≤ 200 chars, internal but fed to the writer). Titles must be written in sentence case: any
 * capitalised word after the first has to be a name from the facts or the metadata.
 */
export function checkPlanText(id: string, kind: "title" | "arc", text: string, ctx: PlanTextContext): GroundingIssue[] {
  const t = text.trim();
  if (!t) return [{ blockId: id, code: "empty" }];
  const issues: GroundingIssue[] = [];
  const push = (code: GroundingIssueCode, detail?: string) => {
    if (!issues.some((i) => i.code === code && i.detail === detail)) issues.push(detail ? { blockId: id, code, detail } : { blockId: id, code });
  };
  if ([...t].length > (kind === "title" ? TITLE_MAX_CHARS : ARC_MAX_CHARS)) push("too_long");
  const facts = [...ctx.facts];
  const trusted = vocabOf([...facts.map((f) => f.text), ...ctx.metadata], occasionGroups(facts));
  const evidence = vocabOf([...ctx.evidence, ...ctx.metadata]);
  for (const f of scan({ text: t, lang: ctx.lang, trusted, evidence, quotable: facts.map((x) => x.text), uncitedNames: new Set(), avoid: ctx.avoid ?? [] })) push(f.code, f.detail);
  if (scriptIssue(t, ctx.lang, trusted)) push("wrong_script");
  return issues;
}
