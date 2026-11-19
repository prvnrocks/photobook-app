// refitStoryText (fix: blank space under story text): after a page's text changed (the user typed,
// an AI rewrite landed), give a storytelling page the fitted form of its template that suits the
// new text — the same rule as the composer (select.ts fittedForm): the base or one of its fitted
// variants (layouts/story), lowest crop cost + BLANK_WEIGHT × empty share of the paragraph box,
// a variant only when every text sets at full size with the 8 % margin and no photo is refused
// (crop / subject / print resolution, the selector's evalSlot). Longer text moves to a
// taller form; when even the shortest-type fit needs the base, the base (the roomiest form, the
// longest AI text at 10 pt) is used — so a variant never makes text overflow. Pure; same page id,
// slots (photos + the user's crops) and texts; only `layout` changes, and only within one
// template's forms. Any other page (no variants, a user layout) → the input doc.

import { getLayout } from "@/lib/layouts";
import { getPageTemplate, type PageTemplate } from "@/lib/layouts/templates";
import type { BookDoc } from "@/lib/book/types";
import { BLANK_WEIGHT, blankShare, CAPACITY_SLACK, evalSlot, textFits } from "./select";
import type { ComposePhoto } from "./types";

export type RefitContext = { lang: "en" | "ar"; photos?: ReadonlyMap<string, Pick<ComposePhoto, "width" | "height">> };

export function refitStoryText(doc: BookDoc, pageIdx: number, ctx: RefitContext): BookDoc {
  const page = doc.pages[pageIdx];
  const current = page ? getPageTemplate(page.layout) : undefined;
  const base = current ? getPageTemplate(current.baseId) : undefined;
  if (!page || !current || !base || base.variants.length === 0 || page.side === "right") return doc;
  const texts = (page.texts ?? []).map((t) => ({ role: t.role, text: t.text, panel: t.panel }));
  const forms = [base, ...base.variants.map((id) => getPageTemplate(id)).filter((t): t is PageTemplate => !!t)];

  let best: { id: string; cost: number } | null = null;
  for (const f of forms) {
    const layout = getLayout(f.id);
    if (!layout || layout.slots.length !== page.slots.length) continue;
    const variant = f.id !== base.id;
    // texts: every one keeps its panel; a variant only at full size with the margin
    const textsOk = texts.every((t) => {
      const panel = f.panels.find((p) => p.n === t.panel);
      return !!panel && (!variant || textFits(f, panel, t.text, ctx.lang, CAPACITY_SLACK, panel.n === 0));
    });
    if (!textsOk) continue;
    // photos keep their slots and crops: a form that would crop one too hard / print it too small is skipped
    let cost = 0;
    let ok = true;
    page.slots.forEach((s, i) => {
      const p = s.photoId ? ctx.photos?.get(s.photoId) : undefined;
      if (!s.photoId || !p) return;
      const e = evalSlot(f, layout, i, { id: s.photoId, width: p.width, height: p.height }, false);
      if (variant && e.reject) ok = false;
      cost += e.cost;
    });
    if (!ok) continue;
    cost += BLANK_WEIGHT * blankShare(f, texts, ctx.lang);
    if (!best || cost < best.cost - 1e-9) best = { id: f.id, cost };
  }
  const id = best?.id ?? base.id;
  if (id === page.layout) return doc;
  return { ...doc, pages: doc.pages.map((p, i) => (i === pageIdx ? { ...p, layout: id } : p)) };
}
