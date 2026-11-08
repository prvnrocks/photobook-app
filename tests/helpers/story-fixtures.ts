// Shared Storyteller test data: 12 photos (p11 dropped), no GPS, two days + one undated photo.
// Matches tests/fixtures/ai/storyteller/storyteller.ok.json (a hand-written plan in the exact
// AlbumPlan shape; replace with a real recording in M3b).

import { fileURLToPath } from "node:url";
import type { StoryBook, StoryPhoto } from "@/lib/ai/story";
import type { AlbumPlan } from "@/lib/ai/schemas";
import okFixture from "../fixtures/ai/storyteller/storyteller.ok.json";

export const RUN_ID = "7d4f6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/ai/storyteller", import.meta.url));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Spec = [n: number, orient: "portrait" | "landscape" | "square", takenAt: string | null, keep?: boolean];
const SPECS: Spec[] = [
  [1, "portrait", "2026-10-12T16:00:00"],
  [2, "portrait", "2026-10-12T16:05:00"],
  [3, "landscape", "2026-10-12T16:10:00"],
  [4, "portrait", "2026-10-12T16:20:00"],
  [5, "portrait", "2026-10-12T18:00:00"],
  [6, "landscape", "2026-10-12T18:10:00"],
  [7, "landscape", "2026-10-12T18:22:00"],
  [8, "portrait", "2026-10-13T10:00:00"],
  [9, "portrait", "2026-10-13T10:05:00"],
  [10, "square", "2026-10-13T10:30:00"],
  [11, "portrait", "2026-10-13T11:00:00", false],
  [12, "portrait", null],
];

const DIMS = { portrait: [1200, 1600], landscape: [1600, 1200], square: [1500, 1500] } as const;

export function storyPhotos(overrides: Partial<Record<number, Partial<StoryPhoto>>> = {}): StoryPhoto[] {
  return SPECS.map(([n, orient, takenAt, keep = true]) => ({
    id: uuid(n),
    width: DIMS[orient][0],
    height: DIMS[orient][1],
    takenAt,
    place: null,
    keep,
    analysis: {
      description: keep ? `Two people smiling near a table, photo number ${n}` : "A phone screenshot",
      scene: keep ? "group" : "screenshot",
      mood: "joyful",
      quality: keep ? 8 : 2,
      coverWorthy: n === 1,
    },
    ...overrides[n],
  }));
}

export function aliasMaps(photos: readonly StoryPhoto[]) {
  const aliasOf = new Map<string, string>();
  const aliasToId = new Map<string, string>();
  photos.forEach((p, i) => {
    aliasOf.set(p.id, `p${i + 1}`);
    aliasToId.set(`p${i + 1}`, p.id);
  });
  return { aliasOf, aliasToId };
}

export function storyBook(over: Partial<StoryBook> = {}): StoryBook {
  return { occasion: "wedding", tone: "romantic", captionLang: "en", title: null, isPaid: false, maxPages: 20, ...over };
}

/** Fresh deep copy of the fixture plan (strict-parsed shape is identical: all text is clean). */
export function fixturePlan(): AlbumPlan {
  return JSON.parse(JSON.stringify(okFixture.parsed)) as AlbumPlan;
}
