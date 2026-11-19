// Named fixture states for /dev-editor screenshots (M22 T7): `?state=<name>` on top of the other
// query params. Dev-only route (404 in production). Pure: no React, no server modules.
// Imported by the dev page (a server component) only, never by DevEditorClient: a client import of
// @/lib/editor/ai-summary (or the tool registry) from outside the editor's module graph stops webpack
// concatenating it into the editor's first-load chunk (M22 size trim).

import type { BookFormat } from "@/lib/book/types";
import { m30EditorDoc, type M30SheetStyle } from "@/lib/book/dev-m30";
import { devSamplePhotos, type DevSample } from "@/lib/book/dev-sample";
import {
  devEditorData,
  withDevBackgroundPhotos,
  withDevLightVeilPage,
  withDevSampleBook,
  type DevAiMode,
  type DevSaveMode,
} from "@/lib/editor/dev-fixture";
import { withDevPagesData } from "@/lib/editor/dev-pages-fixture";
import { aiSummary, type AiSummary } from "@/lib/editor/ai-summary";
import type { EditorShellData } from "@/lib/editor/types";
import { composeStoryDoc, mergeComposition, userOwnedElements } from "@/lib/storybook/compose";
import { devStoryRenderPhotos, storyFixture } from "@/lib/storybook/compose/dev-fixture";
import type { StoryRunView } from "@/lib/storybook/run/progress";

const DEV_EDITOR_STATES = ["readOnly", "conflict", "makeWithAi", "aiSummary", "linkExpired", "paid"] as const;

export type DevEditorState = (typeof DEV_EDITOR_STATES)[number];

export function parseDevEditorState(v: unknown): DevEditorState | null {
  // Strings only: String(["paid"]) is "paid", which would hand an array back as a state.
  return typeof v === "string" && (DEV_EDITOR_STATES as readonly string[]).includes(v) ? (v as DevEditorState) : null;
}

/** Save mode a state needs (readOnly → no saving; conflict → the stub save answers 409), else the given one. */
export function devStateSaveMode(state: DevEditorState | null, mode: DevSaveMode): DevSaveMode {
  if (state === "readOnly") return "readonly";
  if (state === "conflict") return "conflict";
  return mode;
}

/**
 * Applies a state to fixture data:
 * - makeWithAi: rule album that never had an AI build → the persistent "Make it with AI" chip;
 * - aiSummary: the "AI kept X of Y · See N left out" chip (fixture has 2 AI-dropped photos);
 * - linkExpired: published free book whose 30-day link has run out → Share shows "Link expired";
 * - paid: paid book (100 pages, PDF instead of Upgrade).
 * readOnly / conflict only change the save mode (devStateSaveMode); conflict shows its banner after
 * the first save, which DevEditorClient triggers with one harmless edit.
 */
export function withDevEditorState(data: EditorShellData, state: DevEditorState | null): { data: EditorShellData; summary: AiSummary | null } {
  switch (state) {
    case "makeWithAi":
      return { data: { ...data, aiMode: "replay", aiPath: { makeWithAi: true, redoWithAi: false } }, summary: null };
    case "aiSummary":
      return { data, summary: aiSummary("ai", data.photos) };
    case "linkExpired":
      return { data: { ...data, publishedRev: data.docRev, freeLink: { kind: "expired" } }, summary: null };
    case "paid":
      return { data: { ...data, book: { ...data.book, isPaid: true, maxPages: 100 } }, summary: null };
    default:
      return { data, summary: null };
  }
}

/** `?style=magazine|editorial` (M30 T13). */
export function parseDevM30Style(v: unknown): M30SheetStyle | null {
  return v === "magazine" || v === "editorial" ? v : null;
}

/**
 * `?style=magazine|editorial` (+ `&format=landscape`, `&ar=1` Arabic, `&desc=0` no descriptions):
 * the editor on a small M30 book built from the real catalogue (m30EditorDoc) — travel book, the
 * sp* placeholder photos as kept photos, d0 on the cover.
 */
export function withDevM30Book(
  data: EditorShellData,
  style: M30SheetStyle,
  format: BookFormat,
  opts: { arabic: boolean; descriptions: boolean },
): EditorShellData {
  const doc = m30EditorDoc(style, format, opts);
  return {
    ...data,
    book: { ...data.book, title: doc.cover.title, occasion: "travel", tone: "fun", captionLang: opts.arabic ? "ar" : "en" },
    doc,
    photos: Object.entries(devSamplePhotos()).map(([id, p]) => ({
      id,
      status: "kept" as const,
      userOverride: false,
      width: p?.width ?? null,
      height: p?.height ?? null,
      webUrl: p?.url ?? null,
      thumbUrl: p?.url ?? null,
    })),
  };
}

export type DevEditorFixtureOptions = {
  mode: DevSaveMode;
  ai: DevAiMode;
  pages: number | null;
  published: boolean;
  paid: boolean;
  format: BookFormat;
  /** `?bg=1`: uuid background photos (M10a A8). */
  bg: boolean;
  /** `?bg=1&bgveil=light50`: page 1 has a photo background under a white 50 % veil (M10b A4). */
  lightVeil: boolean;
  /** `?sample=…` modern sample book with spreads (M10b A15 / M10c). */
  sample: DevSample | null;
  state: DevEditorState | null;
  /** `?style=magazine|editorial`: an M30 book (wins over `sample` and `pages`). */
  m30?: { style: M30SheetStyle; arabic: boolean; descriptions: boolean } | null;
  /** `?story=1` (Task 8): a composed storybook; value = the outcome line to show (or null). */
  story?: { outcome: "partial" | "none" | null } | null;
};

/**
 * `?story=1` (Task 8): the editor on a composed storybook (Task 7 fixture: 24 photos, 3 chapters, AI
 * texts with blockRefs) — the Story tool and its sheet. `&outcome=partial|none` adds a finished job
 * whose outcome line shows under the band.
 */
export function withDevStoryBook(data: EditorShellData, outcome: "partial" | "none" | null): EditorShellData {
  const design = { format: "A5_PORTRAIT" as const, designStyle: "classic" as const };
  const f = storyFixture({ photos: 24, lang: "en", design, lowRes: [5] });
  const fresh = composeStoryDoc({ storybook: f.storybook, photos: f.photos, design, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20 }).doc;
  const owned = userOwnedElements(null, {});
  // as stored by composeStorybookPages: with doc.meta.story (the Story tool keys on it)
  const doc = owned.ok ? mergeComposition({ fresh, current: null, owned: owned.owned, design, storybookVersion: 1 }) : fresh;
  const urls = devStoryRenderPhotos(f.photos);
  const latest: StoryRunView | null = outcome
    ? {
        runId: "00000000-0000-4000-8000-000000000999",
        state: "done",
        done: true,
        aiStatus: outcome === "none" ? null : "partial",
        errorCode: null,
        mode: outcome === "none" ? "rule" : "replay",
        progress: {
          v: 1,
          kind: "storybook",
          phase: "done",
          stages: { discovering: { status: "done", done: 24, total: 24 }, organizing: { status: "done", moments: 6, chapters: 3 }, writing: { status: "done", done: 3, chapters: 3 }, designing: { status: "done", pages: doc.pages.length } },
          outcome: outcome === "none" ? { ai: "none", notes: ["ai_off"], warnings: 0 } : { ai: "partial", notes: ["chapter_failed"], warnings: 1 },
        },
      }
    : null;
  return {
    ...data,
    book: { ...data.book, title: doc.cover.title, occasion: "travel", captionLang: "en" },
    doc,
    aiPath: { makeWithAi: false, redoWithAi: false },
    ...(latest ? { story: { latest } } : {}),
    photos: f.photos.map((p) => ({ id: p.id, status: "kept" as const, userOverride: false, width: p.width, height: p.height, webUrl: urls[p.id]?.url ?? null, thumbUrl: urls[p.id]?.url ?? null })),
  };
}

/** The dev editor's fixture data + AI summary for the query options (built on the server page). */
export function devEditorFixture(o: DevEditorFixtureOptions): { data: EditorShellData; summary: AiSummary | null } {
  if (o.story) return withDevEditorState(withDevStoryBook(devEditorData(o.mode, o.ai), o.story.outcome), o.state);
  if (o.m30) {
    const book = withDevM30Book(devEditorData(o.mode, o.ai), o.m30.style, o.format, o.m30);
    const d = o.paid ? { ...book, book: { ...book.book, isPaid: true, maxPages: 100 } } : book;
    return withDevEditorState(o.published ? { ...d, publishedRev: d.docRev } : d, o.state);
  }
  const raw = o.sample ? withDevSampleBook(devEditorData(o.mode, o.ai), o.sample) : withDevPagesData(devEditorData(o.mode, o.ai), o.pages);
  const withBg = o.bg ? withDevBackgroundPhotos(raw) : raw;
  const fixture = o.bg && o.lightVeil ? withDevLightVeilPage(withBg) : withBg;
  const base = o.sample || o.format === fixture.doc.format ? fixture : { ...fixture, doc: { ...fixture.doc, format: o.format } };
  const d = o.paid ? { ...base, book: { ...base.book, isPaid: true, maxPages: 100 } } : base;
  return withDevEditorState(o.published ? { ...d, publishedRev: d.docRev } : d, o.state);
}
