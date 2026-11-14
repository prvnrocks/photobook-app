// Wizard step 1 "Give your book a title" (M19 T3, D-071). A decorative hard cover (CSS + inline SVG,
// original art: emerald leather, gold foil frame, a seaside photo window) shows the title as it is
// typed, then the title field. Empty is fine (we suggest one); the counter appears near the limit.
// No hooks beyond the parent's state and no cn/next/link (first-load client island).

import { TITLE_MAX_CHARS, titleLength } from "@/app/books/form-state";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { wizardHeadline } from "@/lib/books/wizard-steps";

/** The counter appears once the title gets close to the limit (as the old New book form). */
export const TITLE_COUNTER_FROM = 100;

export const TITLE_TOO_LONG = `Title must be ${TITLE_MAX_CHARS} characters or fewer.`;

const INPUT_CLASS =
  "h-12 w-full min-w-0 rounded-xl border border-input bg-card px-4 text-base shadow-card outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/60 aria-invalid:border-destructive";

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

  return (
    <div className="flex flex-col items-center gap-6">
      <CoverArt title={title} />
      <WizardHeadline id={headlineId} focusable>
        {wizardHeadline(1)}
      </WizardHeadline>
      <div className="flex w-full min-w-0 flex-col gap-2">
        <label htmlFor="wizard-title" className="text-base font-medium text-foreground">
          Book title
        </label>
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
        <div className="flex items-start justify-between gap-3 text-sm text-muted-foreground">
          <p id="wizard-title-hint">You can change it later.</p>
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
    </div>
  );
}

/** A tilted emerald hard cover with a gold foil frame and a photo window; shows the typed title. */
function CoverArt({ title }: { title: string }) {
  const shown = title.trim();
  return (
    <div aria-hidden="true" className="pt-2 [perspective:900px]" data-testid="wizard-cover-art">
      <div className="relative w-40 [transform:rotateY(-14deg)_rotateX(4deg)] sm:w-48">
        {/* page block peeking out at the fore-edge */}
        <div className="absolute inset-y-1.5 -end-1.5 w-3 rounded-e-sm bg-[repeating-linear-gradient(90deg,#fffdf8_0_1px,#e5dccb_1px_2px)]" />
        <div className="home-leather relative flex aspect-[3/4] flex-col items-center gap-3 overflow-hidden rounded-s-[3px] rounded-e-md px-4 pt-5 pb-4 shadow-[0_18px_30px_-12px_rgb(14_59_46/0.55),0_4px_10px_-4px_rgb(14_59_46/0.35)]">
          {/* spine shade */}
          <span className="absolute inset-y-0 start-0 w-3 bg-gradient-to-r from-black/30 to-transparent" />
          {/* gold foil frame */}
          <span className="absolute inset-2 rounded-sm border border-[#c9a227]/70" />
          <p
            className="relative z-10 line-clamp-2 min-h-[2.5em] w-full text-center font-display text-base leading-tight font-semibold break-words text-[#e3c766] sm:text-lg"
            data-testid="wizard-cover-title"
          >
            <span dir="auto">{shown || "Your book"}</span>
          </p>
          <SeaWindow />
          <span className="home-foil-h relative z-10 mt-auto block h-px w-10" />
        </div>
      </div>
    </div>
  );
}

/** Original seaside scene: sky, sun, hills, sea and a white house with a dome. */
function SeaWindow() {
  return (
    <svg viewBox="0 0 120 84" className="relative z-10 w-full rounded-[2px] ring-1 ring-[#c9a227]/60" focusable="false">
      <defs>
        <linearGradient id="wiz-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6e7c8" />
          <stop offset="1" stopColor="#cfe3e6" />
        </linearGradient>
        <linearGradient id="wiz-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2f7f8f" />
          <stop offset="1" stopColor="#1f5f6b" />
        </linearGradient>
      </defs>
      <rect width="120" height="84" fill="url(#wiz-sky)" />
      <circle cx="92" cy="22" r="8" fill="#e8c46a" opacity="0.9" />
      <path d="M0 50 C18 38 34 40 52 46 C70 52 88 36 120 42 V60 H0 Z" fill="#9db58d" />
      <rect y="56" width="120" height="28" fill="url(#wiz-sea)" />
      <path d="M8 66 h14 M40 72 h18 M78 64 h12 M96 74 h14" stroke="#cfe8ea" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
      {/* house + dome on the hill */}
      <rect x="22" y="40" width="20" height="16" fill="#fffdf8" />
      <path d="M26 40 a6 6 0 0 1 12 0 Z" fill="#2c6fa3" />
      <rect x="29" y="47" width="5" height="9" fill="#2c6fa3" opacity="0.8" />
      <rect x="44" y="45" width="12" height="11" fill="#fffdf8" />
      <rect x="47" y="48" width="3" height="3" fill="#2c6fa3" opacity="0.7" />
      {/* bougainvillea */}
      <circle cx="18" cy="52" r="4" fill="#c2457a" />
      <circle cx="14" cy="49" r="3" fill="#d4588c" />
      <circle cx="20" cy="47" r="2.5" fill="#b83a6e" />
    </svg>
  );
}
