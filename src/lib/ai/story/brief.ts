// The StoryBrief (story v3, "Memory Narrative Layer"). Pure: schemas, validation, rule fallback.
//
// Between the photo analysis / moments and the writer sits one structured, validated artifact that
// says what the story is ABOUT and what it may claim:
//   centralTheme          what the book is about, in one line (internal, never printed)
//   occasion              the user's own occasion wording (wizard "What makes this memory
//                         special?") or else the book's occasion — never inferred from photos
//   location              only from the book title, the user's words or photo metadata
//   relationships         ONLY relationships the user wrote ("my brother") — each cites its fact
//   verifiedFacts         short statements, each traced to its sources (user facts / title /
//                         occasion / photo metadata / what the photos show)
//   momentGroups          moments grouped into story beats with why they matter
//   emotionalDirection    from the user's context only; without it: observational and restrained
//   narrativeArc          opening → middle → closing beats the chapters follow
//   unsupportedAssumptions what the story must NOT claim (code defaults + the model's list)
//
// It is produced by the Story Planner call (folded into the outline call: the planner already
// receives exactly the brief's inputs, so a separate call would resend every photo note), is
// re-validated in code like every model output (anything that cannot be traced to a source is
// dropped or replaced by the rule value), stored with the plan and with the storybook version
// (provenance: source, model, prompt version, context revision) and handed to the writer and the
// grounding checks. `ruleBrief` is the deterministic fallback (AI off / refused / invalid).

import { z } from "zod";
import { OCCASION_LABELS } from "@/lib/book/options";
import { BRIEF_BEATS, BRIEF_FACT_SOURCES, BRIEF_LIMITS, STORY_BRIEF_VERSION, StoryBriefSchema, type BriefBeat, type StoryBrief } from "@/lib/storybook/brief";
import { clipText } from "@/lib/text/clip";
import { checkPlanText, relationshipGroupsOf, type PlanTextContext } from "./grounding";
import { isPersonalFact, type StoryFact, type StoryInputs } from "./inputs";
import { emotionWordsOf, memoryLint, type StoryMode } from "./memory-lint";

export { BRIEF_BEATS, BRIEF_FACT_SOURCES, BRIEF_LIMITS, STORY_BRIEF_VERSION, StoryBriefSchema, type BriefBeat, type StoryBrief } from "@/lib/storybook/brief";

/** Emotional direction when the user gave no personal context. */
export const NEUTRAL_DIRECTION = "observational and restrained: what can be seen, no claimed feelings";

/** AI-facing brief (part of the planner's output). Ids are plain strings: validated in code. */
export const StoryBriefAiSchema = z.object({
  centralTheme: z.string().describe(`What this book is about, in one line (at most ${BRIEF_LIMITS.theme} characters).`),
  occasion: z.string().nullable().describe("The occasion in the user's own terms, or null when no FACT gives one."),
  occasionRefs: z.array(z.string()).describe("Fact ids the occasion comes from."),
  location: z.string().nullable().describe("Where it happened, only from a FACT or a photo's place; else null."),
  locationRefs: z.array(z.string()).describe("Fact ids or photo aliases the location comes from."),
  relationships: z.array(z.object({ text: z.string(), factRef: z.string() })).describe("Relationships the user wrote, in their words, each with its fact id. Empty when none."),
  verifiedFacts: z
    .array(z.object({ text: z.string(), source: z.enum(BRIEF_FACT_SOURCES), refs: z.array(z.string()) }))
    .describe("Short statements the book may rely on, each with the fact ids and / or photo aliases it comes from."),
  momentGroups: z
    .array(z.object({ momentIds: z.array(z.string()), beat: z.enum(BRIEF_BEATS), whyItMatters: z.string() }))
    .describe("Consecutive moments grouped into story beats, each with why it matters to this story (not what is visible)."),
  emotionalDirection: z.string().describe("The emotional direction, only from the user's own words; otherwise exactly: observational."),
  emotionalRefs: z.array(z.string()).describe("Fact ids the emotional direction comes from."),
  narrativeArc: z.array(z.object({ beat: z.enum(BRIEF_BEATS), text: z.string() })).describe("2 to 4 beats: opening, middle, closing."),
  unsupportedAssumptions: z.array(z.string()).describe("Things the story must not claim because no source says them."),
});
export type StoryBriefAi = z.infer<typeof StoryBriefAiSchema>;

// ---------------------------------------------------------------------------- helpers

const tidy = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** Clipped at a word boundary (never "iced coffe"). */
const clip = (s: string, max: number) => {
  const t = tidy(s);
  if ([...t].length <= max) return t;
  const cut = clipText(t, max, "");
  const at = cut.lastIndexOf(" ");
  return (at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:–—-]+$/u, "");
};

type Ctx = { inputs: StoryInputs; factById: Map<string, StoryFact>; photoByAlias: Map<string, StoryInputs["photos"][number]>; photoById: Map<string, StoryInputs["photos"][number]> };

function ctxOf(inputs: StoryInputs): Ctx {
  return {
    inputs,
    factById: new Map(inputs.facts.map((f) => [f.id, f])),
    photoByAlias: new Map(inputs.photos.map((p) => [p.alias, p])),
    photoById: new Map(inputs.photos.map((p) => [p.id, p])),
  };
}

/** Grounding context for a brief line: the given facts as trusted, the given photos' metadata + notes. */
function lineCtx(c: Ctx, facts: readonly StoryFact[], photos: readonly StoryInputs["photos"][number][]): PlanTextContext {
  return {
    lang: c.inputs.lang,
    facts: facts.map((f) => ({ kind: f.kind, text: f.text })),
    metadata: photos.flatMap((p) => [p.place, p.dateLabel]).filter((x): x is string => !!x),
    evidence: photos.map((p) => [p.description ?? "", ...p.activities].join(" . ")),
    avoid: c.inputs.avoid,
  };
}

const allPhotosCtx = (c: Ctx, facts: readonly StoryFact[]) => lineCtx(c, facts, c.inputs.photos);

/** A line is usable when the plan-text grounding finds nothing and it claims no unsupported emotion. */
function usable(c: Ctx, text: string, ctx: PlanTextContext, opts: { emotions?: ReadonlySet<string>; factTexts?: readonly string[] } = {}): boolean {
  if (!text) return false;
  if (checkPlanText("brief", "arc", text, ctx).length > 0) return false;
  const lint = memoryLint(text, c.inputs.lang, { citedFactTexts: opts.factTexts ?? ctx.facts.map((f) => f.text), evidenceTexts: ctx.evidence, mode: c.inputs.mode, allowedEmotions: opts.emotions });
  return !lint.some((f) => f.code === "claimed_emotion" || f.code === "unsupported_claim" || f.code === "photo_commentary" || f.code === "generic_language");
}

function splitRefs(c: Ctx, refs: readonly string[]): { facts: StoryFact[]; photos: StoryInputs["photos"][number][] } {
  const facts: StoryFact[] = [];
  const photos: StoryInputs["photos"][number][] = [];
  for (const r of refs) {
    const id = tidy(r);
    const f = c.factById.get(id);
    if (f && !facts.includes(f)) facts.push(f);
    const p = c.photoByAlias.get(id) ?? c.photoById.get(id);
    if (p && !photos.includes(p)) photos.push(p);
  }
  return { facts: facts.slice(0, BRIEF_LIMITS.refs), photos: photos.slice(0, BRIEF_LIMITS.refs) };
}

const personalFacts = (c: Ctx) => c.inputs.facts.filter(isPersonalFact);
const occasionAnswer = (c: Ctx) => c.inputs.facts.find((f) => f.kind === "answer" && f.questionId === "memory.occasion") ?? null;
const occasionFact = (c: Ctx) => c.inputs.facts.find((f) => f.kind === "occasion") ?? null;

function bookOccasion(c: Ctx): StoryBrief["occasion"] {
  const answer = occasionAnswer(c);
  if (answer) return { text: clip(answer.text, BRIEF_LIMITS.occasion) || "not given", source: "user", factRefs: [answer.id] };
  const f = occasionFact(c);
  if (f) return { text: (OCCASION_LABELS as Record<string, string>)[f.text]?.toLowerCase() ?? clip(f.text, BRIEF_LIMITS.occasion), source: "book", factRefs: [f.id] };
  return { text: "not given", source: "none", factRefs: [] };
}

function locationOf(c: Ctx, text: string, refs: readonly string[]): StoryBrief["location"] {
  const t = clip(text, BRIEF_LIMITS.location);
  if (!t) return null;
  const { facts, photos } = splitRefs(c, refs);
  const places = photos.filter((p) => p.place);
  if (facts.length === 0 && places.length === 0) return null;
  // the place must be in the cited sources themselves (a name, not a guess from a photo note)
  const ctx = lineCtx(c, facts, places);
  if (checkPlanText("loc", "arc", t, { ...ctx, evidence: [] }).length > 0) return null;
  const words = t.toLowerCase().split(/\s+/);
  const inSource = [...facts.map((f) => f.text), ...places.map((p) => p.place!)].some((s) => words.every((w) => s.toLowerCase().includes(w.replace(/[^\p{L}\p{N}]/gu, ""))));
  if (!inSource) return null;
  const source = facts.some(isPersonalFact) ? "user" : facts.some((f) => f.kind === "title") ? "title" : places.length ? "metadata" : "user";
  return { text: t, source, factRefs: facts.map((f) => f.id) };
}

/** Code defaults that always apply (internal working notes for the writer; never printed). */
export function defaultAssumptions(inputs: StoryInputs, relationships: number): string[] {
  const out = ["names of anyone the user did not name", "what anyone said, word for word or in summary", "feelings or thoughts the user did not describe", "dates, durations or numbers not in the facts or photo dates"];
  if (inputs.mode === "observational") out.unshift("who the people are to each other", "why this day mattered to anyone");
  else {
    out.push("how long anyone was apart, unless a fact says it", "the reasons behind events or separations");
    if (relationships === 0) out.unshift("who the people are to each other");
  }
  out.push("places or landmarks recognised from the photos");
  return out;
}

// ---------------------------------------------------------------------------- rule brief

function ruleMomentGroups(inputs: StoryInputs): StoryBrief["momentGroups"] {
  const n = inputs.moments.length;
  if (n === 0) return [];
  const why = (beat: BriefBeat) =>
    inputs.mode === "personal"
      ? beat === "opening"
        ? "Where the story begins: the reason for this memory, in the user's words."
        : beat === "closing"
          ? "How the memory comes to rest."
          : "What happened next, in the order it happened."
      : beat === "opening"
        ? "The setting as it first appears."
        : beat === "closing"
          ? "The last scene of the day."
          : "The scene as it continues.";
  if (n === 1) return [{ momentIds: [inputs.moments[0]!.id], beat: "opening", whyItMatters: why("opening") }];
  return inputs.moments.map((m, i) => {
    const beat: BriefBeat = i === 0 ? "opening" : i === n - 1 ? "closing" : "middle";
    return { momentIds: [m.id], beat, whyItMatters: why(beat) };
  });
}

function ruleArc(inputs: StoryInputs): StoryBrief["narrativeArc"] {
  return inputs.mode === "personal"
    ? [
        { beat: "opening", text: "Open with why this memory matters, in the user's own words." },
        { beat: "middle", text: "Carry what happened, in order, one change at a time." },
        { beat: "closing", text: "Close by echoing the user's words, without adding anything new." },
      ]
    : [
        { beat: "opening", text: "Open on the setting as it first appears." },
        { beat: "middle", text: "Follow what changes: light, place, activity." },
        { beat: "closing", text: "Close on a quiet, specific observation." },
      ];
}

function ruleRelationships(c: Ctx): StoryBrief["relationships"] {
  const out: StoryBrief["relationships"] = [];
  for (const f of personalFacts(c)) {
    if (relationshipGroupsOf(f.text).size === 0) continue;
    if (f.kind === "answer" && f.questionId && !/relationship|companions|people|person|graduate/.test(f.questionId)) continue;
    out.push({ text: clip(f.text, BRIEF_LIMITS.relationship), factRef: f.id });
  }
  return out.slice(0, 10);
}

function ruleFacts(c: Ctx): StoryBrief["verifiedFacts"] {
  const out: StoryBrief["verifiedFacts"] = [];
  for (const f of c.inputs.facts) {
    if (f.kind === "occasion") continue;
    out.push({ text: clip(f.kind === "title" ? `Book title: ${f.text}` : f.text, BRIEF_LIMITS.fact), source: isPersonalFact(f) ? "user" : "title", factRefs: [f.id], photoIds: [] });
  }
  const dated = c.inputs.photos.filter((p) => p.dateLabel);
  if (dated.length) out.push({ text: clip(`Photos dated ${dated[0]!.dateLabel}`, BRIEF_LIMITS.fact), source: "metadata", factRefs: [], photoIds: [dated[0]!.id] });
  return out.slice(0, BRIEF_LIMITS.facts);
}

function ruleDirection(c: Ctx): StoryBrief["emotionalDirection"] {
  if (c.inputs.mode !== "personal") return { text: NEUTRAL_DIRECTION, source: "neutral", factRefs: [] };
  const tone = c.inputs.storyTone;
  return { text: tone ? `${tone}, in the user's own words` : "warm and personal, in the user's own words", source: "user", factRefs: [] };
}

function ruleTheme(c: Ctx): string {
  const special = personalFacts(c).find((f) => f.kind === "answer" && f.questionId && /special|moment|about|highlights|proud/.test(f.questionId));
  const title = c.inputs.facts.find((f) => f.kind === "title");
  return clip(special?.text ?? title?.text ?? (c.inputs.lang === "ar" ? "يوم في صور" : "A day in photographs"), BRIEF_LIMITS.theme);
}

/** Deterministic brief from the inputs alone (AI off / refused / invalid). */
export function ruleBrief(inputs: StoryInputs, meta: { promptVersion: string }): StoryBrief {
  const c = ctxOf(inputs);
  const relationships = inputs.mode === "personal" ? ruleRelationships(c) : [];
  return {
    v: STORY_BRIEF_VERSION,
    source: "rule",
    mode: inputs.mode,
    centralTheme: ruleTheme(c),
    occasion: bookOccasion(c),
    location: null,
    relationships,
    verifiedFacts: ruleFacts(c),
    momentGroups: ruleMomentGroups(inputs),
    emotionalDirection: ruleDirection(c),
    narrativeArc: ruleArc(inputs),
    unsupportedAssumptions: defaultAssumptions(inputs, relationships.length).slice(0, BRIEF_LIMITS.assumptions),
    contextRev: inputs.contextRev,
    generator: { model: null, promptVersion: meta.promptVersion },
  };
}

// ---------------------------------------------------------------------------- model brief → validated brief

/**
 * The model's brief, re-validated against the book's sources. Never fails: every field that cannot
 * be traced to a source is dropped or replaced by its rule value. Relationships, personal facts and
 * an emotional direction exist only in personal mode, and only from the user's own facts.
 */
export function acceptBrief(raw: StoryBriefAi, inputs: StoryInputs, meta: { source: "ai" | "rule"; model: string | null; promptVersion: string }): StoryBrief {
  const c = ctxOf(inputs);
  const rule = ruleBrief(inputs, { promptVersion: meta.promptVersion });
  const personal = inputs.mode === "personal";

  // relationships: the user's words, each grounded in its own fact
  const relationships: StoryBrief["relationships"] = [];
  if (personal) {
    for (const r of raw.relationships ?? []) {
      const f = c.factById.get(tidy(r.factRef));
      const text = clip(r.text, BRIEF_LIMITS.relationship);
      if (!f || !isPersonalFact(f) || !text) continue;
      const groups = relationshipGroupsOf(text);
      const factGroups = relationshipGroupsOf(f.text);
      if (groups.size === 0 || [...groups].some((g) => !factGroups.has(g))) continue;
      if (relationships.some((x) => x.factRef === f.id && x.text === text)) continue;
      relationships.push({ text, factRef: f.id });
    }
  }
  const relOut = relationships.length ? relationships.slice(0, 10) : rule.relationships;

  // occasion: the user's own wording wins; else a grounded model wording; else the book's occasion
  let occasion = bookOccasion(c);
  if (occasion.source !== "user") {
    const text = clip(raw.occasion ?? "", BRIEF_LIMITS.occasion);
    const { facts } = splitRefs(c, raw.occasionRefs ?? []);
    if (text && facts.length > 0 && (personal || facts.every((f) => !isPersonalFact(f))) && usable(c, text, lineCtx(c, facts, []))) {
      occasion = { text, source: facts.some(isPersonalFact) ? "user" : "book", factRefs: facts.map((f) => f.id) };
    }
  }

  const location = raw.location ? locationOf(c, raw.location, raw.locationRefs ?? []) : null;

  // verified facts: each one traced to the sources it cites
  const verifiedFacts: StoryBrief["verifiedFacts"] = [];
  for (const v of raw.verifiedFacts ?? []) {
    const text = clip(v.text, BRIEF_LIMITS.fact);
    const { facts, photos } = splitRefs(c, v.refs ?? []);
    if (!text || facts.length + photos.length === 0) continue;
    if (!personal && facts.some(isPersonalFact)) continue;
    if (!usable(c, text, lineCtx(c, facts, photos))) continue;
    const source: StoryBrief["verifiedFacts"][number]["source"] = facts.some(isPersonalFact)
      ? "user"
      : facts.some((f) => f.kind === "title")
        ? "title"
        : facts.some((f) => f.kind === "occasion")
          ? "occasion"
          : v.source === "metadata" && photos.some((p) => p.place || p.dateLabel)
            ? "metadata"
            : "photos";
    if (verifiedFacts.some((x) => x.text.toLowerCase() === text.toLowerCase())) continue;
    verifiedFacts.push({ text, source, factRefs: facts.map((f) => f.id), photoIds: photos.map((p) => p.id) });
    if (verifiedFacts.length >= BRIEF_LIMITS.facts) break;
  }

  // emotional direction: only from the user's words
  let emotionalDirection = rule.emotionalDirection;
  if (personal) {
    const text = clip(raw.emotionalDirection, BRIEF_LIMITS.beat);
    const { facts } = splitRefs(c, raw.emotionalRefs ?? []);
    const userFacts = facts.filter(isPersonalFact);
    if (text && userFacts.length > 0 && checkPlanText("dir", "arc", text, allPhotosCtx(c, userFacts)).length === 0) emotionalDirection = { text, source: "user", factRefs: userFacts.map((f) => f.id) };
  }
  const allowed = emotionalDirection.source === "user" ? emotionWordsOf(emotionalDirection.text) : new Set<string>();
  const userTexts = personalFacts(c).map((f) => f.text);

  // moment groups: consecutive, known moments; why it matters must be grounded
  const momentIdx = new Map(inputs.moments.map((m, i) => [m.id, i]));
  const momentGroups: StoryBrief["momentGroups"] = [];
  let lastIdx = -1;
  for (const g of raw.momentGroups ?? []) {
    const ids = [...new Set((g.momentIds ?? []).map(tidy))].filter((id) => momentIdx.has(id));
    if (ids.length === 0) continue;
    const idx = ids.map((id) => momentIdx.get(id)!);
    if (idx[0]! <= lastIdx || idx.some((x, i) => i > 0 && x !== idx[i - 1]! + 1)) continue;
    const why = clip(g.whyItMatters, BRIEF_LIMITS.why);
    const groupPhotos = inputs.photos.filter((p) => ids.includes(p.momentId));
    if (!usable(c, why, lineCtx(c, inputs.facts, groupPhotos), { emotions: allowed, factTexts: userTexts })) continue;
    momentGroups.push({ momentIds: ids, beat: g.beat, whyItMatters: why });
    lastIdx = idx[idx.length - 1]!;
  }

  // narrative arc: grounded beats in order
  const narrativeArc: StoryBrief["narrativeArc"] = [];
  for (const b of raw.narrativeArc ?? []) {
    const text = clip(b.text, BRIEF_LIMITS.beat);
    if (!usable(c, text, allPhotosCtx(c, inputs.facts), { emotions: allowed, factTexts: userTexts })) continue;
    narrativeArc.push({ beat: b.beat, text });
    if (narrativeArc.length >= BRIEF_LIMITS.beats) break;
  }

  const theme = clip(raw.centralTheme, BRIEF_LIMITS.theme);
  const centralTheme = usable(c, theme, allPhotosCtx(c, inputs.facts), { emotions: allowed, factTexts: userTexts }) ? theme : rule.centralTheme;

  const assumptions = [...defaultAssumptions(inputs, relOut.length)];
  for (const a of raw.unsupportedAssumptions ?? []) {
    const t = clip(a, BRIEF_LIMITS.assumption);
    if (t && !assumptions.some((x) => x.toLowerCase() === t.toLowerCase())) assumptions.push(t);
  }

  return {
    v: STORY_BRIEF_VERSION,
    source: meta.source,
    mode: inputs.mode,
    centralTheme,
    occasion,
    location,
    relationships: relOut,
    verifiedFacts: verifiedFacts.length ? verifiedFacts : rule.verifiedFacts,
    momentGroups: momentGroups.length ? momentGroups : rule.momentGroups,
    emotionalDirection,
    narrativeArc: narrativeArc.length ? narrativeArc : rule.narrativeArc,
    unsupportedAssumptions: assumptions.slice(0, BRIEF_LIMITS.assumptions),
    contextRev: inputs.contextRev,
    generator: { model: meta.model, promptVersion: meta.promptVersion },
  };
}

/** A stored brief back in the model's shape (photo uuids → aliases), so it can be re-validated. */
export function briefToAi(b: StoryBrief, inputs: StoryInputs): StoryBriefAi {
  const alias = new Map(inputs.photos.map((p) => [p.id, p.alias]));
  return {
    centralTheme: b.centralTheme,
    occasion: b.occasion.source === "none" ? null : b.occasion.text,
    occasionRefs: b.occasion.factRefs,
    location: b.location?.text ?? null,
    locationRefs: b.location ? [...b.location.factRefs, ...inputs.photos.filter((p) => p.place && b.location!.text.toLowerCase().includes(p.place.toLowerCase())).slice(0, 1).map((p) => p.alias)] : [],
    relationships: b.relationships.map((r) => ({ text: r.text, factRef: r.factRef })),
    verifiedFacts: b.verifiedFacts.map((v) => ({ text: v.text, source: v.source, refs: [...v.factRefs, ...v.photoIds.map((id) => alias.get(id) ?? id)] })),
    momentGroups: b.momentGroups.map((g) => ({ momentIds: g.momentIds, beat: g.beat, whyItMatters: g.whyItMatters })),
    emotionalDirection: b.emotionalDirection.text,
    emotionalRefs: b.emotionalDirection.factRefs,
    narrativeArc: b.narrativeArc,
    unsupportedAssumptions: b.unsupportedAssumptions,
  };
}

/**
 * A brief that travelled through a client / cursor, checked again against the book as it is now
 * (writeStory trusts no plan): same validation as a fresh model brief; a brief whose mode no longer
 * matches the user's context (they added or removed it) is rebuilt by the rules.
 */
export function revalidateBrief(b: StoryBrief | undefined, inputs: StoryInputs, promptVersion: string): StoryBrief {
  if (!b) return ruleBrief(inputs, { promptVersion });
  const parsed = StoryBriefSchema.safeParse(b);
  if (!parsed.success || parsed.data.mode !== inputs.mode) return ruleBrief(inputs, { promptVersion });
  if (parsed.data.source === "rule") return { ...ruleBrief(inputs, { promptVersion: parsed.data.generator.promptVersion }) };
  return acceptBrief(briefToAi(parsed.data, inputs), inputs, { source: "ai", model: parsed.data.generator.model, promptVersion: parsed.data.generator.promptVersion });
}

/** Emotion words the writer may use in personal mode (from the user-supported direction). */
export function allowedEmotionsOf(b: StoryBrief): Set<string> {
  return b.mode === "personal" && b.emotionalDirection.source === "user" ? emotionWordsOf(b.emotionalDirection.text) : new Set();
}

/** Privacy-safe projection (counts and codes only). */
export const briefLogOutput = (b: StoryBrief) => ({ mode: b.mode, source: b.source, facts: b.verifiedFacts.length, relationships: b.relationships.length, groups: b.momentGroups.length, beats: b.narrativeArc.length, occasion: b.occasion.source, direction: b.emotionalDirection.source });

export type { StoryMode };
