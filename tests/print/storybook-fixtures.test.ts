// Task 10 (requirements 12–14): representative storybooks of 10, 20, 40 and 60 photos, plus books with
// missing metadata, duplicates and low-resolution photos, through the real pipeline modules with NO
// DB, NO network and NO live AI:
//   organise (clusterPhotosIntoMoments: provisional quality, duplicate groups, moments)
//   → plan (planStory) → write (writeStory) — the model answers come from the replay synthesisers
//   → compose (composeStorybookPages, dry run) — AI page intent from the replay synthesiser, and the
//     rule fallback (AI off)
//   → print readiness (validatePrintReadiness, digital A5 spec)
//   → the print route's markup (<PrintDocument>, what /print/[bookId] renders for Chromium)
// and that user edits (page text, crop, photo swap, title) survive into the exported doc / print.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/books", () => ({ getMyBook: vi.fn(async () => null), saveDocIfRev: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("@/lib/db/photo-analyses", () => ({ getTodayPhotoAnalysisSpendUsd: vi.fn(async () => 0), dubaiDayStart: () => "" }));
vi.mock("@/lib/db/photo-organize", () => ({ listPhotosForOrganize: vi.fn(), listVision: vi.fn(), listMoments: vi.fn(), listDuplicateGroups: vi.fn(), listQuality: vi.fn(), saveQuality: vi.fn(), saveQualities: vi.fn(), listImageHashes: vi.fn(), replaceDuplicateGroups: vi.fn(), replaceMoments: vi.fn() }));
vi.mock("@/lib/db/story-ai-calls", () => ({ countStoryRuns: vi.fn(), getTodayStorySpendUsd: vi.fn(async () => 0), recordStoryCall: vi.fn(), storyUsageAvailable: vi.fn(async () => false) }));
vi.mock("@/lib/db/storybooks", () => ({ appendStorybookVersion: vi.fn(), getCurrentStorybook: vi.fn(), getMemoryContext: vi.fn() }));
vi.mock("@/lib/ai/budget", () => ({ checkDailyAiBudget: vi.fn(async () => ({ allowed: true, reason: "no_budget" })) }));

import React from "react";
import { PrintDocument } from "@/components/print/PrintDocument";
import { composeStorybookPages, type ComposeBook, type ComposeDeps } from "@/lib/ai/story/compose";
import { storyComposeReplaySynth } from "@/lib/ai/story/compose-intent";
import { planStory, writeStory } from "@/lib/ai/story/service";
import type { AgentRequest, AgentResponse, AgentTransport } from "@/lib/ai/transport";
import { serializeDoc } from "@/lib/book/doc-version";
import { replacePhoto, setCover, setCrop, setPageText } from "@/lib/book/edit-ops";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import type { OrganizePhotoRow, StoredMoment } from "@/lib/db/photo-organize";
import { getLayout } from "@/lib/layouts";
import { printPhotoIds, printRenderPhotos } from "@/lib/pdf/print-doc";
import { clusterPhotosIntoMoments, type OrganizeDeps } from "@/lib/photos/organize";
import { validatePrintReadiness } from "@/lib/print/readiness";
import { GENERIC_A5_DIGITAL } from "@/lib/print/specs";
import type { Storybook } from "@/lib/storybook/types";
import type { Json } from "@/lib/supabase/database.types";
import { BOOK, USER, book as storyBook, photoRows, visionRows, world } from "../ai/story-fixtures";

type Variant = "base" | "missing_meta" | "duplicates" | "low_res";
type Case = { photos: number; variant: Variant; paid: boolean; format: "A5_PORTRAIT" | "A5_LANDSCAPE"; style: "classic" | "modern" | "magazine" | "editorial" | "scrapbook" | "geometric" };

function rowsFor(c: Case): { rows: OrganizePhotoRow[]; hashes: Map<string, string> } {
  const rows = photoRows(c.photos).map((r, i) => {
    if (c.variant === "missing_meta") return { ...r, taken_at: null, date_source: null, lat: null, lng: null, place: null };
    if (c.variant === "low_res" && i % 3 === 0) return { ...r, width: 640, height: 480 };
    return r;
  });
  const hashes = new Map<string, string>();
  if (c.variant === "duplicates") {
    // every 4th photo is a byte-identical copy of the one before it (same AI-copy hash + fingerprint)
    rows.forEach((r, i) => {
      hashes.set(r.id, `h${i % 4 === 3 ? i - 1 : i}`.padEnd(64, "0"));
      if (i % 4 === 3) rows[i] = { ...r, fingerprint: rows[i - 1]!.fingerprint, taken_at: rows[i - 1]!.taken_at };
    });
  }
  return { rows, hashes };
}

async function organise(rows: OrganizePhotoRow[], hashes: Map<string, string>) {
  const deps: OrganizeDeps = {
    ownerOf: async () => USER,
    listPhotos: async () => rows,
    listQuality: async () => [],
    listImageHashes: async () => hashes,
    listVision: async () => visionRows(rows),
    listDuplicateGroups: async () => [],
    listMoments: async () => [],
    replaceDuplicateGroups: async () => undefined,
    replaceMoments: async () => undefined,
    maxQualityPerRun: 0,
  };
  return clusterPhotosIntoMoments(BOOK, deps);
}

function composeDeps(c: Case, storybook: Storybook, rows: OrganizePhotoRow[], mode: "live" | "off", current: Json = {}): ComposeDeps {
  const transport: AgentTransport = {
    kind: "live",
    async parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
      const parsed = storyComposeReplaySynth(req.scenarioMeta ?? {}, { scenario: "ok", request: req as AgentRequest<unknown> });
      return { parsed: parsed as T, stopReason: "end_turn", stopCategory: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, model: "claude-opus-5-5", latencyMs: 1 };
    },
  };
  const theBook: ComposeBook = { id: BOOK, title: null, occasion: "travel", caption_lang: "en", is_paid: c.paid, max_pages: c.paid ? 100 : 20, doc: current, doc_rev: 1, format: c.format, design_style: c.style };
  return {
    ownerOf: async () => ({ userId: USER, book: theBook }),
    getCurrent: async () => storybook,
    listPhotos: async () => rows,
    listQuality: async () => [],
    usageAvailable: async () => true,
    usageCounts: async () => ({ plans: 0, writes: 0, chapterRegens: 0, rewrites: 0, composes: 0 }),
    record: async () => undefined,
    budgetExhausted: async () => false,
    overSpendCap: async () => false,
    meter: { record: async () => undefined },
    mode,
    transport,
    config: { model: "claude-opus-5-5", modelFallback: false, timeoutMs: 1000, retries: 0 },
    now: () => 0,
    sleep: async () => {},
    newRunId: () => "11111111-1111-4111-8111-111111111111",
  };
}

async function pipeline(c: Case, mode: "live" | "off" = "live", tweak: (rows: OrganizePhotoRow[]) => OrganizePhotoRow[] = (x) => x) {
  const base = rowsFor(c);
  const rows = tweak(base.rows);
  const hashes = base.hashes;
  const organised = await organise(rows, hashes);
  const w = world({
    rows,
    moments: organised.moments as StoredMoment[],
    theBook: storyBook({ is_paid: c.paid, format: c.format, design_style: c.style }),
    // the organiser's duplicate groups, as the story inputs read them from the DB
    listDuplicateGroups: async () => organised.duplicateGroups,
  });
  const plan = await planStory(BOOK, w.deps);
  const { storybook } = await writeStory(BOOK, plan, {}, w.deps);
  const composed = await composeStorybookPages(BOOK, { dryRun: true }, composeDeps(c, storybook, rows, mode));
  const photos = new Map(rows.map((r) => [r.id, { width: r.width, height: r.height }]));
  return { rows, organised, plan, storybook, doc: composed.doc, report: composed.report, photos, requests: w.requests };
}

function printMarkup(doc: BookDoc, photos: Map<string, { width: number | null; height: number | null }>): string {
  const sheets = ["cover" as const, ...doc.pages.map((_p, i) => i)];
  const dims = printPhotoIds(doc, sheets).map((id) => ({ id, width: photos.get(id)?.width ?? null, height: photos.get(id)?.height ?? null }));
  return renderToStaticMarkup(React.createElement(PrintDocument, { doc, photos: printRenderPhotos(dims), captionLang: "en", sheets }));
}

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function placedPhotoIds(doc: BookDoc): string[] {
  return doc.pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((id): id is string => !!id));
}

/** Chapter order: pages of chapter k never come after pages of chapter k + 1. */
function chapterOrderKept(doc: BookDoc): boolean {
  const order = new Map(doc.chapters.map((ch, i) => [ch.id, i]));
  let last = -1;
  for (const p of doc.pages) {
    if (!p.chapterId || !order.has(p.chapterId)) continue;
    const k = order.get(p.chapterId)!;
    if (k < last) return false;
    last = k;
  }
  return true;
}

const CASES: Case[] = [
  { photos: 10, variant: "base", paid: false, format: "A5_PORTRAIT", style: "classic" },
  { photos: 20, variant: "base", paid: false, format: "A5_LANDSCAPE", style: "magazine" },
  { photos: 40, variant: "base", paid: true, format: "A5_PORTRAIT", style: "editorial" },
  { photos: 60, variant: "base", paid: true, format: "A5_LANDSCAPE", style: "modern" },
  { photos: 24, variant: "missing_meta", paid: true, format: "A5_PORTRAIT", style: "scrapbook" },
  { photos: 24, variant: "duplicates", paid: true, format: "A5_LANDSCAPE", style: "geometric" },
  { photos: 24, variant: "low_res", paid: true, format: "A5_PORTRAIT", style: "magazine" },
];

describe("representative storybooks → print", () => {
  for (const c of CASES) {
    it(`${c.photos} photos (${c.variant}, ${c.style} ${c.format === "A5_PORTRAIT" ? "portrait" : "landscape"}, ${c.paid ? "paid" : "free"}): organise → plan → write → compose → readiness → print markup`, async () => {
      const r = await pipeline(c);
      const doc = r.doc;
      // no live AI: every model call went to the scripted replay transport
      expect(r.requests.length).toBeGreaterThan(0);
      // the book: valid, within the page limit, chapters in story order, no photo twice
      expect(parseBookDoc(JSON.parse(JSON.stringify(serializeDoc(doc)))).ok).toBe(true);
      expect(doc.format).toBe(c.format);
      expect(doc.pages.length).toBeGreaterThan(0);
      expect(doc.pages.length).toBeLessThanOrEqual(c.paid ? 100 : 20);
      expect(chapterOrderKept(doc)).toBe(true);
      const placed = placedPhotoIds(doc);
      expect(new Set(placed).size).toBe(placed.length);

      // print readiness against the digital spec: no errors (warnings allowed, e.g. low resolution)
      const ready = validatePrintReadiness(doc, GENERIC_A5_DIGITAL, { photos: r.photos, lang: "en", maxPages: c.paid ? 100 : 20 });
      expect(ready.errors, JSON.stringify(ready.issues.filter((i) => i.severity === "error"))).toBe(0);
      expect(ready.sheets).toBe(doc.pages.length + 1);
      for (const i of ready.issues) expect(i.code).not.toBe("blank_page");

      // the print route's markup: one sheet per page + the cover, every story text present
      const html = printMarkup(doc, r.photos);
      expect(html.match(/data-print-sheet="true"/g)?.length).toBe(doc.pages.length + 1);
      const text = decode(html);
      for (const p of doc.pages) for (const t of p.texts ?? []) expect(text).toContain(t.text.slice(0, 40));
      expect(html).not.toMatch(/supabase|storage\/v1|token=/);

      if (c.variant === "duplicates") {
        expect(r.organised.duplicateGroups.length).toBeGreaterThan(0);
        // a copy and its original are never both printed
        for (const g of r.organised.duplicateGroups) expect(g.photoIds.filter((id) => placed.includes(id)).length).toBeLessThanOrEqual(1);
      }
      if (c.variant === "low_res") {
        // low-res photos are flagged when they land in a big slot, never blocking
        for (const i of ready.issues.filter((x) => x.code === "low_dpi")) expect(i.severity).toBe("warning");
      }
      if (c.variant === "missing_meta") {
        // no invented dates or places in the story when the photos carry none
        const words = r.storybook.pages.flatMap((p) => p.blocks.map((b) => b.text)).join(" ");
        expect(words).not.toMatch(/Abu Dhabi|2026/);
      }
    });
  }

  it("rule fallback (AI page intent off) also composes a ready book", async () => {
    const r = await pipeline({ photos: 20, variant: "base", paid: false, format: "A5_PORTRAIT", style: "modern" }, "off");
    expect(r.report.ai.status).not.toBe("used");
    expect(validatePrintReadiness(r.doc, GENERIC_A5_DIGITAL, { photos: r.photos, maxPages: 20 }).errors).toBe(0);
  });
});

describe("user edits survive export", () => {
  it("edited page text, crop, a swapped photo and the title are in the export snapshot and the print markup", async () => {
    const c: Case = { photos: 20, variant: "base", paid: true, format: "A5_PORTRAIT", style: "editorial" };
    // the last photo was left out at review (dropped) — the user swaps it in by hand later
    const r = await pipeline(c, "live", (rows) => rows.map((x, i) => (i === rows.length - 1 ? { ...x, status: "dropped" } : x)));
    let doc = r.doc;
    const textPage = doc.pages.findIndex((p) => (p.texts ?? []).length > 0);
    const panel = doc.pages[textPage]!.texts![0]!.panel;
    const edited = "Sara insisted on one more swim before the lanterns came on.";
    doc = setPageText(doc, textPage, panel, edited);
    const photoPage = doc.pages.findIndex((p) => getLayout(p.layout)?.role !== "spread" && p.slots.some((s) => s.photoId));
    const slot = doc.pages[photoPage]!.slots.findIndex((s) => s.photoId);
    const unused = r.rows.map((x) => x.id).find((id) => !placedPhotoIds(doc).includes(id) && id !== doc.cover.photoId)!;
    expect(unused).toBeTruthy();
    const before = printMarkup(doc, r.photos);
    doc = replacePhoto(doc, photoPage, slot, unused);
    doc = setCrop(doc, photoPage, slot, { x: 0.2, y: 0.8, zoom: 1.6 });
    doc = setCover(doc, { title: "Ten days by the water" });

    // what POST /pdf stores in the export row = the saved doc verbatim (no AI photo background here)
    const snapshot = parseBookDoc(JSON.parse(JSON.stringify(serializeDoc(doc))));
    expect(snapshot.ok).toBe(true);
    const saved = (snapshot as { ok: true; doc: BookDoc }).doc;
    expect(saved.pages[textPage]!.texts!.find((t) => t.panel === panel)).toMatchObject({ text: edited, source: "user" });
    expect(saved.pages[photoPage]!.slots[slot]).toMatchObject({ photoId: unused, crop: { x: 0.2, y: 0.8, zoom: 1.6 } });

    const after = decode(printMarkup(saved, r.photos));
    expect(after).toContain(edited);
    expect(after).toContain("Ten days by the water");
    expect(after).toContain(`print-assets.invalid/${unused}`);
    expect(after).not.toBe(decode(before));
    expect(validatePrintReadiness(saved, GENERIC_A5_DIGITAL, { photos: r.photos, maxPages: 100 }).errors).toBe(0);
  });

  it("re-composing the story (Regenerate pages) keeps the user's own page text", async () => {
    const c: Case = { photos: 20, variant: "base", paid: true, format: "A5_PORTRAIT", style: "magazine" };
    const r = await pipeline(c);
    const textPage = r.doc.pages.findIndex((p) => (p.texts ?? []).length > 0);
    const panel = r.doc.pages[textPage]!.texts![0]!.panel;
    const edited = "We kept the shells in a jar on the windowsill.";
    const mine = setPageText(r.doc, textPage, panel, edited);
    const again = await composeStorybookPages(BOOK, { dryRun: true }, composeDeps(c, r.storybook, r.rows, "off", serializeDoc(mine) as unknown as Json));
    const texts = again.doc.pages.flatMap((p) => p.texts ?? []);
    expect(texts.find((t) => t.text === edited)?.source).toBe("user");
    expect(decode(printMarkup(again.doc, r.photos))).toContain(edited);
  });
});
