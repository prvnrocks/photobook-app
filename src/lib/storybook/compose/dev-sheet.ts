// Dev contact sheet of the storybook templates (Task 7): one page per story template of a style ×
// format, every text panel filled with the LONGEST text the AI writes (70-word intro / closing,
// 60-word paragraph, 18-word quote and caption) and a mid-length chapter title (the M29 lesson:
// mid-length titles clip first). Rendered by /dev-story-compose?sheet=… for the overflow probe and
// screenshots. Pure, dev only.

import type { BookDesign } from "@/lib/book/book-design";
import { newCaptionFont } from "@/lib/book/edit-ops";
import type { BookDoc, BookPage, PageText } from "@/lib/book/types";
import { styleCaptionFont } from "@/lib/design/styles";
import { bestCoverLayout } from "@/lib/layouts/fit";
import { getLayout } from "@/lib/layouts";
import { templatesFor } from "@/lib/layouts/templates";
import { fixturePhotos, maxText } from "./dev-fixture";
import type { ComposePhoto } from "./types";

const TITLE = { en: "Lanterns along the old harbour wall", ar: "فوانيس على سور الميناء القديم" } as const;

export function templateSheetDoc(design: BookDesign, lang: "en" | "ar", which: "new" | "all" = "new"): { doc: BookDoc; photos: ComposePhoto[] } {
  const templates = templatesFor(design.designStyle, design.format).filter((t) => which === "all" || t.isNew);
  const photos = fixturePhotos(templates.reduce((n, t) => n + t.photoCount, 0) + 1);
  let next = 1;
  const style = { background: { kind: "color" as const, hex: "#FFFFFF" }, designStyle: design.designStyle, font: styleCaptionFont(design.designStyle, lang) };
  const pages: BookPage[] = templates.map((t, i) => {
    const layout = getLayout(t.id)!;
    const used = new Set<string>();
    const slots = layout.slots.map((_, k) => {
      // match each slot's orientation so the sheet shows the template as intended
      const want = layout.prefers[k];
      const pool = photos.slice(1);
      const pick = pool.find((p, j) => j >= next - 1 && !used.has(p.id) && (want === "any" || (want === "portrait" ? (p.height ?? 0) > (p.width ?? 0) : (p.width ?? 0) > (p.height ?? 0)))) ?? pool[next - 1]!;
      next++;
      used.add(pick.id);
      return { photoId: pick.id, crop: { x: 0.5, y: 0.5, zoom: 1 } };
    });
    const texts: PageText[] = t.panels
      .filter((p) => p.n >= 0)
      .map((p) => {
        const role = p.n === 1 ? "pull_quote" : t.family === "chapter_opening" ? "intro" : t.family === "closing" ? "closing" : "paragraph";
        return { id: `tx-s${i}-${p.n}`, panel: p.n, role, text: maxText(role, lang, i + 1), source: "ai" as const };
      });
    const hasCaption = t.panels.some((p) => p.n === -1);
    const captionText = maxText("caption", lang, i + 40);
    const page: BookPage = {
      id: `sheet-${i}`,
      chapterId: "ch-1",
      layout: t.id,
      slots: dedupe(slots),
      caption: hasCaption ? { text: captionText, font: newCaptionFont({ style }, captionText, lang), align: "center", source: "ai" } : null,
    };
    if (texts.length) page.texts = texts;
    return page;
  });
  const doc: BookDoc = {
    version: 2,
    format: design.format,
    occasion: "travel",
    cover: { layout: bestCoverLayout(design, "landscape"), photoId: photos[0]!.id, title: TITLE[lang], subtitle: "" },
    chapters: [{ id: "ch-1", title: TITLE[lang], dateLabel: lang === "ar" ? "١٢ أكتوبر ٢٠٢٦" : "12 Oct 2026", place: null }],
    pages,
    style,
  };
  return { doc, photos };
}

/** One photo per slot across the sheet is not required (it is not a book), but keep each page's slots distinct. */
function dedupe(slots: { photoId: string; crop: { x: number; y: number; zoom: number } }[]) {
  const seen = new Set<string>();
  return slots.map((s, k) => {
    if (!seen.has(s.photoId)) {
      seen.add(s.photoId);
      return s;
    }
    return { ...s, photoId: `00000000-0000-4000-8000-${String(800 + k).padStart(12, "0")}` };
  });
}
