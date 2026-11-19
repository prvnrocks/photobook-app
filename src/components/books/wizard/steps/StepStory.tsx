"use client";
// Wizard step 4 "What makes this memory special?" (Task 5, reshaped in v3): three short optional
// fields (src/lib/story/questions.ts) — the occasion (prefilled with the occasion picked in step 2,
// editable; stored only when the user changes it), who is in the photos to the user (free text +
// chips like "My brother") and one short personal memory — plus an optional storytelling tone.
// Everything is optional — "Skip for now" is always there, nothing is required and nothing else is
// prefilled: a suggestion chip fills its field only when the user taps it, and only the user's own
// words are sent. The story uses these words as the only personal facts (never guessed from photos).
//   - Entry: loadStoryAnswersAction shows what is stored (a reload / a later visit). The wizard keeps
//     a client copy (`value`), so Back / Forward inside the session is instant and nothing typed is
//     lost; text typed before the load answers is never overwritten.
//   - Continue: saveStoryAnswersAction({ skipped: false }) — a full replace of the step's state.
//     Skip: saveStoryAnswersAction({ skipped: true, answers: [] }).
//   - A failed save never traps the user: the inline error offers "Try again" and "Continue without
//     saving" (the story is optional).
// Accessibility: every field has a visible <label>; chips are buttons with aria-pressed (+ a check
// mark, not colour alone); the tone is a native radio group (arrow keys) whose checked option can be
// cleared again (tap / Space); all targets ≥ 44 px; answers and chips use dir="auto" (Arabic).
// Lazy-loaded with the other book steps (not in the /books/new first load).

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  loadStoryAnswersAction,
  saveStoryAnswersAction,
} from "@/app/books/story-actions";
import { Notice } from "@/components/app/Notice";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import {
  WIZARD_BACK_CLASS,
  WIZARD_SECONDARY_CLASS,
  WizardNav,
} from "@/components/wizard/WizardNav";
import type { Occasion } from "@/lib/book/options";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import type {
  StoryAnswersInput,
  StoryAnswersResult,
  StoryAnswersView,
} from "@/lib/story/answers";
import {
  MEMORY_QUESTION_IDS,
  STORY_ANSWER_MAX,
  STORY_TONE_LABELS,
  STORY_TONES,
  occasionPrefill,
  storyQuestionsFor,
  type StoryQuestion,
  type StoryTone,
} from "@/lib/story/questions";

/** The step's state as the wizard keeps it between visits (question id → the user's text). */
export type StoryDraft = {
  storyTone: StoryTone | null;
  answers: Record<string, string>;
  /** The user changed something since the load (or before it answered). */
  touched: boolean;
  /** What the server had: "loaded" (safe to replace), "failed" (unknown — never overwritten by an untouched save). */
  loaded: "pending" | "loaded" | "failed";
};

export const EMPTY_STORY_DRAFT: StoryDraft = {
  storyTone: null,
  answers: {},
  touched: false,
  loaded: "pending",
};

/** Show the counter from this many characters before the limit. */
export const STORY_COUNTER_FROM = STORY_ANSWER_MAX - 20;

export const STORY_SUPPORT_LINE =
  "A few words help us tell your story, not just describe the photos. Answer what you like, or skip.";
export const STORY_SAVE_FAILED =
  "We couldn't save your answers. Try again, or continue without them.";

const codePoints = (s: string) => Array.from(s).length;

/** Cuts to STORY_ANSWER_MAX code points (never through a surrogate pair) and drops line breaks. */
export function clampStoryAnswer(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ");
  const chars = Array.from(flat);
  return chars.length > STORY_ANSWER_MAX
    ? chars.slice(0, STORY_ANSWER_MAX).join("")
    : flat;
}

/** The stored view → the draft (only answers of the questions asked now; the server maps old answers). */
export function storyDraftFromView(
  view: StoryAnswersView,
  questions: readonly StoryQuestion[],
): StoryDraft {
  const asked = new Set(questions.map((q) => q.id));
  const answers: Record<string, string> = {};
  for (const a of view.answers)
    if (asked.has(a.questionId))
      answers[a.questionId] = clampStoryAnswer(a.text);
  return {
    storyTone: view.storyTone,
    answers,
    touched: false,
    loaded: "loaded",
  };
}

/** What a field shows: the user's text, or — for the occasion only, until they type — the step-2 occasion. */
export function storyFieldValue(
  draft: StoryDraft,
  q: StoryQuestion,
  prefill: string,
): string {
  const own = draft.answers[q.id];
  return own !== undefined ? own : q.kind === "occasion" ? prefill : "";
}

/**
 * What Continue / Skip send. Blank answers are left out (the server would drop them anyway), and so
 * is an occasion still equal to the step-2 occasion (`prefill`): only the user's own words are sent.
 */
export function storyInputFromDraft(
  draft: StoryDraft,
  questions: readonly StoryQuestion[],
  skipped: boolean,
  prefill = "",
): StoryAnswersInput {
  if (skipped)
    return { storyTone: draft.storyTone, answers: [], skipped: true };
  const answers: StoryAnswersInput["answers"] = [];
  for (const q of questions) {
    const text = (draft.answers[q.id] ?? "").trim();
    if (text === "") continue;
    if (
      q.id === MEMORY_QUESTION_IDS.occasion &&
      text.toLowerCase() === prefill.trim().toLowerCase()
    )
      continue;
    answers.push({ questionId: q.id, text });
  }
  return { storyTone: draft.storyTone, answers, skipped: false };
}

export type StepStoryProps = {
  bookId: string;
  /** The book's occasion (null → the "Other" questions). */
  occasion: Occasion | null;
  /** id of the step headline (focused after a step change). */
  headlineId: string;
  /** The wizard's client copy; null = this session hasn't opened the step yet. */
  value: StoryDraft | null;
  onChange: (value: StoryDraft) => void;
  onBack: () => void;
  /** Go on to the Design step (after a save, a skip, or "Continue without saving"). */
  onContinue: () => void;
  /** Test seams; default to the server actions. */
  load?: (bookId: string) => Promise<StoryAnswersResult>;
  save?: (
    bookId: string,
    input: StoryAnswersInput,
  ) => Promise<StoryAnswersResult>;
};

const FIELD_CLASS =
  "w-full min-w-0 resize-none rounded-2xl border border-input bg-card px-4 py-3 text-base leading-snug text-foreground shadow-card outline-none placeholder:text-muted-foreground focus-visible:border-success focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const CHIP_CLASS =
  "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-4 text-sm font-medium text-primary transition-colors outline-none hover:border-success-border hover:bg-success-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-pressed:border-success aria-pressed:bg-success-soft motion-reduce:transition-none";

const TONE_CLASS =
  "group/tone relative flex min-h-12 min-w-0 cursor-pointer items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-start shadow-card hover:border-success-border has-checked:border-success has-checked:bg-success-soft has-checked:ring-1 has-checked:ring-success has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-background";

function Check({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StepStory({
  bookId,
  occasion,
  headlineId,
  value,
  onChange,
  onBack,
  onContinue,
  load = loadStoryAnswersAction,
  save = saveStoryAnswersAction,
}: StepStoryProps) {
  const uid = useId();
  const questions = storyQuestionsFor(occasion);
  const prefill = occasionPrefill(occasion);
  const draft = value ?? EMPTY_STORY_DRAFT;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const [saving, setSaving] = useState<"continue" | "skip" | null>(null);
  /** The last save failed: which action to offer again. */
  const [failed, setFailed] = useState<"continue" | "skip" | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Entry: show what is stored — once per session copy (a loaded / touched copy is never refetched).
  const needsLoad = draft.loaded === "pending";
  useEffect(() => {
    if (!needsLoad) return;
    let alive = true;
    void Promise.resolve()
      .then(() => load(bookId))
      .catch((): StoryAnswersResult => ({ ok: false, error: "unavailable" }))
      .then((res) => {
        if (!alive) return;
        const cur = draftRef.current;
        if (cur.loaded !== "pending") return;
        if (!res.ok) {
          onChangeRef.current({ ...cur, loaded: "failed" });
          return;
        }
        const stored = storyDraftFromView(
          res.context,
          storyQuestionsFor(occasion),
        );
        // Never overwrite what the user did while the load was on its way: their words / tone win.
        onChangeRef.current(
          cur.touched
            ? {
                ...cur,
                answers: { ...stored.answers, ...cur.answers },
                storyTone: cur.storyTone ?? stored.storyTone,
                loaded: "loaded",
              }
            : stored,
        );
      });
    return () => {
      alive = false;
    };
  }, [needsLoad, bookId, occasion, load]);

  function patch(next: Partial<Pick<StoryDraft, "storyTone" | "answers">>) {
    setFailed(null);
    onChange({ ...draftRef.current, ...next, touched: true });
  }

  function setAnswer(id: string, text: string) {
    patch({
      answers: { ...draftRef.current.answers, [id]: clampStoryAnswer(text) },
    });
  }

  async function submit(kind: "continue" | "skip") {
    if (saving) return;
    const cur = draftRef.current;
    // The stored state is unknown (load failed) and the user changed nothing: don't replace it with blanks.
    if (kind === "continue" && cur.loaded !== "loaded" && !cur.touched) {
      onContinue();
      return;
    }
    setFailed(null);
    setSaving(kind);
    let res: StoryAnswersResult;
    try {
      res = await save(
        bookId,
        storyInputFromDraft(cur, questions, kind === "skip", prefill),
      );
    } catch {
      res = { ok: false, error: "unavailable" };
    }
    if (!aliveRef.current) return;
    setSaving(null);
    if (res.ok) {
      onContinue();
      return;
    }
    setFailed(kind);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void submit("continue");
  }

  const busy = saving !== null;

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="mx-auto flex w-full max-w-[40rem] min-w-0 flex-col gap-8"
      data-testid="wizard-step-story"
    >
      <div className="flex flex-col gap-2">
        <WizardHeadline id={headlineId} focusable>
          {wizardHeadline(4)}
        </WizardHeadline>
        <p
          className="text-center text-base text-muted-foreground"
          data-testid="story-support"
        >
          {STORY_SUPPORT_LINE}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-7">
        {questions.map((q, i) => {
          const fieldId = `${uid}-q${i}`;
          const text = storyFieldValue(draft, q, prefill);
          const length = codePoints(text);
          const showCounter = length >= STORY_COUNTER_FROM;
          return (
            <div
              key={q.id}
              className="flex min-w-0 flex-col gap-2.5"
              data-testid={`story-question-${q.id}`}
            >
              <label htmlFor={fieldId} className="type-h2 text-heading">
                {q.prompt}{" "}
                <span className="type-small font-normal text-muted-foreground">
                  (optional)
                </span>
              </label>
              <p
                id={`${fieldId}-hint`}
                className="type-small -mt-1 text-muted-foreground"
                data-testid={`story-hint-${q.id}`}
              >
                {q.hint}
              </p>
              <textarea
                id={fieldId}
                name={`story-${q.id}`}
                rows={q.kind === "moment" ? 3 : 2}
                dir="auto"
                value={text}
                onChange={(e) => setAnswer(q.id, e.target.value)}
                onKeyDown={(e) => {
                  // One short line: Enter submits like a text field (Shift+Enter does nothing special).
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={q.placeholder}
                autoComplete="off"
                enterKeyHint="done"
                aria-describedby={
                  showCounter
                    ? `${fieldId}-hint ${fieldId}-count`
                    : `${fieldId}-hint`
                }
                className={FIELD_CLASS}
                data-testid={`story-answer-${q.id}`}
              />
              {showCounter ? (
                <p
                  id={`${fieldId}-count`}
                  className="type-small text-end text-muted-foreground"
                  data-testid={`story-count-${q.id}`}
                >
                  <span aria-hidden="true">
                    {length}/{STORY_ANSWER_MAX}
                  </span>
                  <span className="sr-only">
                    {length} of {STORY_ANSWER_MAX} characters used
                  </span>
                </p>
              ) : null}
              {q.suggestions.length > 0 ? (
                <div
                  className="flex min-w-0 flex-wrap gap-2"
                  role="group"
                  aria-label={`Ideas for: ${q.prompt}`}
                >
                  {q.suggestions.map((s) => {
                    const on = text === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        dir="auto"
                        aria-pressed={on}
                        onClick={() => setAnswer(q.id, s)}
                        className={CHIP_CLASS}
                        data-testid="story-chip"
                      >
                        {on ? <Check className="size-3.5 shrink-0" /> : null}
                        <span className="truncate">{s}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <fieldset
        className="min-w-0"
        aria-describedby={`${uid}-tone-hint`}
        data-testid="story-tone"
      >
        <legend className="type-h2 text-heading">
          How should it sound?{" "}
          <span className="type-small font-normal text-muted-foreground">
            (optional)
          </span>
        </legend>
        <p
          id={`${uid}-tone-hint`}
          className="type-small mt-1 text-muted-foreground"
        >
          Pick one, or leave it open. Tap your choice again to clear it.
        </p>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-3">
          {STORY_TONES.map((id) => {
            const on = draft.storyTone === id;
            return (
              <label
                key={id}
                className={TONE_CLASS}
                data-testid={`story-tone-${id}`}
              >
                <input
                  type="radio"
                  name="story-tone"
                  value={id}
                  checked={on}
                  onChange={() => patch({ storyTone: id })}
                  // A checked radio fires click but not change: that click clears the choice (optional).
                  onClick={() => {
                    if (draftRef.current.storyTone === id)
                      patch({ storyTone: null });
                  }}
                  // Space on an already-checked radio fires no click in Chromium: clear it here too.
                  onKeyDown={(e) => {
                    if (e.key === " " && draftRef.current.storyTone === id) {
                      e.preventDefault();
                      patch({ storyTone: null });
                    }
                  }}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-full border border-input bg-background text-transparent group-has-checked/tone:border-success group-has-checked/tone:bg-success group-has-checked/tone:text-white"
                >
                  <Check className="size-3.5" />
                </span>
                <span className="min-w-0 text-base leading-snug font-medium break-words text-foreground group-has-checked/tone:text-primary">
                  {STORY_TONE_LABELS[id]}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {failed ? (
        <Notice
          tone="error"
          data-testid="story-save-error"
          action={
            <>
              <button
                type="button"
                onClick={() => void submit(failed)}
                disabled={busy}
                className={WIZARD_BACK_CLASS}
                data-testid="story-save-retry"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={onContinue}
                disabled={busy}
                className={WIZARD_BACK_CLASS}
                data-testid="story-continue-unsaved"
              >
                Continue without saving
              </button>
            </>
          }
        >
          {STORY_SAVE_FAILED}
        </Notice>
      ) : null}

      <WizardNav
        onBack={onBack}
        secondary={
          <button
            type="button"
            onClick={() => void submit("skip")}
            disabled={busy}
            className={WIZARD_SECONDARY_CLASS}
            data-testid="story-skip"
          >
            Skip for now
          </button>
        }
        continueLabel="Continue"
        pendingLabel="Saving…"
        pending={busy}
        continueTestId="story-continue"
        className="mx-auto max-w-[36rem]"
      />
    </form>
  );
}
