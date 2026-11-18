"use client";

// Caption tools (M5 Task 10):
// - captionEditorTool: textarea for the selected page caption (opens on caption tap). Typing is
//   one undo entry per panel session (coalesceKey); setCaption marks the caption source 'user'.
// - captionStyleTool: FontPicker (each font previewed in itself) + left/center/right align.
//   Magazine / editorial books (M30) also get their own face, Poppins ("Sans" pair with Tajawal).

import { AlignCenter, AlignLeft, AlignRight, Palette, Sparkles, Type } from "lucide-react";
import { useId, useState } from "react";
import { BOOK_FONTS, bookFontFamily, CAPTION_FONTS, captionFontFamily, type BookFontName } from "@/lib/book/fonts";
import { setCaption, setCaptionAlign, setCaptionFont, type CaptionAlign } from "@/lib/book/edit-ops";
import {
  CAPTION_HARD_MAX,
  captionFontOptions,
  captionInputLang,
  captionLengthInfo,
  LONG_CAPTION_HINT,
  pickerFontOf,
} from "@/lib/editor/caption-tools";
import { cx } from "@/lib/cx";
import type { EditorContextValue } from "../editor-context";
import { TOOL_INPUT, TOOL_OPTION, TOOL_OPTION_ACTIVE, TOOL_SECONDARY } from "./tool-classes";
import type { EditorPanelProps, EditorTool } from "./types";

/** The selected caption's page, or null. */
export function selectedCaptionPage(ctx: Pick<EditorContextValue, "state">) {
  const sel = ctx.state.selection;
  if (sel?.kind !== "caption") return null;
  const page = ctx.state.doc.pages[sel.pageIdx];
  return page ? { pageIdx: sel.pageIdx, page } : null;
}

let sessionSeq = 0;

const SECONDARY_BTN = TOOL_SECONDARY;

function CaptionEditorPanel({ ctx }: EditorPanelProps) {
  const target = selectedCaptionPage(ctx);
  const [session] = useState(() => ++sessionSeq);
  const id = useId();
  if (!target) return null;
  const { pageIdx, page } = target;
  const text = page.caption?.text ?? "";
  const info = captionLengthInfo(text);
  const font = page.caption ? pickerFontOf(page.caption, captionFontOptions(ctx.state.doc.style.designStyle), ctx.book.captionLang) : null;
  const fontFamily = font
    ? bookFontFamily(font)
    : captionFontFamily(captionInputLang(text, ctx.book.captionLang) === "ar" ? "Cairo" : "Playfair");

  const onChange = (value: string) => {
    ctx.actions.edit((d) => setCaption(d, pageIdx, value, { captionLang: ctx.book.captionLang }), {
      coalesceKey: `caption:${page.id}:${session}`,
    });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="caption-editor">
      <label htmlFor={`${id}-caption`} className="sr-only">
        Caption for page {pageIdx + 1}
      </label>
      <textarea
        id={`${id}-caption`}
        dir="auto"
        lang={captionInputLang(text, ctx.book.captionLang)}
        value={text}
        maxLength={CAPTION_HARD_MAX}
        rows={3}
        disabled={ctx.readOnly}
        placeholder="Write a caption…"
        onChange={(e) => onChange(e.target.value)}
        className={cx(TOOL_INPUT, "resize-none leading-snug")}
        style={{ fontFamily }}
        aria-describedby={`${id}-count`}
        data-testid="caption-input"
      />
      <div className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
        <p id={`${id}-count`} className={cx("tabular-nums", info.full && "font-medium text-destructive")} data-testid="caption-count" aria-live="polite">
          {info.label}
        </p>
        {info.long ? (
          <p className="text-warning" data-testid="caption-long-hint">
            {LONG_CAPTION_HINT}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => ctx.openTool("ai-caption")}
          className={SECONDARY_BTN}
          data-testid="caption-open-ai"
        >
          <Sparkles className="size-4" aria-hidden="true" /> AI help
        </button>
        <button
          type="button"
          onClick={() => ctx.openTool("caption-style")}
          disabled={!page.caption}
          className={SECONDARY_BTN}
          data-testid="caption-open-style"
        >
          <Palette className="size-4" aria-hidden="true" /> Font
        </button>
      </div>
    </div>
  );
}

export const captionEditorTool: EditorTool = {
  id: "caption",
  label: "Edit",
  icon: Type,
  scopes: ["caption"],
  order: 30,
  tier: "primary",
  openOnSelect: true,
  panelTitle: "Caption",
  Panel: CaptionEditorPanel,
};

// ---- font + align --------------------------------------------------------------------------------

/** Tile sample: Arabic faces show Arabic + Latin, Latin faces "Aa". */
const fontSample = (f: BookFontName) => (BOOK_FONTS[f].script === "arabic" ? "أهلاً Aa" : "Aa");

const ALIGNS: { value: CaptionAlign; label: string; Icon: typeof AlignLeft }[] = [
  { value: "left", label: "Align left", Icon: AlignLeft },
  { value: "center", label: "Align center", Icon: AlignCenter },
  { value: "right", label: "Align right", Icon: AlignRight },
];

export function FontPicker({
  value,
  onChange,
  disabled,
  fonts = CAPTION_FONTS,
}: {
  value: BookFontName | null;
  onChange(font: BookFontName): void;
  disabled?: boolean;
  /** Faces to offer (captionFontOptions); default = the four classic faces. */
  fonts?: readonly BookFontName[];
}) {
  return (
    <div role="radiogroup" aria-label="Caption font" className="grid grid-cols-2 gap-2" data-testid="font-picker">
      {fonts.map((f) => {
        const selected = value === f;
        return (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(f)}
            className={cx(selected ? TOOL_OPTION_ACTIVE : TOOL_OPTION, "flex min-h-14 flex-col items-center justify-center px-2 py-1.5")}
            style={{ fontFamily: bookFontFamily(f) }}
            data-testid={`font-${f}`}
          >
            <span className="text-lg leading-tight" dir="auto">
              {fontSample(f)}
            </span>
            <span className="text-xs font-medium">{f}</span>
          </button>
        );
      })}
    </div>
  );
}

export function AlignPicker({
  value,
  onChange,
  disabled,
}: {
  value: CaptionAlign | null;
  onChange(align: CaptionAlign): void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Caption alignment" className="flex gap-2" data-testid="align-picker">
      {ALIGNS.map(({ value: a, label, Icon }) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={value === a}
          aria-label={label}
          disabled={disabled}
          onClick={() => onChange(a)}
          className={cx(value === a ? TOOL_OPTION_ACTIVE : TOOL_OPTION, "flex size-11 items-center justify-center")}
          data-testid={`align-${a}`}
        >
          <Icon className="size-5" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function CaptionStylePanel({ ctx }: EditorPanelProps) {
  const target = selectedCaptionPage(ctx);
  if (!target) return null;
  const { pageIdx, page } = target;
  const caption = page.caption;
  const disabled = ctx.readOnly || !caption;
  const fonts = captionFontOptions(ctx.state.doc.style.designStyle);
  return (
    <div className="flex flex-col gap-4" data-testid="caption-style">
      {!caption ? <p className="text-sm text-muted-foreground">Write a caption first, then pick its font.</p> : null}
      <FontPicker
        fonts={fonts}
        value={caption ? pickerFontOf(caption, fonts, ctx.book.captionLang) : null}
        disabled={disabled}
        onChange={(f) => ctx.actions.edit((d) => setCaptionFont(d, pageIdx, f))}
      />
      <AlignPicker
        value={caption?.align ?? null}
        disabled={disabled}
        onChange={(a) => ctx.actions.edit((d) => setCaptionAlign(d, pageIdx, a))}
      />
    </div>
  );
}

export const captionStyleTool: EditorTool = {
  id: "caption-style",
  label: "Font",
  icon: Palette,
  scopes: ["caption"],
  order: 32,
  tier: "more",
  panelTitle: "Caption font",
  Panel: CaptionStylePanel,
};
