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
import { effectiveTone, newBookInitialState, SETTINGS_COPY } from "@/lib/settings/ui";
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
const chipClass =
  "relative inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background px-4 text-base select-none transition-colors hover:bg-muted has-checked:border-primary has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50";

const srOnlyInput = "absolute inset-0 cursor-pointer opacity-0";

const inputClass =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";

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
      className="h-11 w-full text-base"
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

  const tone: Tone = effectiveTone(manualTone, occasion);
  // Hint stays while at least one remembered value is still selected.
  const showMemoryHint =
    fromMemory &&
    ((initial.manualTone !== null && tone === initial.manualTone) ||
      (initialLang !== undefined && captionLang === initial.captionLang));
  const length = titleLength(title);
  const tooLong = length > TITLE_MAX_CHARS;
  const fe = state.fieldErrors ?? {};

  const ids = {
    occasionErr: "new-book-occasion-error",
    toneErr: "new-book-tone-error",
    langErr: "new-book-lang-error",
    titleErr: "new-book-title-error",
    titleHint: `${uid}-title-hint`,
    titleCount: `${uid}-title-count`,
  };

  return (
    <form action={formAction} className="flex w-full min-w-0 flex-col gap-6">
      {state.error ? (
        <p
          role="alert"
          data-testid="new-book-error"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm break-words text-destructive"
        >
          {state.error}
        </p>
      ) : null}

      <fieldset
        className="flex min-w-0 flex-col gap-3"
        aria-describedby={fe.occasion ? ids.occasionErr : undefined}
      >
        <legend className="mb-3 text-base font-medium">What&apos;s the occasion?</legend>
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
        <legend className="mb-3 text-base font-medium">What feel should it have?</legend>
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
        <legend className="mb-3 text-base font-medium">Captions in</legend>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
          {CAPTION_LANGS.map((id) => (
            <label
              key={id}
              className="relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg text-base text-muted-foreground transition-colors select-none has-checked:bg-background has-checked:font-medium has-checked:text-foreground has-checked:shadow-sm has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
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

      <SubmitButton />
    </form>
  );
}
