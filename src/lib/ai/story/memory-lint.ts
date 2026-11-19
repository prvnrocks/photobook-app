// Memory-narrative lints (story v3, 2026-11-19). Pure: no I/O, no model calls, no logging.
//
// v2 stopped object inventories; live v2 output then read as photo-shoot COMMENTARY ("The cups got
// their close-ups first", "Then the portraits took over", "shot after shot") — sentences whose
// subject is the camera or the photographs, not the people or the memory. v3 rejects:
//   photo_commentary   the camera / shots / poses / close-ups / angles / frames / portraits /
//                      selfies as the subject or the activity ("kept clicking", "every angle",
//                      "took more photos", "the photos got playful"), and pose / gesture
//                      descriptions ("a thumbs up", "one foot against the wall", "a hand over the mouth")
//   generic_language   inspirational filler that could close any book ("the little things",
//                      "some bonds never fade", "as if no time had passed", "a testament to")
//   unsupported_claim  things the photos and the user's words cannot know: what was said
//                      (talked / caught up / reminisced …), why people were apart or for how long
//                      (moved abroad, all these years, since we last …)
//   claimed_emotion    an emotion word (joy, tears, nostalgic, grateful …) that no cited FACT
//                      gives — in personal mode the brief's user-supported emotional direction may
//                      allow a word when the block also cites a fact; in observational mode never
//   wrong_voice        "I" / "we" in a book told in the third person (observational mode)
//
// Each finding is { code, detail } with a CATEGORY as detail — never text from the block.
// English only: Arabic is not checked by these lints (same limit as the v2 narrative lints).
// Word lists, not understanding: a paraphrase the lists miss passes ("a lens-eye view of …" is
// caught, "we smiled for the phone" is not). A false rejection costs one repair call.

import { normalizeToken, tokenize } from "./grounding";

export const MEMORY_LINT_CODES = ["photo_commentary", "generic_language", "unsupported_claim", "claimed_emotion", "wrong_voice"] as const;
export type MemoryLintCode = (typeof MEMORY_LINT_CODES)[number];
export type MemoryLintFinding = { code: MemoryLintCode; detail: string };

export type StoryMode = "personal" | "observational";

export type MemoryLintContext = {
  /** Texts of the FACTS the block cites (the user's own words). */
  citedFactTexts: readonly string[];
  /** What the cited photos' notes say (visible activities may support "laughing", "talking"). */
  evidenceTexts?: readonly string[];
  mode?: StoryMode;
  narrator?: "first_singular" | "first_plural" | "third";
  /**
   * Emotion words the brief allows because the USER's context supports them (personal mode only;
   * normalised tokens). Used only when the block cites at least one fact.
   */
  allowedEmotions?: ReadonlySet<string>;
  /** v4: kinds of the cited facts (answer / note / person … — the user's own words about the memory). */
  citedFactKinds?: readonly string[];
  /** v4: the block kind — a headline / closing line / intro may use a warm line the user's words ground. */
  kind?: string;
};

/** Words that make the camera / the photographs the subject of the story. */
const COMMENTARY_TOKENS = new Set(
  "camera cameras lens lenses shot shots snapshot snapshots pose poses posed posing poser portrait portraits selfie selfies photoshoot photoshoots shutter snapping snapped clicking clicked photographer photographers framing reframed".split(" "),
);
const COMMENTARY_PATTERNS: readonly RegExp[] = [
  /\bclose[\s-]?ups?\b/i,
  /\bphoto[\s-]?shoots?\b/i,
  /\b(?:in|into|out\s+of|inside)\s+(?:the|every|each|that|this)\s+frames?\b/i,
  /\b(?:every|each|the|best|right|another|new)\s+angles?\b/i,
  /\b(shot|frame|pose|photo|picture|snap|click)s?\s+after\s+\1s?\b/i,
  /\b(?:the|our|my|these|those|their|its|more|every|each|all\s+the)\s+(?:photos?|pictures?|images?|snaps?|frames?)\s+(?:got|get|gets|took|take|takes|kept|keep|keeps|came|come|comes|turned|turns|continued|began|begin|started|start|went|piled|rolled|show|shows|showed|capture|captures|captured|caught|moved|shifted|grew|loosened|changed|followed)\b/i,
  /\b(?:took|take|takes|taking|snap|snaps|snapped|grabbed|grab)\s+(?:a\s+|some\s+|more\s+|our\s+|the\s+|a\s+few\s+|another\s+)?(?:photos?|pictures?|snaps?)\b/i,
  /\b(?:one\s+more|another|a\s+few\s+more|more)\s+(?:photos?|pictures?)\b/i,
  // v4: the book itself is not the story ("the name on the cover", "the title of this book")
  /\b(?:name|title|words?)\s+on\s+(?:the|its|our)\s+cover\b|\bthe\s+cover\s+(?:says|reads)\b|\bthe\s+(?:book['’]s\s+)?title\s+(?:says|reads|is)\b/i,
];

const GENERIC_PATTERNS: readonly { id: string; re: RegExp }[] = [
  { id: "about", re: /\b(?:life|it)\s+(?:is|was)\s+(?:all\s+)?about\b/i },
  { id: "what_matters", re: /\bwhat\s+(?:really|truly)?\s*matter(?:s|ed)\s+most\b|\bwhat\s+(?:really|truly)\s+matter(?:s|ed)\b/i },
  { id: "little_things", re: /\bthe\s+(?:simple|little|small)\s+things\b/i },
  { id: "reminds_us", re: /\bremind(?:s|ed)?\s+us\b/i },
  { id: "some_bonds", re: /\bsome\s+(?:bonds|things|moments|memories|connections|people)\s+(?:never|don['’]?t|do\s+not|can['’]?t|cannot|always)\b/i },
  { id: "no_matter", re: /\bno\s+matter\s+(?:how\s+(?:long|far|much)|the\s+distance|what)\b/i },
  { id: "no_time_passed", re: /\bas\s+(?:if|though)\s+no\s+time\s+had\s+passed\b|\bpick(?:ed|ing)?\s+up\s+(?:right\s+)?where\s+(?:we|they)\s+(?:had\s+)?left\s+off\b|\blike\s+old\s+times\b|\blike\s+we\s+had\s+never\s+been\s+apart\b/i },
  { id: "bond", re: /\b(?:unbreakable|timeless|soulful)\b|\bbonds?\b/i },
  { id: "cherish", re: /\bcherish(?:ed|es|ing)?\b/i },
  { id: "embrace", re: /\bembrac(?:e|ed|ing)\s+(?:the|every|each|life)\b/i },
  { id: "every_moment", re: /\b(?:every|each)\s+moment\s+(?:counts|counted|matters|mattered)\b|\bsavou?r(?:ed|ing)?\s+every\b/i },
  { id: "heres_to", re: /\bhere['’]?s\s+to\b/i },
  { id: "testament", re: /\ba\s+testament\s+to\b/i },
  { id: "the_beauty_of", re: /\bthe\s+(?:beauty|power|magic|meaning|joy|gift)\s+of\b/i },
  { id: "meant_everything", re: /\bmeant\s+(?:the\s+world|everything|so\s+much)\b|\bworth\s+every\s+(?:second|minute|mile)\b/i },
  { id: "beyond_words", re: /\bwords\s+(?:can['’]?t|cannot|could\s+not|couldn['’]?t)\b|\bmore\s+than\s+words\b|\bspeaks?\s+volumes\b|\bsaid\s+it\s+all\b/i },
  { id: "full_circle", re: /\bfull\s+circle\b|\bthe\s+start\s+of\s+something\b/i },
];

/**
 * v4 (allowed voice): warm, simple lines that are filler in general but SINCERE when the user's own
 * words ground them — "Some moments are worth the wait." after the user said they met again after a
 * long time. Allowed only in personal mode, only in a headline / closing line / intro, and only when
 * the block cites a fact of the user's own (answer / note / fact / person / place) whose words match
 * `groundedBy`; anywhere else they are generic_language like the patterns above.
 */
const SOFT_GENERIC: readonly { id: string; re: RegExp; groundedBy: RegExp }[] = [
  { id: "worth_the_wait", re: /\bworth\s+the\s+wait(?:ing)?\b/i, groundedBy: /\b(?:long\s+time|years?|months?|finally|wait(?:ed|ing)?|apart|again|ages|since|reunion|reunit\w*|first\s+time|missed|at\s+last|after\s+so\s+long)\b/i },
];
const SOFT_KINDS = new Set(["headline", "closing_line", "intro"]);
const USER_FACT_KINDS = new Set(["answer", "note", "fact", "person", "place"]);

/** A soft generic line used outside what grounds it: the pattern id, or null. */
function softGenericIssue(text: string, ctx: MemoryLintContext): string | null {
  for (const p of SOFT_GENERIC) {
    if (!p.re.test(text)) continue;
    const userTexts = ctx.citedFactTexts.filter((_, i) => USER_FACT_KINDS.has(ctx.citedFactKinds?.[i] ?? ""));
    const ok = ctx.mode === "personal" && SOFT_KINDS.has(ctx.kind ?? "") && userTexts.some((t) => p.groundedBy.test(t));
    if (!ok) return p.id;
  }
  return null;
}

/** Claims about what was SAID (needs a fact, or a visible activity for talking / laughing). */
const CONVERSATION_TOKENS = new Set("talk talks talked talking chat chats chatted chatting spoke speak speaks speaking conversation conversations discussed discussing reminisced reminiscing reminisce confided confiding stories laughed laughing laughter joked joking jokes gossip gossiped".split(" "));
const CONVERSATION_PATTERNS: readonly RegExp[] = [/\bcatch(?:ing|es)?\s+up\b|\bcaught\s+up\b/i, /\bswapp?(?:ed|ing)?\s+(?:stories|news)\b|\bshared\s+(?:stories|news)\b/i];
/** Claims about why or how long people were apart. */
const SEPARATION_PATTERNS: readonly RegExp[] = [
  /\b(?:moved|moving|relocated|relocating)\s+(?:away|abroad|overseas|back|to|out)\b/i,
  /\b(?:abroad|overseas)\b/i,
  /\bmiles\s+(?:apart|away)\b|\bfar\s+(?:apart|away)\b|\boceans?\s+apart\b|\bcountries\s+apart\b/i,
  /\bbusy\s+lives\b|\blives\s+got\s+(?:busy|in\s+the\s+way)\b|\blife\s+got\s+in\s+the\s+way\b/i,
  /\bsince\s+(?:we|they|i)\s+(?:last|had\s+last|were\s+last)\b/i,
  /\bfirst\s+time\s+in\s+(?:years|months|ages|a\s+long\s+time|forever|so\s+long)\b/i,
  /\ball\s+(?:these|those)\s+(?:years|months)\b|\bso\s+many\s+(?:years|months)\b|\bin\s+ages\b|\bfor\s+ages\b/i,
  // v4: "after a long time" / "after so long" — how long anyone waited is the user's to say
  /\bafter\s+(?:such\s+|so\s+|a\s+)?(?:a\s+)?(?:long\s+(?:time|while|wait)|so\s+long|all\s+(?:this|that)\s+time|(?:so\s+much|all\s+the)\s+time\s+apart|years|months)\b/i,
];
/** Emotion words: a block may use one only when the user's words support it. */
const EMOTION_TOKENS = new Set(
  "joy joyful joyous joyfully happiness happy happier happily glad gladly delight delighted delightful tears tearful teary tearing emotional emotions emotion nostalgia nostalgic longing longed missed relief relieved grateful gratitude thankful overjoyed excited excitement excitedly proud pride love loved loving lovingly adore adored thrilled bittersweet heartfelt warmth contentment elated ecstatic giddy homesick wistful sentimental".split(" "),
);
const FIRST_PERSON = new Set("i we us our ours my me mine myself ourselves".split(" "));

function tokenSet(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const tok of tokenize(t)) out.add(tok.norm);
  return out;
}

/** Does any source text share a word of `words`, or match one of `patterns`? */
function supported(sources: ReadonlySet<string>, sourceText: string, words: readonly string[], patterns: readonly RegExp[] = []): boolean {
  return words.some((w) => sources.has(w)) || patterns.some((re) => re.test(sourceText));
}

/** Photo-shoot commentary in a text (English): the category, or null. Exported for the plan checks. */
export function photoCommentaryIssue(text: string): string | null {
  for (const t of tokenize(text)) if (COMMENTARY_TOKENS.has(t.norm)) return "camera_subject";
  return COMMENTARY_PATTERNS.some((re) => re.test(text)) ? "camera_subject" : null;
}

/** Pose / gesture descriptions: what the photo already shows, told like a photo shoot (v3). */
const POSE_PATTERNS: readonly RegExp[] = [
  /\bthumbs?[\s-]up\b/i,
  /\b(?:one|a|his|her|their|my|the)\s+(?:foot|leg|knee)\s+(?:up|raised|propped|bent|bends|bending|lifted|against|back|comes\s+up|resting\s+on)\b/i,
  /\b(?:foot|leg)\s+(?:raised|propped\s+up)\b/i,
  /\b(?:hand|hands|fingers)\s+(?:over|across|to|covering|rises\s+to|lifts\s+to|lifted\s+to)\s+(?:the\s+|his\s+|her\s+|their\s+|my\s+)?(?:mouth|face|chin)\b/i,
  /\b(?:head|chin|cheek)\s+(?:rests?|resting|propped)\s+on\s+(?:one|a|the|his|her|their|my)?\s*hand\b/i,
  /\bcross(?:es|ed|ing)?\s+(?:both\s+|his\s+|her\s+|their\s+|my\s+)?legs\b/i,
  /\bstrik(?:e|es|ing)\s+a\s+pose\b|\bstruck\s+a\s+pose\b/i,
];

/** A pose / gesture description (English), or null. Exported for the tests. */
export function poseIssue(text: string): string | null {
  return POSE_PATTERNS.some((re) => re.test(text)) ? "pose" : null;
}

/** Generic inspirational language (English): the pattern id, or null. */
export function genericLanguageIssue(text: string): string | null {
  return GENERIC_PATTERNS.find((p) => p.re.test(text))?.id ?? null;
}

/** Plan texts (titles / arcs) never get the soft allowance: generic or soft-generic is rejected. */
export function planGenericIssue(text: string): string | null {
  return genericLanguageIssue(text) ?? SOFT_GENERIC.find((p) => p.re.test(text))?.id ?? null;
}

/** All memory-narrative findings of one block. English only (Arabic → []). */
export function memoryLint(text: string, lang: "en" | "ar", ctx: MemoryLintContext): MemoryLintFinding[] {
  if (lang !== "en") return [];
  const found: MemoryLintFinding[] = [];
  const add = (code: MemoryLintCode, detail: string) => {
    if (!found.some((f) => f.code === code && f.detail === detail)) found.push({ code, detail });
  };
  if (photoCommentaryIssue(text)) add("photo_commentary", "camera_subject");
  if (poseIssue(text)) add("photo_commentary", "pose");
  const generic = genericLanguageIssue(text);
  if (generic) add("generic_language", "inspirational");
  if (softGenericIssue(text, ctx)) add("generic_language", "inspirational");

  const factTokens = tokenSet(ctx.citedFactTexts);
  const factText = ctx.citedFactTexts.join(" . ");
  const evidenceTokens = tokenSet(ctx.evidenceTexts ?? []);
  const toks = tokenize(text);
  const norms = toks.map((t) => t.norm);

  // what was said: a fact must say so (talking / laughing may also be visible in a cited photo)
  const conversationWords = norms.filter((n) => CONVERSATION_TOKENS.has(n));
  if (conversationWords.some((w) => !factTokens.has(w) && !evidenceTokens.has(w))) add("unsupported_claim", "conversation");
  if (CONVERSATION_PATTERNS.some((re) => re.test(text)) && !supported(factTokens, factText, ["catch", "caught", "talk", "talked", "stories", "news"], CONVERSATION_PATTERNS)) add("unsupported_claim", "conversation");
  // why / how long people were apart
  for (const re of SEPARATION_PATTERNS) if (re.test(text) && !re.test(factText)) add("unsupported_claim", "separation");
  // emotions: only from the user's words
  const allowed = ctx.mode === "personal" && ctx.citedFactTexts.length > 0 ? (ctx.allowedEmotions ?? new Set<string>()) : new Set<string>();
  for (const n of norms) {
    if (!EMOTION_TOKENS.has(n)) continue;
    if (factTokens.has(n) || allowed.has(n)) continue;
    add("claimed_emotion", "emotion");
    break;
  }
  // third-person book: no narrator
  if (ctx.narrator === "third" && toks.some((t) => FIRST_PERSON.has(t.norm) && (t.norm !== "us" || !/^US$/.test(t.raw)))) add("wrong_voice", "first_person");
  return found;
}

/** Emotion words of an emotional-direction line (normalised), for MemoryLintContext.allowedEmotions. */
export function emotionWordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    const n = normalizeToken(t.raw);
    if (EMOTION_TOKENS.has(n)) out.add(n);
  }
  return out;
}

export const isEmotionWord = (norm: string) => EMOTION_TOKENS.has(norm);
