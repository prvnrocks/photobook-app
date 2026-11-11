"use client";

import { useActionState, useId, useState } from "react";
import { useFormStatus } from "react-dom";
import { createBookAction } from "@/app/books/actions";
import {
  initialNewBookFormState,
  TITLE_MAX_CHARS,
  titleLength,
  type NewBookFormState,
} from "@/app/books/form-state";
import { ShapePreview, StylePreview } from "@/components/books/DesignPreview";
import { ActionBar } from "@/components/app/ActionBar";
import { Button } from "@/components/ui/button";
import {
  CAPTION_LANG_LABELS,
  CAPTION_LANGS,
  OCCASION_LABELS,
  OCCASIONS,
  TONE_LABELS,
  TONES,
  type CaptionLang,
  type Occasion,
  type Tone,
} from "@/lib/book/options";
import type { BookFormat } from "@/lib/book/types";
import {
  DEFAULT_FORM_FORMAT,
  DESIGN_STYLE_HINTS,
  DESIGN_STYLE_LABELS,
  effectiveStyle,
  FORM_DESIGN_STYLES,
  FORM_FORMATS,
  FORMAT_HINTS,
  FORMAT_SHORT_LABELS,
  type FormDesignStyle,
} from "@/lib/design/defaults";
import { effectiveTone, newBookInitialState, SETTINGS_COPY, showFromMemoryHint } from "@/lib/settings/ui";
import { cn } from "@/lib/utils";

/** Counter appears once the title gets close to the limit. */
const COUNTER_FROM = 100;

const OCCASION_EMOJI: Record<Occasion, string> = {
  wedding: "💍",
  travel: "✈️",
  baby: "🍼",
  graduation: "🎓",
  family: "🏡",
  other: "✨",
};

// Visually hidden radio + styled label; focus ring follows keyboard focus.
const focusRing = "has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-card";

const chipClass = `relative inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-4 text-base select-none transition-colors hover:bg-muted has-checked:border-primary has-checked:bg-primary has-checked:text-primary-foreground ${focusRing}`;

// Picture card radio (Shape / Style): whole card is the hit target.
const cardClass = `relative flex min-h-11 min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-border bg-background p-3 text-center select-none transition-colors hover:bg-muted has-checked:border-primary has-checked:bg-secondary has-checked:ring-1 has-checked:ring-primary ${focusRing}`;

const srOnlyInput = "absolute inset-0 cursor-pointer opacity-0";

const inputClass =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/60 aria-invalid:border-destructive";

const groupClass = "flex min-w-0 flex-col gap-6 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-6";
const legendClass = "mb-3 text-base font-medium";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive" data-testid={id}>
      {message}
    </p>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      data-testid="create-book"
      variant="accent"
      size="cta"
    >
      {pending ? "Creating…" : "Continue to photos"}
    </Button>
  );
}

/** Prefill from user memory (D-032). Optional; the user can still change everything. */
export type NewBookFormProps = {
  initialTone?: Tone;
  initialLang?: CaptionLang;
  fromMemory?: boolean;
};

export function NewBookForm({ initialTone, initialLang, fromMemory = false }: NewBookFormProps = {}) {
  const [state, formAction] = useActionState<NewBookFormState, FormData>(
    createBookAction,
    initialNewBookFormState,
  );
  const uid = useId();
  const [initial] = useState(() => newBookInitialState({ initialTone, initialLang }));
  const [occasion, setOccasion] = useState<Occasion | null>(null);
  // null = follow the occasion's default tone; set once the user picks one (or from memory,
  // so the remembered tone isn't overwritten by the occasion default).
  const [manualTone, setManualTone] = useState<Tone | null>(initial.manualTone);
  const [captionLang, setCaptionLang] = useState<CaptionLang>(initial.captionLang);
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState<BookFormat>(DEFAULT_FORM_FORMAT);
  // null = follow the occasion's default style (D-068); set once the user picks one.
  const [manualStyle, setManualStyle] = useState<FormDesignStyle | null>(null);
  const designStyle = effectiveStyle(manualStyle, occasion);

  const tone: Tone = effectiveTone(manualTone, occasion);
  // Hint only while a remembered value is still selected and differs from the default.
  const showMemoryHint = showFromMemoryHint({
    fromMemory,
    rememberedTone: initial.manualTone,
    rememberedLang: initialLang !== undefined ? initial.captionLang : null,
    occasion,
    tone,
    captionLang,
  });
  const length = titleLength(title);
  const tooLong = length > TITLE_MAX_CHARS;
  const fe = state.fieldErrors ?? {};

  const ids = {
    occasionErr: "new-book-occasion-error",
    toneErr: "new-book-tone-error",
    langErr: "new-book-lang-error",
    titleErr: "new-book-title-error",
    formatErr: "new-book-format-error",
    styleErr: "new-book-style-error",
    designNote: `${uid}-design-note`,
    aboutHeading: `${uid}-about`,
    lookHeading: `${uid}-look`,
    titleHint: `${uid}-title-hint`,
    titleCount: `${uid}-title-count`,
  };

  return (
    <form action={formAction} className="flex w-full min-w-0 flex-col gap-stack">
      {state.error ? (
        <p
          role="alert"
          data-testid="new-book-error"
          className="rounded-lg border border-destructive-border bg-destructive-soft px-3 py-2 text-sm break-words text-destructive"
        >
          {state.error}
        </p>
      ) : null}

      <section className={groupClass} aria-labelledby={ids.aboutHeading}>
        <h2 id={ids.aboutHeading} className="type-h2">
          About the book
        </h2>
        <fieldset
          className="flex min-w-0 flex-col gap-3"
          aria-describedby={fe.occasion ? ids.occasionErr : undefined}
        >
          <legend className={legendClass}>What&apos;s the occasion?</legend>
          <div className="flex flex-wrap gap-2">
            {OCCASIONS.map((id) => (
              <label key={id} className={chipClass}>
                <input
                  type="radio"
                  name="occasion"
                  value={id}
                  required
                  checked={occasion === id}
                  onChange={() => setOccasion(id)}
                  className={srOnlyInput}
                  data-testid={`occasion-${id}`}
                />
                <span aria-hidden="true">{OCCASION_EMOJI[id]}</span>
                <span>{OCCASION_LABELS[id]}</span>
              </label>
            ))}
          </div>
          <FieldError id={ids.occasionErr} message={fe.occasion} />
        </fieldset>

        <fieldset
          className="flex min-w-0 flex-col gap-3"
          aria-describedby={fe.tone ? ids.toneErr : undefined}
        >
          <legend className={legendClass}>What feel should it have?</legend>
          {showMemoryHint ? (
            <p className="-mt-2 text-sm text-muted-foreground" data-testid="new-book-from-memory">
              {SETTINGS_COPY.fromMemory} — change anything you like.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {TONES.map((id) => (
              <label key={id} className={chipClass}>
                <input
                  type="radio"
                  name="tone"
                  value={id}
                  checked={tone === id}
                  onChange={() => setManualTone(id)}
                  className={srOnlyInput}
                  data-testid={`tone-${id}`}
                />
                <span>{TONE_LABELS[id]}</span>
              </label>
            ))}
          </div>
          <FieldError id={ids.toneErr} message={fe.tone} />
        </fieldset>

        <fieldset
          className="flex min-w-0 flex-col gap-3"
          aria-describedby={fe.captionLang ? ids.langErr : undefined}
        >
          <legend className={legendClass}>Captions in</legend>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
            {CAPTION_LANGS.map((id) => (
              <label
                key={id}
                className={`relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg text-base text-muted-foreground transition-colors select-none has-checked:bg-card has-checked:font-medium has-checked:text-foreground has-checked:shadow-card ${focusRing}`}
              >
                <input
                  type="radio"
                  name="captionLang"
                  value={id}
                  checked={captionLang === id}
                  onChange={() => setCaptionLang(id)}
                  className={srOnlyInput}
                  data-testid={`lang-${id}`}
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
          <FieldError id={ids.langErr} message={fe.captionLang} />
        </fieldset>

        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor={`${uid}-title`} className="text-base font-medium">
            Title <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            id={`${uid}-title`}
            name="title"
            type="text"
            dir="auto"
            autoComplete="off"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Sara & Omar's Wedding"
            data-testid="book-title"
            aria-invalid={fe.title || tooLong ? true : undefined}
            aria-describedby={cn(
              ids.titleHint,
              length > COUNTER_FROM && ids.titleCount,
              fe.title && ids.titleErr,
            )}
            className={inputClass}
          />
          <div className="flex items-start justify-between gap-3 text-sm text-muted-foreground">
            <p id={ids.titleHint}>Leave empty and we&apos;ll suggest one</p>
            {length > COUNTER_FROM ? (
              <p
                id={ids.titleCount}
                aria-live="polite"
                data-testid="book-title-count"
                className={cn("shrink-0 tabular-nums", tooLong && "font-medium text-destructive")}
              >
                {length}/{TITLE_MAX_CHARS}
              </p>
            ) : null}
          </div>
          <FieldError id={ids.titleErr} message={fe.title} />
        </div>
      </section>

      <section className={groupClass} aria-labelledby={ids.lookHeading}>
        <div className="flex flex-col gap-1">
          <h2 id={ids.lookHeading} className="type-h2">
            Look of the book
          </h2>
          <p id={ids.designNote} className="type-small text-muted-foreground">
            Set when the book is created — these two can&apos;t be changed later.
          </p>
        </div>
        <fieldset
          className="flex min-w-0 flex-col gap-3"
          aria-describedby={cn(ids.designNote, fe.format && ids.formatErr)}
        >
          <legend className={legendClass}>Page shape</legend>
          <div className="grid grid-cols-2 gap-2">
            {FORM_FORMATS.map((id) => (
              <label key={id} className={cardClass}>
                <input
                  type="radio"
                  name="format"
                  value={id}
                  checked={format === id}
                  onChange={() => setFormat(id)}
                  aria-describedby={`${uid}-format-${id}-hint`}
                  className={srOnlyInput}
                  data-testid={`format-${id}`}
                />
                <ShapePreview format={id} />
                <span className="flex min-w-0 flex-col items-center gap-0.5 leading-tight">
                  <span className="text-base font-medium">{FORMAT_SHORT_LABELS[id]}</span>
                  <span id={`${uid}-format-${id}-hint`} className="text-xs text-muted-foreground">
                    {FORMAT_HINTS[id]}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <FieldError id={ids.formatErr} message={fe.format} />
        </fieldset>

        <fieldset
          className="flex min-w-0 flex-col gap-3"
          aria-describedby={cn(ids.designNote, fe.designStyle && ids.styleErr)}
        >
          <legend className={legendClass}>Design style</legend>
          <div className="grid grid-cols-2 gap-2">
            {FORM_DESIGN_STYLES.map((id) => (
              <label key={id} className={cardClass}>
                <input
                  type="radio"
                  name="designStyle"
                  value={id}
                  checked={designStyle === id}
                  onChange={() => setManualStyle(id)}
                  aria-describedby={`${uid}-style-${id}-hint`}
                  className={srOnlyInput}
                  data-testid={`style-${id}`}
                />
                <StylePreview style={id} format={format} />
                <span className="flex min-w-0 flex-col items-center gap-0.5 leading-tight">
                  <span className="text-base font-medium">{DESIGN_STYLE_LABELS[id]}</span>
                  <span id={`${uid}-style-${id}-hint`} className="text-xs text-muted-foreground">
                    {DESIGN_STYLE_HINTS[id]}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <FieldError id={ids.styleErr} message={fe.designStyle} />
        </fieldset>
      </section>

      <ActionBar label="Create book">
        <SubmitButton />
      </ActionBar>
    </form>
  );
}
