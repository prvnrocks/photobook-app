// Fixture storybooks for the page composer (Task 7): the /dev-story-compose contact sheets, the
// composition goldens and the visual-regression spec. Pure and deterministic — built the way Task 6
// builds a real storybook (buildSkeleton page plan + the replay writer's grounded text), with no
// DB, no AI and no network. Never used by the product.

import { buildSkeleton } from "@/lib/ai/story/skeleton";
import { replayText } from "@/lib/ai/story/replay";
import type { BookDesign } from "@/lib/book/book-design";
import { STORY_BALANCE } from "@/lib/storybook/schemas";
import type { NarrativeKind, Storybook } from "@/lib/storybook/types";
import { aiProvenance } from "@/lib/storybook/versioning";
import type { ComposePhoto } from "./types";

export const FIXTURE_BOOK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const fixturePhotoId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Replay clause counts per block kind (src/lib/ai/story/replay.ts CLAUSES). */
const CLAUSES: Record<NarrativeKind, number> = { intro: 10, paragraph: 9, caption: 3, pull_quote: 3, closing: 10 };

export type StoryFixtureOptions = {
  photos: number;
  lang?: "en" | "ar";
  design?: BookDesign;
  /** Photo numbers (1-based) stored at 800 × 600 px — too small for a full-bleed print. */
  lowRes?: readonly number[];
  maxPages?: number;
  /** Photos per moment (default 4). */
  perMoment?: number;
};

/** Mixed orientations: every 3rd photo portrait, every 7th square, the rest landscape 4:3. */
export function fixturePhotos(count: number, lowRes: readonly number[] = []): ComposePhoto[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const small = lowRes.includes(n);
    const [w, h] = n % 7 === 0 ? [3000, 3000] : n % 3 === 0 ? [3000, 4000] : [4000, 3000];
    return {
      id: fixturePhotoId(n),
      width: small ? Math.round(w / 5) : w,
      height: small ? Math.round(h / 5) : h,
      quality: 50 + ((n * 37) % 45),
      focus: n % 5 === 0 ? { x: 0.42, y: 0.38 } : null,
    };
  });
}

const DATE_LABELS = { en: ["12 Oct 2026", "13 Oct 2026", "14 Oct 2026", "15 Oct 2026"], ar: ["١٢ أكتوبر ٢٠٢٦", "١٣ أكتوبر ٢٠٢٦", "١٤ أكتوبر ٢٠٢٦", "١٥ أكتوبر ٢٠٢٦"] } as const;
const CHAPTER_TITLES = {
  en: ["Arrival by the sea", "Lanterns in the old town", "A day in the dunes", "Long lunches", "Rooftops at dusk", "The way home"],
  ar: ["الوصول إلى البحر", "فوانيس المدينة القديمة", "يوم في الكثبان", "غداء طويل", "الأسطح عند الغروب", "طريق العودة"],
} as const;
const TITLES = { en: "Ten days by the water", ar: "عشرة أيام قرب الماء" } as const;

/** A storybook for `photos` photos (+ the photos with sizes), as Task 6 would store it. */
export function storyFixture(opts: StoryFixtureOptions): { storybook: Storybook; photos: ComposePhoto[] } {
  const lang = opts.lang ?? "en";
  const design = opts.design ?? { format: "A5_PORTRAIT", designStyle: "classic" };
  const per = opts.perMoment ?? 4;
  const photos = fixturePhotos(opts.photos, opts.lowRes);
  const moments: { id: string; photoIds: string[] }[] = [];
  for (let i = 0; i * per < photos.length; i++) moments.push({ id: `m${i + 1}`, photoIds: photos.slice(i * per, (i + 1) * per).map((p) => p.id) });
  const chapterCount = Math.max(1, Math.min(6, Math.round(moments.length / 2)));
  const chapters = Array.from({ length: chapterCount }, (_, c) => {
    const own = moments.filter((_, k) => Math.floor((k * chapterCount) / moments.length) === c);
    return { id: `c${c + 1}`, momentIds: own.map((m) => m.id), heroPhotoId: own[0]!.photoIds[own[0]!.photoIds.length > 1 ? 1 : 0]!, narrativeMomentIds: own.slice(0, 1).map((m) => m.id) };
  }).filter((c) => c.momentIds.length > 0);
  const skeleton = buildSkeleton({ moments, chapters, closing: photos.length >= 10, maxPages: opts.maxPages ?? 20 });
  const createdAt = "2026-11-18T10:00:00.000Z";
  const storybook: Storybook = {
    v: 1,
    bookId: FIXTURE_BOOK_ID,
    version: 1,
    parentVersion: null,
    origin: "ai",
    generator: { pipeline: "balanced-storybook-1", model: null, prompts: { planner: "story-plan-1", writer: "story-write-1" } },
    format: design.format,
    designStyle: design.designStyle,
    lang,
    title: { text: TITLES[lang], provenance: aiProvenance(1) },
    subtitle: null,
    coverPhotoId: photos[0]?.id ?? null,
    contextRev: null,
    target: { photoShare: STORY_BALANCE.photoShare, narrativeShare: STORY_BALANCE.narrativeShare },
    moments: moments.map((m, i) => ({
      id: m.id,
      title: `${CHAPTER_TITLES.en[i % 6]}`,
      dateLabel: DATE_LABELS[lang][Math.min(3, Math.floor(i / 2))]!,
      place: i % 3 === 0 ? (lang === "ar" ? "أبوظبي" : "Abu Dhabi") : null,
      photoIds: m.photoIds,
      heroPhotoId: m.photoIds[m.photoIds.length > 1 ? 1 : 0]!,
      beat: i === 0 ? "opening" : i === moments.length - 1 ? "closing" : "build",
      summary: null,
    })),
    chapters: chapters.map((c, i) => ({ id: c.id, title: { text: CHAPTER_TITLES[lang][i % 6]!, provenance: aiProvenance(1) }, momentIds: c.momentIds, narrativeShare: 0.35 })),
    pages: skeleton.pages.map((p) => ({
      id: p.id,
      kind: p.kind,
      chapterId: p.chapterId,
      momentId: p.momentId,
      photoIds: p.photoIds,
      blocks: p.blocks.map((b) => ({
        id: b.id,
        kind: b.kind,
        text: replayText(lang, Number(b.id.slice(1)), CLAUSES[b.kind]),
        lang,
        provenance: aiProvenance(1),
        groundedIn: p.photoIds.slice(0, 1),
      })),
      narrativeShare: p.narrativeShare,
      layoutId: null,
      userLocked: false,
    })),
    createdAt,
  };
  return { storybook, photos };
}

// ---------------------------------------------------------------------------- contact sheets

const PALETTE = ["#8FB3C9", "#C9A27E", "#9FB88B", "#D6C08A", "#7F8FA6", "#C98B7E", "#86B5AE", "#B7A3C7"] as const;

/**
 * Deterministic placeholder photos (inline SVG, no text, no network) at each photo's own pixel
 * size: a flat colour field with a sun disc at the photo's focus point (or a third of the way in),
 * so crops and orientations read on screenshots exactly the same on every machine.
 */
export function devStoryRenderPhotos(photos: readonly ComposePhoto[]): Record<string, { url: string; width: number | null; height: number | null }> {
  return Object.fromEntries(
    photos.map((p, i) => {
      const w = p.width ?? 1200;
      const h = p.height ?? 900;
      const fx = (p.focus?.x ?? 0.33) * w;
      const fy = (p.focus?.y ?? 0.4) * h;
      const r = Math.round(Math.min(w, h) * 0.14);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${PALETTE[i % PALETTE.length]}"/><rect y="${Math.round(h * 0.68)}" width="${w}" height="${Math.round(h * 0.32)}" fill="#00000022"/><circle cx="${Math.round(fx)}" cy="${Math.round(fy)}" r="${r}" fill="#FFFFFFCC"/></svg>`;
      return [p.id, { url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, width: p.width, height: p.height }];
    }),
  );
}

/** Longest texts the AI writes (WORD_BOUNDS max) — what the overflow probe sets in every panel. */
export function maxText(kind: NarrativeKind, lang: "en" | "ar", seed = 1): string {
  const words = kind === "caption" || kind === "pull_quote" ? 18 : kind === "paragraph" ? 60 : 70;
  const clauses = Math.ceil(words / (lang === "ar" ? 3 : 4));
  const text = replayText(lang, seed, Math.min(12, clauses));
  // replayText caps at 12 clauses: top up with a second block's words to reach the word count
  const extra = clauses > 12 ? ` ${replayText(lang, seed + 50, clauses - 12)}` : "";
  return (text + extra).split(/\s+/).slice(0, words).join(" ").replace(/[,،]?$/, ".");
}
