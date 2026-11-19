// Editor actions on composed storybook pages (Task 8). Pure edit ops: one call = one undo step
// (ctx.actions.edit). Books without doc.meta.story never reach them (the Story tool is hidden).
//
//   regeneratePageLayout  "Regenerate page": choose ANOTHER approved template of the same family for
//                         that one page, with the same photos (and their crops) and the same texts
//                         (ids, roles, words, who wrote them). Nothing else on the page or in the
//                         book changes; no model call. "Rewrite text" is offered separately.
//   applyStoryText        "Rewrite story": put a rewritten text in a page-text panel, keeping its
//                         id / role / blockRef. source "ai" for an AI-written text, "user" when the
//                         user accepted a proposal for their own words.
//   pageLayoutIssues      the composer's actionable checks for the editor's "Things to check" list:
//                         text_overflow (offer a shorter rewrite), crop_excessive / dpi_too_low (offer
//                         a photo change).

import type { BookDesign } from "@/lib/book/book-design";
import { EditOpError } from "@/lib/book/edit-ops";
import type { BookDoc, BookPage, PageText } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import { getPageTemplate } from "@/lib/layouts/templates";
import { clipText } from "@/lib/text/clip";
import { refitStoryText, type RefitContext } from "./refit";
import { selectPageTemplate } from "./select";
import type { ComposePhoto, ComposeText } from "./types";
import { validatePageLayout } from "./validate";

export type RegeneratePageResult = { ok: true; doc: BookDoc; templateId: string } | { ok: false; reason: "not_story_page" | "no_alternative"; doc: BookDoc };

const CAPTION_KEY = "\u0000caption";

export function regeneratePageLayout(
  doc: BookDoc,
  pageIdx: number,
  ctx: { design: BookDesign; lang: "en" | "ar"; photos: ReadonlyMap<string, Pick<ComposePhoto, "width" | "height">> },
): RegeneratePageResult {
  const page = doc.pages[pageIdx];
  const template = page ? getPageTemplate(page.layout) : undefined;
  // a spread half or a page with a user layout is not re-laid out here
  if (!page || !template || page.side === "right") return { ok: false, reason: "not_story_page", doc };
  const photos: ComposePhoto[] = page.slots
    .filter((s) => s.photoId)
    .map((s) => {
      const p = ctx.photos.get(s.photoId!);
      return { id: s.photoId!, width: p?.width ?? null, height: p?.height ?? null };
    });
  const texts: ComposeText[] = (page.texts ?? []).map((t) => ({ key: t.id, role: t.role, text: t.text }));
  if (page.caption) texts.push({ key: CAPTION_KEY, role: "caption", text: page.caption.text });
  const neighbours = [doc.pages[pageIdx - 1]?.layout, doc.pages[pageIdx + 1]?.layout].filter((x): x is string => !!x);
  const r = selectPageTemplate({ family: template.family, design: ctx.design, lang: ctx.lang, targetShare: template.narrativeShare, recent: [], avoid: [page.layout, ...neighbours] }, photos, { texts });
  if (!r.ok || r.templateId === page.layout) return { ok: false, reason: "no_alternative", doc };
  const panelOf = new Map(r.texts.map((t) => [t.key, t.panel]));
  // never lose or re-type text: every text must find a panel, a caption must stay a caption
  if (page.caption && panelOf.get(CAPTION_KEY) !== -1) return { ok: false, reason: "no_alternative", doc };
  if ((page.texts ?? []).some((t) => panelOf.get(t.id) === undefined || panelOf.get(t.id) === -1)) return { ok: false, reason: "no_alternative", doc };
  // the user's crops stay
  const cropOf = new Map(page.slots.filter((s) => s.photoId).map((s) => [s.photoId!, s.crop]));
  const slots = r.slots.map((s) => ({ photoId: s.photoId, crop: { ...(cropOf.get(s.photoId) ?? s.crop) } }));
  const nextTexts: PageText[] = (page.texts ?? []).map((t) => ({ ...t, panel: panelOf.get(t.id)! })).sort((a, b) => a.panel - b.panel);
  const next: BookPage = { id: page.id, chapterId: page.chapterId, layout: r.templateId, slots, caption: page.caption };
  if (page.background) next.background = page.background;
  if (nextTexts.length) next.texts = nextTexts;
  return { ok: true, doc: { ...doc, pages: doc.pages.map((p, i) => (i === pageIdx ? next : p)) }, templateId: r.templateId };
}

/**
 * Sets the text of page-text panel `panel` on page `pageIdx` to `text` (a rewrite), keeping the
 * text's id, role and blockRef. Throws EditOpError no_text_area when the panel holds no text.
 * With `refit`, the page then takes the fitted form of its template that suits the new text
 * (./refit.ts) in the same edit — a longer rewrite never overflows a short variant.
 */
export function applyStoryText(doc: BookDoc, pageIdx: number, panel: number, text: string, source: "ai" | "user", refit?: RefitContext): BookDoc {
  const next = applyText(doc, pageIdx, panel, text, source);
  return refit && next !== doc ? refitStoryText(next, pageIdx, refit) : next;
}

function applyText(doc: BookDoc, pageIdx: number, panel: number, text: string, source: "ai" | "user"): BookDoc {
  const page = doc.pages[pageIdx];
  if (!page) throw new EditOpError("page_out_of_range");
  const at = (page.texts ?? []).findIndex((t) => t.panel === panel);
  if (at < 0 || !getLayout(page.layout)?.texts?.some((t) => t.bind === "pageText" && (t.n ?? 0) === panel)) throw new EditOpError("no_text_area");
  const clean = clipText(text.replace(/\s+/g, " ").trim(), 2000, "");
  if (clean === "") throw new EditOpError("no_text_area");
  const prev = page.texts![at]!;
  if (prev.text === clean && prev.source === source) return doc;
  const texts = page.texts!.map((t, i) => (i === at ? { ...t, text: clean, source } : t));
  return { ...doc, pages: doc.pages.map((p, i) => (i === pageIdx ? { ...p, texts } : p)) };
}

export type PageIssue = { pageIdx: number; kind: "text_overflow" | "crop_excessive" | "dpi_too_low"; panel?: number; slot?: number };

/** Actionable composer checks of every storybook page (left pages of spreads only). */
export function pageLayoutIssues(doc: BookDoc, photos: ReadonlyMap<string, Pick<ComposePhoto, "width" | "height">>, lang: "en" | "ar", max = 12): PageIssue[] {
  if (!doc.meta?.story) return [];
  const out: PageIssue[] = [];
  const design: BookDesign = { format: doc.format, designStyle: doc.style.designStyle ?? "classic" };
  for (let i = 0; i < doc.pages.length && out.length < max; i++) {
    const page = doc.pages[i]!;
    if (!getPageTemplate(page.layout)) continue;
    const sizes = new Map(page.slots.filter((s) => s.photoId).map((s) => [s.photoId!, { id: s.photoId!, width: photos.get(s.photoId!)?.width ?? null, height: photos.get(s.photoId!)?.height ?? null }]));
    const report = validatePageLayout(page, { design, lang, photos: sizes });
    for (const e of report.errors) {
      if (e.code === "text_overflow" || e.code === "crop_excessive" || e.code === "dpi_too_low") {
        out.push({ pageIdx: i, kind: e.code, ...(e.panel !== undefined ? { panel: e.panel } : {}), ...(e.slot !== undefined ? { slot: e.slot } : {}) });
        if (out.length >= max) break;
      }
    }
  }
  return out;
}
