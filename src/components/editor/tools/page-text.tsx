"use client";

// Storybook page text tool (Task 7): opens when a storybook text (chapter intro, story paragraph,
// pull quote, closing reflection) is tapped on the page — the same pattern as the chapter
// description tool. A textarea (dir="auto"), a live word count against what the panel holds
// (the composer's own fit check: overflow is flagged, never cut), one undo step per panel session
// (coalesceKey). setPageText marks the text "user", so a recomposition never replaces it; an
// emptied field removes the text. Each edit re-fits a storytelling page to its text
// (refitStoryText: a taller / shorter form of the same template), so typing more never overflows a
// short variant — "too long" only shows when even the roomiest form cannot hold the words.
// Story v4: on a chapter story page the panel edits the whole page at once — chapter title
// (setChapterTitle), subtitle, headline, story paragraph and closing line — one field each, each
// field its own undo step; the tapped line's field takes the focus.

import { Type } from "lucide-react";
import { useId, useState } from "react";
import { CHAPTER_TITLE_MAX, setChapterTitle, setPageText, PAGE_TEXT_EDIT_MAX } from "@/lib/book/edit-ops";
import { bookFontFamily } from "@/lib/book/fonts";
import type { PageText, PageTextRole } from "@/lib/book/types";
import { captionInputLang } from "@/lib/editor/caption-tools";
import { styleCaptionFont } from "@/lib/design/styles";
import { getPageTemplate } from "@/lib/layouts/templates";
import { refitStoryText } from "@/lib/storybook/compose/refit";
import { textFits } from "@/lib/storybook/compose/select";
import { cx } from "@/lib/cx";
import type { EditorContextValue } from "../editor-context";
import { TOOL_HINT, TOOL_INPUT, TOOL_LABEL } from "./tool-classes";
import type { EditorPanelProps, EditorTool } from "./types";

export const PAGE_TEXT_TOOL_ID = "page-text";

const ROLE_LABEL: Record<PageTextRole, string> = {
  intro: "Chapter intro",
  paragraph: "Story",
  pull_quote: "Quote",
  closing: "Closing words",
  caption: "Caption",
  subtitle: "Subtitle",
  headline: "Headline",
  closing_line: "Closing line",
};
/** Story v4: the chapter story page's fields, in page order (panel numbers: layouts/story CHAPTER_STORY_PANELS). */
const CHAPTER_STORY_FIELDS: readonly { panel: number; role: PageTextRole; label: string; rows: number }[] = [
  { panel: 1, role: "subtitle", label: "Subtitle", rows: 1 },
  { panel: 2, role: "headline", label: "Headline", rows: 2 },
  { panel: 0, role: "intro", label: "Story", rows: 6 },
  { panel: 3, role: "closing_line", label: "Closing line", rows: 2 },
];

/** The selected page text: page index, panel, the text (null when the panel is empty). */
export function selectedPageText(ctx: Pick<EditorContextValue, "state">): { pageIdx: number; panel: number; text: PageText | null } | null {
  const sel = ctx.state.selection;
  if (sel?.kind !== "text") return null;
  const page = ctx.state.doc.pages[sel.pageIdx];
  if (!page) return null;
  return { pageIdx: sel.pageIdx, panel: sel.panel, text: page.texts?.find((t) => t.panel === sel.panel) ?? null };
}

const countWords = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
let sessionSeq = 0;

/** Story v4: every line of a chapter story page in one panel (title + the four page texts). */
function ChapterStoryFields({ ctx, pageIdx, focusPanel }: { ctx: EditorContextValue; pageIdx: number; focusPanel: number }) {
  const id = useId();
  const [session] = useState(() => ++sessionSeq);
  const page = ctx.state.doc.pages[pageIdx]!;
  const template = getPageTemplate(page.layout);
  const chapter = page.chapterId ? ctx.state.doc.chapters.find((c) => c.id === page.chapterId) : undefined;
  const fontFamily = (text: string) => bookFontFamily(styleCaptionFont(ctx.state.doc.style.designStyle, captionInputLang(text, ctx.book.captionLang)));
  return (
    <div className="flex flex-col gap-3" data-testid="page-text-editor" data-chapter-story="true">
      {chapter ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-title`} className={TOOL_LABEL}>
            Chapter title
          </label>
          <input
            id={`${id}-title`}
            dir="auto"
            lang={captionInputLang(chapter.title, ctx.book.captionLang)}
            value={chapter.title}
            maxLength={CHAPTER_TITLE_MAX}
            disabled={ctx.readOnly}
            placeholder="Chapter title"
            onChange={(e) => ctx.actions.edit((d) => setChapterTitle(d, chapter.id, e.target.value), { coalesceKey: `chapter:${chapter.id}:${session}` })}
            className={cx(TOOL_INPUT, "min-h-11")}
            style={{ fontFamily: fontFamily(chapter.title) }}
            data-testid="page-text-field-title"
          />
        </div>
      ) : null}
      {CHAPTER_STORY_FIELDS.map((f) => {
        const text = page.texts?.find((t) => t.panel === f.panel)?.text ?? "";
        const lang = captionInputLang(text, ctx.book.captionLang);
        const panel = template?.panels.find((p) => p.n === f.panel);
        const overflow = !!panel && !!template && text.trim() !== "" && !textFits(template, panel, text, lang, 1);
        return (
          <div key={f.panel} className="flex flex-col gap-1">
            <label htmlFor={`${id}-${f.panel}`} className={TOOL_LABEL}>
              {f.label}
            </label>
            <textarea
              id={`${id}-${f.panel}`}
              dir="auto"
              lang={lang}
              value={text}
              rows={f.rows}
              maxLength={PAGE_TEXT_EDIT_MAX}
              disabled={ctx.readOnly}
              autoFocus={f.panel === focusPanel}
              placeholder="Your words…"
              onChange={(e) => ctx.actions.edit((d) => setPageText(d, pageIdx, f.panel, e.target.value, f.role), { coalesceKey: `text:${page.id}:${f.panel}:${session}` })}
              className={cx(TOOL_INPUT, "resize-none leading-snug")}
              style={{ fontFamily: fontFamily(text) }}
              aria-describedby={`${id}-${f.panel}-count`}
              data-testid={`page-text-field-${f.role}`}
            />
            <p id={`${id}-${f.panel}-count`} className={cx("px-1 text-xs tabular-nums", overflow ? "font-medium text-destructive" : "text-muted-foreground")} aria-live="polite">
              {countWords(text)} words{overflow ? " · too long for this page — shorten it" : ""}
            </p>
          </div>
        );
      })}
      <p className={cx(TOOL_HINT, "px-1")}>Leave a field empty to remove that line.</p>
    </div>
  );
}

function PageTextPanel({ ctx }: EditorPanelProps) {
  const id = useId();
  const [session] = useState(() => ++sessionSeq);
  const current = selectedPageText(ctx);
  if (!current) return null;
  const page = ctx.state.doc.pages[current.pageIdx]!;
  if (getPageTemplate(page.layout)?.chapterStory) return <ChapterStoryFields ctx={ctx} pageIdx={current.pageIdx} focusPanel={current.panel} />;
  const text = current.text?.text ?? "";
  const lang = captionInputLang(text, ctx.book.captionLang);
  const template = getPageTemplate(page.layout);
  const panel = template?.panels.find((p) => p.n === current.panel);
  const role: PageTextRole = current.text?.role ?? (panel?.roles[0] ?? "paragraph");
  const overflow = !!panel && !!template && text.trim() !== "" && !textFits(template, panel, text, lang, 1);
  return (
    <div className="flex flex-col gap-2" data-testid="page-text-editor">
      <label htmlFor={`${id}-text`} className="sr-only">
        {ROLE_LABEL[role]}
      </label>
      <textarea
        id={`${id}-text`}
        dir="auto"
        lang={lang}
        value={text}
        maxLength={PAGE_TEXT_EDIT_MAX}
        rows={6}
        disabled={ctx.readOnly}
        placeholder="Your words…"
        onChange={(e) => ctx.actions.edit((d) => refitStoryText(setPageText(d, current.pageIdx, current.panel, e.target.value, role), current.pageIdx, { lang, photos: ctx.photos.byId }), { coalesceKey: `text:${page.id}:${current.panel}:${session}` })}
        className={cx(TOOL_INPUT, "resize-none leading-snug")}
        style={{ fontFamily: bookFontFamily(styleCaptionFont(ctx.state.doc.style.designStyle, lang)) }}
        aria-describedby={`${id}-count`}
        data-testid="page-text-input"
      />
      <p id={`${id}-count`} className={cx("px-1 text-xs tabular-nums", overflow ? "font-medium text-destructive" : "text-muted-foreground")} aria-live="polite" data-testid="page-text-count">
        {countWords(text)} words{overflow ? " · too long for this page — shorten it or pick a page with more room" : ""}
      </p>
      <p className={cx(TOOL_HINT, "px-1")}>{ROLE_LABEL[role]}. Leave it empty to remove the text.</p>
    </div>
  );
}

export const pageTextTool: EditorTool = {
  id: PAGE_TEXT_TOOL_ID,
  label: "Edit",
  icon: Type,
  scopes: ["text"],
  order: 30,
  tier: "primary",
  openOnSelect: true,
  panelTitle: "Text",
  Panel: PageTextPanel,
};
