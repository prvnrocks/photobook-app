"use client";

// Storybook page text tool (Task 7): opens when a storybook text (chapter intro, story paragraph,
// pull quote, closing reflection) is tapped on the page — the same pattern as the chapter
// description tool. A textarea (dir="auto"), a live word count against what the panel holds
// (the composer's own fit check: overflow is flagged, never cut), one undo step per panel session
// (coalesceKey). setPageText marks the text "user", so a recomposition never replaces it; an
// emptied field removes the text.

import { Type } from "lucide-react";
import { useId, useState } from "react";
import { setPageText, PAGE_TEXT_EDIT_MAX } from "@/lib/book/edit-ops";
import { bookFontFamily } from "@/lib/book/fonts";
import type { PageText, PageTextRole } from "@/lib/book/types";
import { captionInputLang } from "@/lib/editor/caption-tools";
import { styleCaptionFont } from "@/lib/design/styles";
import { getPageTemplate } from "@/lib/layouts/templates";
import { textFits } from "@/lib/storybook/compose/select";
import { cx } from "@/lib/cx";
import type { EditorContextValue } from "../editor-context";
import { TOOL_HINT, TOOL_INPUT } from "./tool-classes";
import type { EditorPanelProps, EditorTool } from "./types";

export const PAGE_TEXT_TOOL_ID = "page-text";

const ROLE_LABEL: Record<PageTextRole, string> = { intro: "Chapter intro", paragraph: "Story", pull_quote: "Quote", closing: "Closing words", caption: "Caption" };

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

function PageTextPanel({ ctx }: EditorPanelProps) {
  const id = useId();
  const [session] = useState(() => ++sessionSeq);
  const current = selectedPageText(ctx);
  if (!current) return null;
  const page = ctx.state.doc.pages[current.pageIdx]!;
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
        onChange={(e) => ctx.actions.edit((d) => setPageText(d, current.pageIdx, current.panel, e.target.value, role), { coalesceKey: `text:${page.id}:${current.panel}:${session}` })}
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
