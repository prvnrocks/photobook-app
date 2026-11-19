// AI page intent for the storybook page composer (Task 7, requirement 5). Pure: prompt, schemas,
// request text, the replay synthesiser and the validation of the model's choices. The call itself
// (runAgentStep, limits, budget, usage log) is in ./compose.ts.
//
// ONE call per composition (never per page). The request carries the book's design, the APPROVED
// template ids of that style + format with what each holds (photo count, slot orientations, text
// capacity in words, narrative share), and the storybook's page list as ALIASES only: page ids
// (pg3), chapter ids (c1), photo aliases (p7) with orientation / quality bucket / role / low-res
// flag, and the word count of each text block. No uuid, no image, no text of the user's story.
// The model returns per page { pageId, family, emphasis, templateId }; a templateId that is not in
// the approved list passed in the request is ignored (the whole entry), and code then validates
// every remaining choice with selectPageTemplate / validatePageLayout and replaces bad ones.

import { z } from "zod";
import type { ReplaySynth } from "@/lib/ai/transport-replay";
import type { BookDesign } from "@/lib/book/book-design";
import { templateCapacity, templatesFor, TEMPLATE_FAMILIES, type TemplateFamily } from "@/lib/layouts/templates";
import { photoShape } from "@/lib/storybook/compose/select";
import { PAGE_EMPHASES, type ComposePhoto, type PageEmphasis, type PageIntentChoice } from "@/lib/storybook/compose/types";
import type { Storybook } from "@/lib/storybook/types";
import { countWords } from "./grounding";

export const STORY_COMPOSE_PROMPT_VERSION = "story-compose-1";
export const STORY_COMPOSE_MAX_TOKENS = 6000;

export const STORY_COMPOSE_SYSTEM_PROMPT = `You are the art director of a photo storybook: about two thirds of the page area is photographs and one third is narrative. The pages, their photos and their texts are already decided. For EVERY page you choose how it should look, from a fixed catalogue of page templates.

For each page return:
- pageId: the page id exactly as given (pg1, pg2 …).
- family: one of chapter_opening, hero, collage, storytelling, closing. Keep the family the page's kind implies: chapter_opener → chapter_opening; photo with 1 photo → hero, with 2–6 photos → collage; mixed or narrative → storytelling; closing → closing.
- emphasis: photo, balanced or text — photo when the page's photos are the strongest of the chapter, text when its text carries the moment, balanced otherwise.
- templateId: ONE id from the APPROVED TEMPLATES list of that family whose photo count equals the page's number of photos and whose text capacity holds the page's texts. Never invent an id; never use an id from another family.

Good books:
- vary the look: never the same template on two pages in a row, and chapter openings that differ from the previous chapter opening;
- give a portrait photo a template whose slot is portrait or any, a landscape photo landscape or any;
- put the photo marked hero in the largest slot's template, and a photo marked low-res never in a full-page template;
- keep the photo / narrative balance near the target: prefer templates whose narrative share is close to the page's planned share.

Code checks every choice and replaces anything that does not fit, so prefer a safe choice over a daring one. Return only the structured result.`;

/** AI-facing (lean) schema. */
export const ComposeIntentAiSchema = z.object({
  pages: z.array(
    z.object({
      pageId: z.string().describe("The page id exactly as given, e.g. pg4."),
      family: z.string().describe("chapter_opening, hero, collage, storytelling or closing."),
      emphasis: z.string().describe("photo, balanced or text."),
      templateId: z.string().describe("One approved template id of that family."),
    }),
  ),
});

/** Strict schema: values are normalised; unknown families / emphases make the entry unusable (dropped later). */
export const ComposeIntentStrictSchema = z.object({
  pages: z
    .array(
      z.object({
        pageId: z.string().transform((v) => v.trim()),
        family: z.string().transform((v) => v.trim().toLowerCase()),
        emphasis: z.string().transform((v) => v.trim().toLowerCase()),
        templateId: z.string().transform((v) => v.trim()),
      }),
    )
    .max(200),
});
export type ComposeIntentOutput = z.infer<typeof ComposeIntentStrictSchema>;

/** Privacy-safe log projection: counts only. */
export const composeLogOutput = (d: ComposeIntentOutput) => ({ pages: d.pages.length, families: [...new Set(d.pages.map((p) => p.family))].length });

/** Page kind → the family the composer uses (the AI may only confirm it). */
export function familyOfKind(kind: string, photos: number): TemplateFamily {
  if (kind === "chapter_opener") return "chapter_opening";
  if (kind === "closing") return "closing";
  if (kind === "mixed" || kind === "narrative") return "storytelling";
  return photos <= 1 ? "hero" : "collage";
}

export type ComposeRequest = {
  userText: string;
  /** Approved ids sent in the request (per family) — the only ids accepted back. */
  approved: ReadonlySet<string>;
  /** scenarioMeta for the replay synthesiser (aliases + candidate ids only). */
  meta: Record<string, unknown>;
  pageIds: readonly string[];
};

const q = (s: string) => JSON.stringify(s);

/** The request text: design, approved catalogue, pages as aliases. Deterministic. */
export function composeUserText(sb: Storybook, photos: readonly ComposePhoto[], design: BookDesign, lang: "en" | "ar"): ComposeRequest {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const alias = new Map<string, string>();
  for (const p of sb.pages) for (const id of p.photoIds) if (byId.has(id) && !alias.has(id)) alias.set(id, `p${alias.size + 1}`);
  const heroes = new Set(sb.moments.map((m) => m.heroPhotoId).filter((x): x is string => !!x));

  const approved = new Set<string>();
  const catalogue: string[] = [];
  for (const family of TEMPLATE_FAMILIES) {
    const list = templatesFor(design.designStyle, design.format, family);
    catalogue.push(`${family}:`);
    for (const t of list) {
      approved.add(t.id);
      const cap = templateCapacity(t.id, 0.92)
        .map((c) => `${c.n < 0 ? "caption" : c.n === 0 ? "text" : "quote"}≤${lang === "ar" ? c.ar : c.en}w`)
        .join(" ");
      catalogue.push(`  ${t.id} photos=${t.photoCount}${t.photoCount ? ` slots=${t.orientations.join("/")}` : ""}${cap ? ` ${cap}` : ""} share=${t.narrativeShare.toFixed(2)}${t.fullBleed ? " full-page" : ""}`);
    }
  }

  const lines: string[] = [];
  const metaPages: { id: string; family: TemplateFamily; candidates: string[] }[] = [];
  for (const p of sb.pages) {
    if (p.kind === "cover") continue;
    const ph = p.photoIds.map((id) => byId.get(id)).filter((x): x is ComposePhoto => !!x);
    const family = familyOfKind(p.kind, ph.length);
    const desc = ph.map((x) => {
      const s = photoShape(x);
      const tags = [s.orient === "portrait" ? "P" : s.orient === "landscape" ? "L" : "S"];
      if (typeof x.quality === "number") tags.push(x.quality >= 70 ? "q-high" : x.quality >= 40 ? "q-mid" : "q-low");
      if (heroes.has(x.id)) tags.push("hero");
      if ((x.width ?? 9999) < 1200 && (x.height ?? 9999) < 1200) tags.push("low-res");
      return `${alias.get(x.id)}(${tags.join(",")})`;
    });
    const texts = p.blocks.map((b) => `${b.kind}:${countWords(b.text)}w`);
    lines.push(`${p.id} kind=${p.kind} chapter=${p.chapterId ?? "-"} share=${p.narrativeShare.toFixed(2)} photos=[${desc.join(" ")}] texts=[${texts.join(" ")}]`);
    const candidates = templatesFor(design.designStyle, design.format, family)
      .filter((t) => t.photoCount === ph.length && !t.fallback)
      .map((t) => t.id);
    metaPages.push({ id: p.id, family, candidates });
  }

  const userText = [
    `DESIGN: style=${design.designStyle} format=${design.format === "A5_PORTRAIT" ? "portrait" : "landscape"} language=${lang}`,
    `BALANCE TARGET: photos ${Math.round(sb.target.photoShare * 100)} % / narrative ${Math.round(sb.target.narrativeShare * 100)} %`,
    "",
    "APPROVED TEMPLATES (id, photo count, slot orientations, text capacity in words, narrative share):",
    ...catalogue,
    "",
    `PAGES (${lines.length}, in book order; photos are aliases with P/L/S orientation):`,
    ...lines,
    "",
    `Return one entry per page id, ${q("pages")}: [{ pageId, family, emphasis, templateId }].`,
  ].join("\n");
  return { userText, approved, meta: { pages: metaPages }, pageIds: metaPages.map((p) => p.id) };
}

/**
 * The model's choices that may be used: a known page id (first entry wins), a known family and
 * emphasis, and a templateId from the approved list of the request. Everything else is ignored.
 */
export function acceptIntents(out: ComposeIntentOutput, req: Pick<ComposeRequest, "approved" | "pageIds">): { intents: Map<string, PageIntentChoice>; ignored: number } {
  const pages = new Set(req.pageIds);
  const intents = new Map<string, PageIntentChoice>();
  let ignored = 0;
  for (const e of out.pages) {
    const family = (TEMPLATE_FAMILIES as readonly string[]).includes(e.family) ? (e.family as TemplateFamily) : null;
    const emphasis = (PAGE_EMPHASES as readonly string[]).includes(e.emphasis) ? (e.emphasis as PageEmphasis) : null;
    if (!pages.has(e.pageId) || intents.has(e.pageId) || !family || !emphasis || !req.approved.has(e.templateId)) {
      ignored++;
      continue;
    }
    intents.set(e.pageId, { pageId: e.pageId, family, emphasis, templateId: e.templateId });
  }
  return { intents, ignored };
}

/** Replay (AI_MODE=replay): a valid, varied choice per page from scenarioMeta's candidates. */
export const storyComposeReplaySynth: ReplaySynth = (meta, ctx) => {
  if (ctx.scenario === "invalid") return { pages: "not a list" };
  const pages = Array.isArray(meta.pages) ? (meta.pages as { id?: unknown; family?: unknown; candidates?: unknown }[]) : [];
  return {
    pages: pages.map((p, i) => {
      const candidates = Array.isArray(p.candidates) ? p.candidates.filter((x): x is string => typeof x === "string") : [];
      return { pageId: String(p.id ?? ""), family: String(p.family ?? ""), emphasis: "balanced", templateId: candidates.length ? candidates[i % candidates.length]! : "" };
    }),
  };
};
