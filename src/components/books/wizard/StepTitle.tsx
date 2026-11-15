// Wizard step 1 "Give your book a title" (M19 T3, D-071; M20 T4, D-072). A large friendly field with a
// live emerald "ink" underline that grows as you type, and a few tap-to-fill suggestion chips. The
// cover that shows the title lives in the live preview (WizardBookPreview: aside ≥ lg, mini on
// phones). Empty is fine (we suggest one); the counter appears near the limit; Enter continues (the
// field is inside the wizard form). No hooks and no cn/next/link (first-load client island).

import { TITLE_MAX_CHARS, titleLength } from "@/app/books/form-state";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import "./steps-motion.css";

/** The counter appears once the title gets close to the limit (as the old New book form). */
export const TITLE_COUNTER_FROM = 100;

export const TITLE_TOO_LONG = `Title must be ${TITLE_MAX_CHARS} characters or fewer.`;

/** Tap-to-fill ideas (generic, original). */
export const TITLE_SUGGESTIONS = ["Our summer", "Baby's first year", "Abu Dhabi weekend", "Family days out"] as const;

/** The ink underline is full at this many characters. */
const INK_FULL_AT = 24;

const INPUT_CLASS =
  "h-14 w-full min-w-0 rounded-2xl border border-input bg-card px-5 text-lg shadow-card outline-none placeholder:text-muted-foreground/70 focus-visible:border-success focus-visible:ring-4 focus-visible:ring-success/20 aria-invalid:border-destructive sm:h-16 sm:text-xl";

const CHIP_CLASS =
  "ws-chip inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-success/35 bg-card px-4 text-sm font-medium text-primary shadow-card outline-none hover:border-success hover:bg-success-soft aria-pressed:border-success aria-pressed:bg-success-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export type StepTitleProps = {
  title: string;
  onTitleChange: (title: string) => void;
  headlineId: string;
  /** Server field error for the title (create / save failed). */
  error?: string;
};

export function StepTitle({ title, onTitleChange, headlineId, error }: StepTitleProps) {
  const length = titleLength(title);
  const tooLong = length > TITLE_MAX_CHARS;
  const showCount = length > TITLE_COUNTER_FROM;
  const message = tooLong ? TITLE_TOO_LONG : error;
  const describedBy = ["wizard-title-hint", showCount && "wizard-title-count", message && "wizard-title-error"]
    .filter(Boolean)
    .join(" ");
  const ink = Math.min(length / INK_FULL_AT, 1);

  return (
    <div className="mx-auto flex w-full max-w-[36rem] flex-col items-center gap-4 sm:gap-6">
      <WizardHeadline id={headlineId} focusable>
        {wizardHeadline(1)}
      </WizardHeadline>
      <div className="flex w-full min-w-0 flex-col gap-2">
        <label htmlFor="wizard-title" className="text-base font-medium text-foreground">
          Book title
        </label>
        <div className="relative">
          <input
            id="wizard-title"
            name="wizard-title"
            type="text"
            dir="auto"
            autoComplete="off"
            enterKeyHint="next"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="e.g. Days by the Sea"
            aria-invalid={message ? true : undefined}
            aria-describedby={describedBy}
            className={INPUT_CLASS}
            data-testid="book-title"
          />
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-5 bottom-2 h-[3px] overflow-hidden rounded-full">
            <span
              className="ws-ink block h-full w-full rounded-full"
              style={{ "--ink": ink.toFixed(3) } as React.CSSProperties}
              data-over={tooLong ? "" : undefined}
              data-testid="book-title-ink"
            />
          </span>
        </div>
        <div className="flex items-start justify-between gap-3 text-sm text-muted-foreground">
          <p id="wizard-title-hint">It goes on the cover. You can change it later.</p>
          {showCount ? (
            <p
              id="wizard-title-count"
              aria-live="polite"
              data-testid="book-title-count"
              className={tooLong ? "shrink-0 font-medium text-destructive tabular-nums" : "shrink-0 tabular-nums"}
            >
              {length}/{TITLE_MAX_CHARS}
            </p>
          ) : null}
        </div>
        {message ? (
          <p id="wizard-title-error" className="text-sm text-destructive" data-testid="book-title-error">
            {message}
          </p>
        ) : null}
      </div>
      {/* Phones: the ideas stay one swipeable row right under the field, so they're above the sticky
          Continue bar on the first screen (M20 polish); ≥ sm they wrap. */}
      <div className="flex w-full min-w-0 flex-col gap-2" data-testid="title-suggestions">
        <p className="text-sm text-muted-foreground" id="wizard-title-ideas">
          Need an idea?
        </p>
        <div
          className="ws-chip-row relative -mx-gutter flex gap-2 overflow-x-auto px-gutter py-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
          role="group"
          aria-labelledby="wizard-title-ideas"
          data-testid="title-suggestions-row"
        >
          {TITLE_SUGGESTIONS.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => onTitleChange(s)}
              aria-pressed={title === s}
              className={CHIP_CLASS}
              style={{ "--i": i } as React.CSSProperties}
              data-testid={`title-suggestion-${i}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
