"use client";

// Caption tools (M5 Task 10):
// - captionEditorTool: textarea for the selected page caption (opens on caption tap). Typing is
//   one undo entry per panel session (coalesceKey); setCaption marks the caption source 'user'.
// - captionStyleTool: FontPicker (each font previewed in itself) + left/center/right align.

import { AlignCenter, AlignLeft, AlignRight, Palette, Sparkles, Type } from "lucide-react";
import { useId, useState } from "react";
import { CAPTION_FONTS, captionFontFamily, type CaptionFont } from "@/lib/book/fonts";
import { setCaption, setCaptionAlign, setCaptionFont, type CaptionAlign } from "@/lib/book/edit-ops";
import { captionFontOf } from "@/lib/book/render";
import {
  CAPTION_HARD_MAX,
  captionInputLang,
  captionLengthInfo,
  LONG_CAPTION_HINT,
} from "@/lib/editor/caption-tools";
import { cn } from "@/lib/utils";
import type { EditorContextValue } from "../editor-context";
import type { EditorPanelProps, EditorTool } from "./types";

/** The selected caption's page, or null. */
export function selectedCaptionPage(ctx: Pick<EditorContextValue, "state">) {
  const sel = ctx.state.selection;
  if (sel?.kind !== "caption") return null;
  const page = ctx.state.doc.pages[sel.pageIdx];
  return page ? { pageIdx: sel.pageIdx, page } : null;
}

let sessionSeq = 0;

function CaptionEditorPanel({ ctx }: EditorPanelProps) {
  const target = selectedCaptionPage(ctx);
  const [session] = useState(() => ++sessionSeq);
  const id = useId();
  if (!target) return null;
  const { pageIdx, page } = target;
  const text = page.caption?.text ?? "";
  const info = captionLengthInfo(text);
  const font = page.caption ? captionFontOf(page.caption, ctx.book.captionLang) : null;
  const fontFamily = captionFontFamily(font ?? (captionInputLang(text, ctx.book.captionLang) === "ar" ? "Cairo" : "Playfair"));

  const onChange = (value: string) => {
    ctx.actions.edit((d) => setCaption(d, pageIdx, value, { captionLang: ctx.book.captionLang }), {
      coalesceKey: `caption:${page.id}:${session}`,
    });
  };

  return (
    <div className="flex flex-col gap-2" data-testid="caption-editor">
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
        className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-base leading-snug outline-none focus-visible:ring-2 focus-visible:ring-primary"
        style={{ fontFamily }}
        aria-describedby={`${id}-count`}
        data-testid="caption-input"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <p id={`${id}-count`} className={cn("tabular-nums", info.full && "text-red-700")} data-testid="caption-count" aria-live="polite">
          {info.label}
        </p>
        {info.long ? (
          <p className="text-amber-700" data-testid="caption-long-hint">
            {LONG_CAPTION_HINT}
          </p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => ctx.openTool("ai-caption")}
          className="flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-muted"
          data-testid="caption-open-ai"
        >
          <Sparkles className="size-4" aria-hidden="true" /> AI help
        </button>
        <button
          type="button"
          onClick={() => ctx.openTool("caption-style")}
          disabled={!page.caption}
          className="flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-muted disabled:opacity-40"
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
  label: "Caption",
  icon: Type,
  scopes: ["caption"],
  order: 30,
  openOnSelect: true,
  panelTitle: "Caption",
  Panel: CaptionEditorPanel,
};

// ---- font + align --------------------------------------------------------------------------------

const FONT_SAMPLE: Record<CaptionFont, string> = {
  Inter: "Aa",
  Playfair: "Aa",
  Cairo: "أهلاً Aa",
  Tajawal: "أهلاً Aa",
};

const ALIGNS: { value: CaptionAlign; label: string; Icon: typeof AlignLeft }[] = [
  { value: "left", label: "Align left", Icon: AlignLeft },
  { value: "center", label: "Align center", Icon: AlignCenter },
  { value: "right", label: "Align right", Icon: AlignRight },
];

export function FontPicker({
  value,
  onChange,
  disabled,
}: {
  value: CaptionFont | null;
  onChange(font: CaptionFont): void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Caption font" className="grid grid-cols-2 gap-2" data-testid="font-picker">
      {CAPTION_FONTS.map((f) => {
        const selected = value === f;
        return (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(f)}
            className={cn(
              "flex min-h-14 flex-col items-center justify-center rounded-lg border px-2 py-1 disabled:opacity-40",
              selected ? "border-primary bg-primary/10 ring-2 ring-primary" : "hover:bg-muted",
            )}
            style={{ fontFamily: captionFontFamily(f) }}
            data-testid={`font-${f}`}
          >
            <span className="text-lg leading-tight" dir="auto">
              {FONT_SAMPLE[f]}
            </span>
            <span className="text-xs">{f}</span>
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
          className={cn(
            "flex size-11 items-center justify-center rounded-lg border disabled:opacity-40",
            value === a ? "border-primary bg-primary/10 ring-2 ring-primary" : "hover:bg-muted",
          )}
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
  return (
    <div className="flex flex-col gap-4" data-testid="caption-style">
      {!caption ? <p className="text-sm text-muted-foreground">Write a caption first, then pick its font.</p> : null}
      <FontPicker
        value={caption ? captionFontOf(caption, ctx.book.captionLang) : null}
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
  panelTitle: "Caption font",
  Panel: CaptionStylePanel,
};
