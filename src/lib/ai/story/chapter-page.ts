// Story v4: the code-side parts of a chapter story page. Pure, deterministic, no I/O.
//
//   pickChapterHero   the ONE hero photo of a chapter — the photo that best shows who the story is
//                     about, from the stored analyses (people count, story role, scene, Curator
//                     quality), never a detail / object close-up when better exists
//   chapterPlace      the place in the subtitle — only from verified sources (the chapter's photo
//                     metadata, else the brief's location, which comes from the user / title /
//                     metadata only); null = no place, the subtitle is just the phrase
//   composeSubtitle / splitSubtitle   "<place> · <phrase>"
//
// Who the story is about (subjectOf): the user named a relationship / people → "people" (≥ 2 when
// the relationship is between people, 1 for a solo trip); a pet named in the user's words →
// "animal"; otherwise the chapter's photos decide (people when most photos show people, else the
// best scene). Nothing here is tuned to one book: the inputs are the user's own facts and the
// photos' analyses.

import type { StoryBrief } from "@/lib/storybook/brief";
import type { StoryFact, StoryInputs, StoryPhoto } from "./inputs";

export const SUBTITLE_SEPARATOR = " · ";
/** Longest place kept in a subtitle (code points); longer metadata places keep their first part. */
const PLACE_MAX = 28;

export type HeroSubject = { kind: "people"; min: number } | { kind: "animal" } | { kind: "scene" };

const SOLO_RE = /\b(?:solo|alone|on my own|by myself|myself)\b/i;
const ANIMAL_RE = /\b(?:dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets|horse|horses|pony|bird|birds|parrot|rabbit|bunny|hamster|camel|camels)\b/i;
/** Relationship words in the user's facts (English; Arabic answers still count as "named someone"). */
const RELATION_RE = /\b(?:brother|sister|sibling|mother|mum|mom|father|dad|parents?|son|daughter|kids?|children|child|baby|husband|wife|partner|fianc[eé]e?|boyfriend|girlfriend|friends?|family|cousins?|grand(?:ma|pa|mother|father|parents?|kids?|children|son|daughter)|aunt|uncle|niece|nephew|couple|bride|groom|team|colleagues?|classmates?|group)\b/i;

const userWords = (facts: readonly StoryFact[]) => facts.filter((f) => f.kind === "answer" || f.kind === "note" || f.kind === "person" || f.kind === "fact").map((f) => f.text);

/** Who the story is about, from the user's own words first, then the chapter's photos. */
export function subjectOf(inputs: Pick<StoryInputs, "facts" | "mode">, photos: readonly StoryPhoto[], brief?: Pick<StoryBrief, "relationships"> | null): HeroSubject {
  const words = userWords(inputs.facts).join(" . ");
  const relationship = inputs.mode === "personal" && ((brief?.relationships.length ?? 0) > 0 || RELATION_RE.test(words) || inputs.facts.some((f) => f.kind === "person" || f.questionId === "memory.relationship"));
  if (inputs.mode === "personal" && ANIMAL_RE.test(words) && !RELATION_RE.test(words.replace(ANIMAL_RE, ""))) return { kind: "animal" };
  if (relationship) return { kind: "people", min: SOLO_RE.test(words) ? 1 : 2 };
  if (inputs.mode === "personal" && SOLO_RE.test(words)) return { kind: "people", min: 1 };
  const known = photos.filter((p) => typeof p.peopleCount === "number");
  const withPeople = known.filter((p) => (p.peopleCount ?? 0) > 0).length;
  if (known.length > 0 && withPeople * 2 >= known.length) return { kind: "people", min: 1 };
  if (photos.some((p) => ANIMAL_RE.test(`${p.description ?? ""} ${p.objects.join(" ")}`))) return { kind: "animal" };
  return { kind: "scene" };
}

const ROLE_SCORE: Record<string, number> = { portrait: 6, emotion: 6, establishing: 4, action: 4, closing: 2, detail: -8 };
const CLOSE_UP_RE = /\bclose[\s-]?up\b|\bmacro\b/i;
const TOGETHER_DESC_RE = /\b(?:two|three|four|both|together|couple|group|family|friends|each other|side by side)\b/i;
const SMILE_RE = /\bsmil\w*|\blaugh\w*|\bgrin\w*/i;

/** Score of one photo as the chapter's hero for `subject` (higher wins). Exported for the tests. */
export function heroScore(p: StoryPhoto, subject: HeroSubject): number {
  const text = `${p.description ?? ""} ${p.activities.join(" ")}`;
  const people = p.peopleCount;
  // Curator quality 1–10 (null = unknown → middle)
  let score = ((p.quality ?? 6) - 5) * 2;
  // a soft / out-of-focus photo is never the hero while a sharp one exists
  if (p.soft) score -= 30;
  score += ROLE_SCORE[p.storyRole ?? ""] ?? 0;
  if (CLOSE_UP_RE.test(text) && (people ?? 0) === 0) score -= 6;
  if (SMILE_RE.test(text) && (people ?? 0) > 0) score += 2;
  switch (subject.kind) {
    case "people":
      // the analysis counts background people too: the note saying two / both / together is the better sign
      if (subject.min >= 2 && TOGETHER_DESC_RE.test(text)) score += 4;
      if (people === null || people === undefined) score += 0;
      else if (people >= subject.min && people <= Math.max(subject.min, 6)) score += 14 + (subject.min >= 2 && people === subject.min ? 2 : 0);
      else if (people > 6) score += 8;
      // no photo of them together: one named person with the setting visible (never an object)
      else if (people > 0) score += 6 + (p.storyRole === "establishing" || p.scene === "landscape" ? 4 : 0);
      else score -= 6;
      break;
    case "animal":
      if (ANIMAL_RE.test(`${text} ${p.objects.join(" ")}`)) score += 14;
      break;
    case "scene":
      if (p.storyRole === "establishing") score += 6;
      if (p.scene && p.scene !== "other") score += 1;
      break;
  }
  return score;
}

/**
 * The chapter's hero: the best-scoring photo for the chapter's subject; ties keep `preferred`
 * (the planner's pick), then the moment hero order, then photo order. Deterministic.
 */
export function pickChapterHero(photos: readonly StoryPhoto[], inputs: Pick<StoryInputs, "facts" | "mode">, opts: { preferred?: string | null; brief?: Pick<StoryBrief, "relationships"> | null } = {}): string | null {
  if (photos.length === 0) return null;
  const subject = subjectOf(inputs, photos, opts.brief);
  let best: { id: string; score: number } | null = null;
  for (const p of photos) {
    const score = heroScore(p, subject) + (p.id === opts.preferred ? 0.5 : 0);
    if (!best || score > best.score + 1e-9) best = { id: p.id, score };
  }
  return best!.id;
}

/** A metadata place shortened for a subtitle ("Al Fahidi, Dubai, United Arab Emirates" → "Al Fahidi"). */
export function shortPlace(place: string | null | undefined): string | null {
  const t = (place ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const first = t.split(/\s*[,،]\s*/u)[0] ?? t;
  const out = [...t].length <= PLACE_MAX && !t.includes(",") && !t.includes("،") ? t : first;
  return out && [...out].length <= PLACE_MAX ? out : null;
}

/**
 * The verified place of a chapter: the most common photo-metadata place of its moments (first
 * wins a tie), else the brief's location (user / title / metadata only), else null.
 */
export function chapterPlace(inputs: Pick<StoryInputs, "moments" | "photos">, momentIds: readonly string[], brief?: Pick<StoryBrief, "location"> | null): string | null {
  const ids = new Set(momentIds);
  const counts = new Map<string, number>();
  for (const p of inputs.photos) {
    if (!ids.has(p.momentId)) continue;
    const s = shortPlace(p.place);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const m of inputs.moments) {
    if (!ids.has(m.id)) continue;
    const s = shortPlace(m.place);
    if (s && !counts.has(s)) counts.set(s, 0.5);
  }
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best ?? shortPlace(brief?.location?.text ?? null);
}

/** Splits a stored subtitle into its place and phrase ("Dubai · A long-awaited day" → ["Dubai", "A long-awaited day"]). */
export function splitSubtitle(text: string): { place: string | null; phrase: string } {
  const at = text.lastIndexOf("·");
  if (at < 0) return { place: null, phrase: text.trim() };
  const place = text.slice(0, at).trim();
  return { place: place || null, phrase: text.slice(at + 1).trim() };
}

/** "<place> · <phrase>" — the writer's phrase without any place it repeated; only the phrase when no place is verified. */
export function composeSubtitle(place: string | null, phrase: string): string {
  let p = splitSubtitle(phrase).phrase.replace(/[.!?]+$/u, "").trim();
  if (place && p.toLowerCase().startsWith(place.toLowerCase())) p = p.slice(place.length).replace(/^[\s,·:–—-]+/u, "").trim();
  if (!p) return place ?? "";
  return place ? `${place}${SUBTITLE_SEPARATOR}${p}` : p;
}
