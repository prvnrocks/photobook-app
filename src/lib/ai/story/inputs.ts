// What the Story Planner and the Narrative Writer are given, assembled in code (Task 6). Pure.
//
// Photos get short ALIASES (p1, p2 …), moments m1 …, memory facts f1 …: no uuid, file name or
// storage path ever reaches a prompt. No image is sent either — the text description stored by
// Photo Intelligence (Task 3) is the visual evidence; a photo without one is still planned.

import { createHash } from "node:crypto";
import { OCCASIONS, type CaptionLang, type Occasion } from "@/lib/book/options";
import type { OrganizePhotoRow, StoredMoment } from "@/lib/db/photo-organize";
import type { DuplicateGroup } from "@/lib/photos/duplicates";
import { clusterMoments, dateRangeLabel, type MomentPhoto, type MomentVision } from "@/lib/photos/moments";
import type { StoryTone } from "@/lib/story/questions";
import { PhotoVisionSchema, STORY_LIMITS } from "@/lib/storybook/schemas";
import type { MemoryContext, StoryFactKind, StoryFactRef } from "@/lib/storybook/types";
import { clipText } from "@/lib/text/clip";
import type { GroundingFact, GroundingPhoto } from "./grounding";
import type { StoryMode } from "./memory-lint";

export type StoryPhoto = {
  alias: string;
  id: string;
  momentId: string;
  dateLabel: string | null;
  place: string | null;
  /** Null when the photo has not been analysed. */
  description: string | null;
  scene: string | null;
  objects: string[];
  activities: string[];
  storyRole: string | null;
  atmosphere: string | null;
};
export type StoryMoment = { id: string; photoIds: string[]; label: string; dateLabel: string | null; place: string | null; heroPhotoId: string | null };
export type StoryFact = {
  id: string;
  kind: StoryFactKind;
  text: string;
  hash: string;
  /** The server's question text, for an answer. */
  question?: string;
  /** v3: the stable question id of an answer ("memory.relationship", "travel.companions" …). */
  questionId?: string;
};

export type StoryInputs = {
  photos: StoryPhoto[];
  moments: StoryMoment[];
  facts: StoryFact[];
  avoid: string[];
  lang: CaptionLang;
  occasion: Occasion;
  storyTone: StoryTone | null;
  /** v3: "observational" when there is no personal context — then always told in the third person. */
  narrator: MemoryContext["narrator"];
  contextRev: number | null;
  /**
   * v3 (memory narrative): "personal" when the user told us something about the memory (an answer,
   * a note, a person, a place or a fact); "observational" otherwise — the story then never claims
   * relationships, feelings or a "we", and reads as elegant observation.
   */
  mode: StoryMode;
};

export type StoryBookRow = { title: string | null; occasion: string | null; caption_lang: string };

export function factHash(kind: string, text: string): string {
  return createHash("sha256").update(`${kind}\n${text}`).digest("hex").slice(0, 16);
}

/**
 * The user's memory as a flat list of citable facts. Ids are stable for one book: a fact already
 * in `known` (same kind + text hash) keeps its id, a new one gets the next free number.
 */
export function buildFacts(book: StoryBookRow, context: MemoryContext | null, known: readonly StoryFactRef[] = []): StoryFact[] {
  const raw: { kind: StoryFactKind; text: string; question?: string; questionId?: string }[] = [];
  const add = (kind: StoryFactKind, text: string | null | undefined, question?: string, questionId?: string) => {
    const t = (text ?? "").replace(/\s+/g, " ").trim();
    if (t) raw.push({ kind, text: clipText(t, STORY_LIMITS.noteText), question, questionId });
  };
  add("occasion", book.occasion && (OCCASIONS as readonly string[]).includes(book.occasion) && book.occasion !== "other" ? book.occasion : null);
  add("title", book.title);
  if (context) {
    for (const a of context.answers) add("answer", a.text, a.question, a.questionId);
    add("note", context.note);
    for (const p of context.people) add("person", p.relation ? `${p.name.trim()} — ${p.relation.trim()}` : p.name);
    for (const p of context.places) add("place", p);
    for (const f of context.facts) add("fact", f);
  }
  const byHash = new Map(known.map((k) => [`${k.kind}:${k.hash}`, k.id]));
  const used = new Set(known.map((k) => k.id));
  let next = 1;
  const seen = new Set<string>();
  const out: StoryFact[] = [];
  for (const r of raw) {
    const hash = factHash(r.kind, r.text);
    const key = `${r.kind}:${hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let id = byHash.get(key);
    if (!id) {
      while (used.has(`f${next}`)) next++;
      id = `f${next}`;
      used.add(id);
    }
    out.push({ id, kind: r.kind, text: r.text, hash, ...(r.question ? { question: r.question } : {}), ...(r.questionId ? { questionId: r.questionId } : {}) });
  }
  return out;
}

/** The fact list stored with a version: the current facts, then older ones still cited by a block. */
export function factRefsToStore(facts: readonly StoryFact[], known: readonly StoryFactRef[], cited: ReadonlySet<string>): StoryFactRef[] {
  const out: StoryFactRef[] = facts.map((f) => ({ id: f.id, kind: f.kind, hash: f.hash }));
  const ids = new Set(out.map((f) => f.id));
  for (const k of known) if (!ids.has(k.id) && cited.has(k.id)) out.push(k);
  return out.slice(0, STORY_LIMITS.factsPerBook);
}

function visionOf(raw: unknown) {
  const v = PhotoVisionSchema.safeParse(raw);
  return v.success ? v.data : null;
}

const dateSource = (v: string | null) => (v === "exif" || v === "file" ? v : null);

/** Kept photos: not dropped, and only one member of every duplicate group (the preferred one). */
export function keptPhotos(photos: readonly OrganizePhotoRow[], duplicateGroups: readonly DuplicateGroup[]): OrganizePhotoRow[] {
  const alive = photos.filter((p) => p.status !== "dropped");
  const aliveIds = new Set(alive.map((p) => p.id));
  const skip = new Set<string>();
  for (const g of duplicateGroups) {
    const members = g.photoIds.filter((id) => aliveIds.has(id) && !skip.has(id));
    if (members.length < 2) continue;
    const keep = members.includes(g.preferredPhotoId) ? g.preferredPhotoId : members[0]!;
    for (const id of members) if (id !== keep) skip.add(id);
  }
  return alive.filter((p) => !skip.has(p.id));
}

export function buildStoryInputs(args: {
  book: StoryBookRow;
  photos: readonly OrganizePhotoRow[];
  vision: ReadonlyMap<string, unknown>;
  storedMoments: readonly StoredMoment[];
  duplicateGroups: readonly DuplicateGroup[];
  context: MemoryContext | null;
  knownFacts?: readonly StoryFactRef[];
}): StoryInputs {
  const kept = keptPhotos(args.photos, args.duplicateGroups).slice(0, STORY_LIMITS.photosPerBook);
  const keptIds = new Set(kept.map((p) => p.id));
  const rowById = new Map(kept.map((p) => [p.id, p]));
  const visions = new Map(kept.map((p) => [p.id, visionOf(args.vision.get(p.id))]));

  // stored moments are used when they cover every kept photo exactly once; otherwise the photos
  // are grouped in memory (nothing is stored here)
  type Group = { photoIds: string[]; label: string; dateLabel: string | null; place: string | null; heroPhotoId: string | null };
  const storedGroups: Group[] = args.storedMoments
    .map((m) => ({ photoIds: m.photoIds.filter((id) => keptIds.has(id)), label: m.label, dateLabel: m.dateLabel, place: m.place, heroPhotoId: m.heroPhotoId }))
    .filter((m) => m.photoIds.length > 0);
  const covered = storedGroups.flatMap((m) => m.photoIds);
  let groups: Group[];
  if (kept.length > 0 && covered.length === kept.length && new Set(covered).size === kept.length) groups = storedGroups;
  else {
    const momentPhotos: MomentPhoto[] = kept.map((p) => {
      const v = visions.get(p.id);
      const vision: MomentVision | null = v ? { scene: v.scene, objects: v.objects, activities: v.activities, storyRole: v.storyRole, peopleCount: v.peopleCount } : null;
      return { id: p.id, takenAt: p.taken_at, dateSource: dateSource(p.date_source), lat: p.lat, lng: p.lng, place: p.place, vision, quality: null, qualityFlags: [], keep: true };
    });
    groups = clusterMoments(momentPhotos).moments.map((m) => ({ photoIds: m.photoIds, label: m.label, dateLabel: m.dateLabel, place: m.place, heroPhotoId: m.heroPhotoId }));
  }
  // StorybookSchema allows 100 moments: merge the smallest neighbours beyond that
  while (groups.length > STORY_LIMITS.momentsPerBook) {
    let at = 0;
    for (let i = 1; i + 1 < groups.length; i++) if (groups[i]!.photoIds.length + groups[i + 1]!.photoIds.length < groups[at]!.photoIds.length + groups[at + 1]!.photoIds.length) at = i;
    const a = groups[at]!;
    const b = groups[at + 1]!;
    groups.splice(at, 2, { ...a, photoIds: [...a.photoIds, ...b.photoIds] });
  }

  const clip = (s: string | null, max: number) => (s && s.trim() ? clipText(s.trim().replace(/\s+/g, " "), max) : null);
  const moments: StoryMoment[] = groups.map((g, i) => ({
    id: `m${i + 1}`,
    photoIds: [...g.photoIds],
    label: clip(g.label, STORY_LIMITS.shortText) ?? "Photos",
    dateLabel: clip(g.dateLabel, 40),
    place: clip(g.place, STORY_LIMITS.shortText),
    heroPhotoId: g.heroPhotoId && g.photoIds.includes(g.heroPhotoId) ? g.heroPhotoId : (g.photoIds[0] ?? null),
  }));

  const photos: StoryPhoto[] = [];
  for (const m of moments) {
    for (const id of m.photoIds) {
      const row = rowById.get(id)!;
      const v = visions.get(id) ?? null;
      const t = row.taken_at ? Date.parse(row.taken_at) : NaN;
      photos.push({
        alias: `p${photos.length + 1}`,
        id,
        momentId: m.id,
        dateLabel: Number.isFinite(t) ? dateRangeLabel(t, t) : null,
        place: clip(row.place, STORY_LIMITS.shortText),
        description: v?.description ?? null,
        scene: v?.scene ?? null,
        objects: v ? [...v.objects] : [],
        activities: v ? [...v.activities] : [],
        storyRole: v?.storyRole ?? null,
        atmosphere: v?.atmosphere.label ?? null,
      });
    }
  }

  const c = args.context;
  const mode = storyModeOf(c);
  return {
    photos,
    moments,
    facts: buildFacts(args.book, c, args.knownFacts),
    avoid: c ? [...c.avoid] : [],
    lang: args.book.caption_lang === "ar" ? "ar" : "en",
    occasion: args.book.occasion && (OCCASIONS as readonly string[]).includes(args.book.occasion) ? (args.book.occasion as Occasion) : "other",
    storyTone: c?.storyTone ?? null,
    narrator: mode === "observational" ? "third" : (c?.narrator ?? "third"),
    contextRev: c?.rev ?? null,
    mode,
  };
}

/** v3: personal context = anything the user told us about the memory beyond the title and occasion. */
export function storyModeOf(c: MemoryContext | null): StoryMode {
  if (!c) return "observational";
  const said = c.answers.some((a) => a.text.trim()) || !!c.note?.trim() || c.people.length > 0 || c.places.length > 0 || c.facts.length > 0;
  return said ? "personal" : "observational";
}

/** Facts the user wrote about the memory (not the book title or the occasion they picked). */
export const isPersonalFact = (f: Pick<StoryFact, "kind">) => f.kind === "answer" || f.kind === "note" || f.kind === "person" || f.kind === "place" || f.kind === "fact";

/** Grounding view of one photo. */
export function groundingPhoto(p: StoryPhoto): GroundingPhoto {
  return { place: p.place, dateLabel: p.dateLabel, evidence: [p.description ?? "", ...p.objects, ...p.activities].join(" . "), objects: p.objects };
}
export function groundingFacts(facts: readonly StoryFact[]): Map<string, GroundingFact> {
  return new Map(facts.map((f) => [f.id, { kind: f.kind, text: f.text }]));
}
