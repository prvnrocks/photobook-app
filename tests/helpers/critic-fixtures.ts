// Shared Critic / repair test data: the Storyteller fixture plan → BookDoc, with AI captions on
// every captionable page. Page map (doc.pages index → captionKey):
//   0 m1:0 one-portrait p1 · 1 m1:1 three-mixed · 2 m1:2 two-horizontal · 3 m1:3 one-portrait p5
//   4 m2:0 two-vertical · 5 m2:1 full-page (no caption area) · 6 m2:2 one-portrait p12

import { buildCaptionContext, checkBookCaptions } from "@/lib/ai/caption-check";
import { planToDoc } from "@/lib/ai/plan-to-doc";
import { isCaptionable, pageCaptionKeys } from "@/lib/ai/repair";
import type { BookDoc } from "@/lib/book/types";
import { aliasMaps, fixturePlan, RUN_ID, storyBook, storyPhotos } from "./story-fixtures";

/** Distinct, clean English captions (pass the pre-check). */
export const CLEAN_CAPTIONS: Record<string, string> = {
  "m1:0": "Laughter before the big moment.",
  "m1:1": "Every corner of the room felt warm.",
  "m1:2": "Golden light across the evening sky.",
  "m1:3": "A quiet smile between friends.",
  "m2:0": "Slow mornings and soft voices.",
  "m2:2": "One more look back at it all.",
};

/** 22 words with an invented place + name: fails too_long + unknown_name. */
export const LONG_INVENTED =
  "We walked through Paris with Ahmed and laughed all night long under the bright city lights until morning came softly again";

export function draftDoc(captions: Record<string, string> = CLEAN_CAPTIONS, userKeys: string[] = []): BookDoc {
  const photos = storyPhotos();
  const { aliasToId } = aliasMaps(photos);
  const res = planToDoc(fixturePlan(), { aliasToId, photos, book: storyBook(), runId: RUN_ID, generatorVersion: 2 });
  if (!("doc" in res)) throw new Error(`fixture doc invalid: ${res.issues.join("; ")}`);
  const doc = res.doc;
  const keys = pageCaptionKeys(doc);
  doc.pages.forEach((p, i) => {
    const k = keys[i] as string;
    const text = captions[k];
    if (text && isCaptionable(p)) {
      p.caption = { text, font: "Playfair", align: "center", source: userKeys.includes(k) ? "user" : "ai" };
    }
  });
  return doc;
}

export function precheckOf(doc: BookDoc) {
  const keys = pageCaptionKeys(doc);
  const caps = doc.pages.flatMap((p, i) =>
    p.caption && p.caption.source !== "user" ? [{ key: keys[i] as string, text: p.caption.text }] : [],
  );
  const ctx = buildCaptionContext({ lang: "en", chapters: doc.chapters, dates: storyPhotos().map((p) => p.takenAt) });
  return checkBookCaptions(caps, ctx);
}

/** m1 → batch 0, m2 → batch 1. */
export const batchIndexOf = (m: string) => ({ m1: 0, m2: 1 })[m as "m1" | "m2"] ?? null;
