"use client";

// Chapter description tools (M30 T13, D-090): the short paragraph a magazine / editorial layout
// shows about a chapter.
// - chapterDescriptionTool: opens when the description area is tapped on the page. A textarea
//   (dir="auto", live word counter, soft hint past 45 words, hard cap 400 characters); typing is
//   one undo entry per panel session (coalesceKey). setChapterDescription marks the text
//   source "user" — the AI never replaces it — and an emptied field removes the description, so the
//   panel and its `when` blocks collapse on the page.
// - aiDescriptionTool: the shared AI menu (AiRewritePanel) with Rewrite / Shorter / Translate. It
//   posts `{ target: "description", chapterId }` (never a pageId) and only "Use this" changes the doc.

import { Sparkles, Type } from "lucide-react";
import { useId, useState } from "react";
import { setChapterDescription } from "@/lib/book/edit-ops";
import { bookFontFamily } from "@/lib/book/fonts";
import type { Chapter } from "@/lib/book/types";
import {
  captionInputLang,
  DESCRIPTION_HARD_MAX,
  DESCRIPTION_REWRITE_COPY,
  descriptionLengthInfo,
  LONG_DESCRIPTION_HINT,
  type DescriptionRewriteInstruction,
} from "@/lib/editor/caption-tools";
import { styleCaptionFont } from "@/lib/design/styles";
import { cx } from "@/lib/cx";
import type { EditorContextValue } from "../editor-context";
import { AiRewritePanel } from "./ai-caption";
import { TOOL_HINT, TOOL_INPUT, TOOL_SECONDARY } from "./tool-classes";
import type { EditorPanelProps, EditorTool } from "./types";

export const DESCRIPTION_TOOL_ID = "description";
export const AI_DESCRIPTION_TOOL_ID = "ai-description";

/** The chapter whose description is selected, or null. */
export function selectedDescription(ctx: Pick<EditorContextValue, "state">): { chapter: Chapter; pageIdx: number } | null {
  const sel = ctx.state.selection;
  if (sel?.kind !== "description") return null;
  const page = ctx.state.doc.pages[sel.pageIdx];
  const chapter = page?.chapterId ? ctx.state.doc.chapters.find((c) => c.id === page.chapterId) : undefined;
  return chapter ? { chapter, pageIdx: sel.pageIdx } : null;
}

/** The body text face of the book's style for Latin / Arabic text (Poppins / Tajawal in the M30 styles). */
function descriptionFontFamily(ctx: Pick<EditorContextValue, "state">, lang: "ar" | "en"): string {
  return bookFontFamily(styleCaptionFont(ctx.state.doc.style.designStyle, lang));
}

let sessionSeq = 0;

function ChapterDescriptionPanel({ ctx }: EditorPanelProps) {
  const id = useId();
  const [session] = useState(() => ++sessionSeq);
  const current = selectedDescription(ctx);
  if (!current) return null;
  const { chapter } = current;
  const text = chapter.description?.text ?? "";
  const info = descriptionLengthInfo(text);
  const lang = captionInputLang(text, ctx.book.captionLang);
  return (
    <div className="flex flex-col gap-2" data-testid="description-editor">
      {/* The panel heading already says "About this chapter": the label is for screen readers. */}
      <label htmlFor={`${id}-description`} className="sr-only">
        About this chapter
      </label>
      <textarea
        id={`${id}-description`}
        dir="auto"
        lang={lang}
        value={text}
        maxLength={DESCRIPTION_HARD_MAX}
        rows={4}
        disabled={ctx.readOnly}
        placeholder="A few lines about this part of your story…"
        onChange={(e) =>
          ctx.actions.edit((d) => setChapterDescription(d, chapter.id, e.target.value), {
            coalesceKey: `description:${chapter.id}:${session}`,
          })
        }
        className={cx(TOOL_INPUT, "resize-none leading-snug")}
        style={{ fontFamily: descriptionFontFamily(ctx, lang) }}
        aria-describedby={`${id}-count ${id}-hint`}
        data-testid="description-input"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
        <p id={`${id}-count`} className={cx("tabular-nums", info.full && "font-medium text-destructive")} data-testid="description-count" aria-live="polite">
          {info.label}
        </p>
        {info.long ? (
          <p className="text-warning" data-testid="description-long-hint">
            {LONG_DESCRIPTION_HINT}
          </p>
        ) : null}
      </div>
      <p id={`${id}-hint`} className={cx(TOOL_HINT, "px-1")}>
        Shown with{" "}
        <span dir="auto" className="font-medium">
          {chapter.title || "this chapter"}
        </span>
        . Leave it empty to hide the text.
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" onClick={() => ctx.openTool(AI_DESCRIPTION_TOOL_ID)} className={TOOL_SECONDARY} data-testid="description-open-ai">
          <Sparkles className="size-4" aria-hidden="true" /> AI help
        </button>
      </div>
    </div>
  );
}

export const chapterDescriptionTool: EditorTool = {
  id: DESCRIPTION_TOOL_ID,
  label: "Edit",
  icon: Type,
  scopes: ["description"],
  order: 30,
  tier: "primary",
  openOnSelect: true,
  panelTitle: "About this chapter",
  Panel: ChapterDescriptionPanel,
};

function AiDescriptionPanel({ ctx }: EditorPanelProps) {
  const current = selectedDescription(ctx);
  if (!current) return null;
  const { chapter } = current;
  return (
    <AiRewritePanel
      ctx={ctx}
      target={{
        testIdPrefix: "ai-description",
        text: chapter.description?.text ?? "",
        // Strict server body: `target` + `chapterId`, never a `pageId`.
        body: (instruction, text) => ({
          bookId: ctx.book.id,
          target: "description",
          chapterId: chapter.id,
          instruction: instruction as DescriptionRewriteInstruction,
          text,
        }),
        // The chapter may be gone by the time the answer arrives (its last page deleted).
        apply: (accepted) => ctx.actions.edit((d) => (d.chapters.some((c) => c.id === chapter.id) ? setChapterDescription(d, chapter.id, accepted) : d)),
        backTool: DESCRIPTION_TOOL_ID,
        tones: false,
        previewFont: (lang) => descriptionFontFamily(ctx, lang),
        copy: DESCRIPTION_REWRITE_COPY,
      }}
    />
  );
}

export const aiDescriptionTool: EditorTool = {
  id: AI_DESCRIPTION_TOOL_ID,
  label: "AI help",
  icon: Sparkles,
  scopes: ["description"],
  order: 31,
  tier: "primary",
  panelTitle: "AI writing help",
  Panel: AiDescriptionPanel,
};
