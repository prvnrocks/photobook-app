"use client";
// Upload-screen setup card (M13 T6, D-070): the one optional question while photos upload —
// "What's this book for?" (6 occasion chips, default Other) — plus a "Change" disclosure with feel,
// caption language, title (blank = AI suggests, or "Your book" when AI is off), page shape (suggested from the photos) and style
// (follows the occasion until picked). Changes save by themselves (use-book-setup); once the AI
// build starts, or the album was edited, the locked controls say why.
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { TITLE_MAX_CHARS, titleLength } from "@/app/books/form-state";
import { ShapePreview, StylePreview } from "@/components/books/DesignPreview";
import {
  CAPTION_LANG_LABELS,
  CAPTION_LANGS,
  OCCASION_LABELS,
  OCCASIONS,
  TONE_LABELS,
  TONES,
  type Occasion,
} from "@/lib/book/options";
import { DEFAULT_TITLES } from "@/lib/book/default-titles";
import type { BookFormat } from "@/lib/book/types";
import {
  DESIGN_STYLE_HINTS,
  DESIGN_STYLE_LABELS,
  FORM_DESIGN_STYLES,
  FORM_FORMATS,
  FORMAT_HINTS,
  FORMAT_SHORT_LABELS,
} from "@/lib/design/defaults";
import { LOCK_COPY, setupSummary } from "@/lib/upload/setup-ui";
import { cn } from "@/lib/utils";
import type { BookSetupController } from "./use-book-setup";

const COUNTER_FROM = 100;

const focusRing =
  "has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-card";
const disabledLook = "has-disabled:cursor-not-allowed has-disabled:opacity-60";
const chipClass = `relative inline-flex min-h-11 cursor-pointer items-center rounded-full border border-border bg-card px-4 text-base select-none hover:bg-muted has-checked:border-primary has-checked:bg-primary has-checked:text-primary-foreground ${focusRing} ${disabledLook}`;
const cardClass = `relative flex min-h-11 min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-border bg-background p-3 text-center select-none hover:bg-muted has-checked:border-primary has-checked:bg-secondary has-checked:ring-1 has-checked:ring-primary ${focusRing} ${disabledLook}`;
const radioInput = "absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed";
const legendClass = "mb-2 text-base font-medium";
const inputClass =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/60 aria-invalid:border-destructive disabled:opacity-60";

export type SetupCardProps = {
  controller: BookSetupController;
  /** Shape suggested from the picked photos at start (photos-first hand-off), if known. */
  suggestedFormat?: BookFormat;
  /** resolveAiMode() !== "off" (D-024): false → no "we'll suggest one" promise. Default true. */
  aiOn?: boolean;
};

/**
 * Title copy: AI suggests a title only when AI is on; otherwise a blank title becomes the
 * occasion's cover title (the rule album's DEFAULT_TITLES) — name exactly that (exported for tests).
 */
export function titleCopy(aiOn: boolean, occasion: Occasion = "other"): { summary: string; hint: string } {
  const fallback = DEFAULT_TITLES[occasion];
  return aiOn
    ? { summary: "Title: we'll suggest one", hint: "Leave empty and we'll suggest one" }
    : { summary: `Title: ${fallback}`, hint: `Leave empty for \u201c${fallback}\u201d` };
}

export function SetupCard({ controller: c, suggestedFormat, aiOn = true }: SetupCardProps) {
  const titleText = titleCopy(aiOn, c.setup.occasion);
  const uid = useId();
  const [open, setOpen] = useState(false);
  const { setup, locks, status, frozen } = c;
  const detailsOff = frozen || locks.details !== null;
  const designOff = detailsOff || locks.design !== null;
  const lockReason = frozen ? "ai_started" : (locks.details ?? null);
  const titleLen = titleLength(c.titleDraft);
  const ids = {
    heading: `${uid}-heading`,
    panel: `${uid}-panel`,
    status: `${uid}-status`,
    titleHint: `${uid}-title-hint`,
    titleErr: `${uid}-title-err`,
    titleCount: `${uid}-title-count`,
    designLock: `${uid}-design-lock`,
  };

  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-6"
      aria-labelledby={ids.heading}
      data-testid="setup-card"
      data-locked={lockReason ?? undefined}
    >
      <div className="flex flex-col gap-1">
        <h2 id={ids.heading} className="type-h2">
          What&apos;s this book for?
        </h2>
        <p className="type-small text-muted-foreground">Optional — it helps us pick the style and captions.</p>
      </div>

      <fieldset className="min-w-0" disabled={detailsOff}>
        <legend className="sr-only">Occasion</legend>
        <div className="flex flex-wrap gap-2">
          {OCCASIONS.map((id) => (
            <label key={id} className={chipClass}>
              <input
                type="radio"
                name={`${uid}-occasion`}
                value={id}
                checked={setup.occasion === id}
                onChange={() => c.setOccasion(id)}
                className={radioInput}
                data-testid={`setup-occasion-${id}`}
              />
              {OCCASION_LABELS[id]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-4">
        <p className="type-small text-muted-foreground" data-testid="setup-summary">
          {setupSummary(setup)}
          <span className="sr-only">. </span>
          <span className="block" dir="auto">
            {setup.title ? <>Title: {setup.title}</> : titleText.summary}
          </span>
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={ids.panel}
          onClick={() => setOpen((o) => !o)}
          className="-ms-3 inline-flex min-h-11 w-fit items-center gap-1 rounded-lg ps-3 pe-2 text-base font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          data-testid="setup-change"
        >
          Change
          <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </button>
      </div>

      <div id={ids.panel} hidden={!open} className="flex min-w-0 flex-col gap-5" data-testid="setup-panel">
        <fieldset className="min-w-0" disabled={detailsOff}>
          <legend className={legendClass}>Feel</legend>
          <div className="flex flex-wrap gap-2">
            {TONES.map((id) => (
              <label key={id} className={chipClass}>
                <input
                  type="radio"
                  name={`${uid}-tone`}
                  value={id}
                  checked={setup.tone === id}
                  onChange={() => c.setTone(id)}
                  className={radioInput}
                  data-testid={`setup-tone-${id}`}
                />
                {TONE_LABELS[id]}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="min-w-0" disabled={detailsOff}>
          <legend className={legendClass}>Captions in</legend>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
            {CAPTION_LANGS.map((id) => (
              <label
                key={id}
                className={`relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg text-base text-muted-foreground select-none has-checked:bg-card has-checked:font-medium has-checked:text-foreground has-checked:shadow-card ${focusRing} ${disabledLook}`}
              >
                <input
                  type="radio"
                  name={`${uid}-lang`}
                  value={id}
                  checked={setup.captionLang === id}
                  onChange={() => c.setCaptionLang(id)}
                  className={radioInput}
                  data-testid={`setup-lang-${id}`}
                />
                {id === "ar" ? (
                  <span lang="ar" dir="rtl" className="font-arabic">
                    {CAPTION_LANG_LABELS[id]}
                  </span>
                ) : (
                  <span>{CAPTION_LANG_LABELS[id]}</span>
                )}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor={`${uid}-title`} className="text-base font-medium">
            Title <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            id={`${uid}-title`}
            type="text"
            dir="auto"
            autoComplete="off"
            value={c.titleDraft}
            disabled={detailsOff}
            onChange={(e) => c.setTitle(e.target.value)}
            onBlur={() => void c.flush()}
            placeholder="e.g. Sara & Omar's Wedding"
            aria-invalid={c.titleError ? true : undefined}
            aria-describedby={cn(ids.titleHint, titleLen > COUNTER_FROM && ids.titleCount, c.titleError && ids.titleErr)}
            className={inputClass}
            data-testid="setup-title"
          />
          <div className="flex items-start justify-between gap-3 text-sm text-muted-foreground">
            <p id={ids.titleHint}>{titleText.hint}</p>
            {titleLen > COUNTER_FROM ? (
              <p
                id={ids.titleCount}
                aria-live="polite"
                className={cn("shrink-0 tabular-nums", titleLen > TITLE_MAX_CHARS && "font-medium text-destructive")}
              >
                {titleLen}/{TITLE_MAX_CHARS}
              </p>
            ) : null}
          </div>
          {c.titleError ? (
            <p id={ids.titleErr} className="text-sm text-destructive" data-testid="setup-title-error">
              {c.titleError}
            </p>
          ) : null}
        </div>

        {locks.design === "user_edited" && !detailsOff ? (
          <p id={ids.designLock} className="type-small text-muted-foreground" data-testid="setup-design-locked">
            {LOCK_COPY.user_edited}
          </p>
        ) : null}

        <fieldset className="min-w-0" disabled={designOff} aria-describedby={locks.design === "user_edited" ? ids.designLock : undefined}>
          <legend className={legendClass}>Page shape</legend>
          <div className="grid grid-cols-2 gap-2">
            {FORM_FORMATS.map((id) => (
              <label key={id} className={cardClass}>
                <input
                  type="radio"
                  name={`${uid}-format`}
                  value={id}
                  checked={setup.format === id}
                  onChange={() => c.setFormat(id)}
                  aria-describedby={`${uid}-format-${id}-hint`}
                  className={radioInput}
                  data-testid={`setup-format-${id}`}
                />
                <ShapePreview format={id} />
                <span className="flex min-w-0 flex-col items-center gap-0.5 leading-tight">
                  <span className="text-base font-medium">{FORMAT_SHORT_LABELS[id]}</span>
                  <span id={`${uid}-format-${id}-hint`} className="text-xs text-muted-foreground">
                    {suggestedFormat === id ? "Suggested for your photos" : FORMAT_HINTS[id]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="min-w-0" disabled={designOff} aria-describedby={locks.design === "user_edited" ? ids.designLock : undefined}>
          <legend className={legendClass}>Style</legend>
          <div className="grid grid-cols-2 gap-2">
            {FORM_DESIGN_STYLES.map((id) => (
              <label key={id} className={cardClass}>
                <input
                  type="radio"
                  name={`${uid}-style`}
                  value={id}
                  checked={setup.designStyle === id}
                  onChange={() => c.setStyle(id)}
                  aria-describedby={`${uid}-style-${id}-hint`}
                  className={radioInput}
                  data-testid={`setup-style-${id}`}
                />
                <StylePreview style={id} format={setup.format} />
                <span className="flex min-w-0 flex-col items-center gap-0.5 leading-tight">
                  <span className="text-base font-medium">{DESIGN_STYLE_LABELS[id]}</span>
                  <span id={`${uid}-style-${id}-hint`} className="text-xs text-muted-foreground">
                    {DESIGN_STYLE_HINTS[id]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <p id={ids.status} aria-live="polite" className="type-small min-h-5 text-muted-foreground empty:-mt-4 empty:min-h-0" data-testid="setup-status">
        {lockReason ? (
          <span data-testid="setup-locked">{LOCK_COPY[lockReason]}</span>
        ) : status.kind === "saving" ? (
          "Saving…"
        ) : status.kind === "saved" ? (
          "Saved"
        ) : status.kind === "error" ? (
          <span className="text-destructive" data-testid="setup-error">
            {status.message}
          </span>
        ) : null}
      </p>
    </section>
  );
}
