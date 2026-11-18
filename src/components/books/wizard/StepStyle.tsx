// The book-style choice of the wizard's Design step (M19 T4, D-071; M20 T4, D-072; M30 T12, D-090;
// Task 5: one part of step 5): six large cards (2 × 3 at 375 px, 3 × 2 from sm), each a two-page
// spread of that style drawn in the chosen shape. With motion the spread is closed (one page) and
// slides open on hover / when selected; reduced motion shows every spread open (steps-motion.css).
// The chosen style also tints the live preview, which opens to that spread. `recommended` puts a
// "Recommended" badge on that card and `reason` one plain line under the legend — a suggestion only.
// Locked design: only the current style, read-only.
// <StyleChoices> is the fieldset used by StepDesign; <StepStyle> wraps it with a headline for the
// static style board (/dev-style).

import { StylePreview } from "@/components/books/DesignPreview";
import { ChoiceCard } from "@/components/wizard/ChoiceCard";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { RECOMMENDED_BADGE } from "@/lib/books/design-choice";
import type { WizardFormat } from "@/lib/books/wizard-steps";
import { DESIGN_STYLE_LABELS, FORM_DESIGN_STYLES, type FormDesignStyle } from "@/lib/design/defaults";
import { DesignLockedNote } from "./DesignLockedNote";
import "./steps-motion.css";

export type StyleChoicesProps = {
  /** The style shown as selected (the user's pick, else the recommendation / the occasion default). */
  designStyle: FormDesignStyle;
  format: WizardFormat;
  /** Omit for a static, server-rendered demo (/dev-style): the radios are then uncontrolled. */
  onStyle?: (style: FormDesignStyle) => void;
  /** Defensive only — never true today (see DesignLockedNote). */
  locked?: boolean;
  error?: string;
  /** The recommended style (badge on its card); null / omitted = no badge. */
  recommended?: FormDesignStyle | null;
  /** One plain line saying why (shown only with `recommended`). */
  reason?: string | null;
  /** "visible" (default): a section heading; "hidden": screen readers only (a headline sits above). */
  legend?: "visible" | "hidden";
};

export function StyleChoices({
  designStyle,
  format,
  onStyle,
  locked = false,
  error,
  recommended = null,
  reason = null,
  legend = "visible",
}: StyleChoicesProps) {
  const options = locked ? [designStyle] : FORM_DESIGN_STYLES;
  const showReason = !locked && recommended !== null && !!reason;
  const describedBy = [showReason ? "wizard-style-reason" : null, error ? "wizard-style-error" : null].filter(Boolean).join(" ");
  return (
    <fieldset className="min-w-0" aria-describedby={describedBy || undefined} data-testid="design-style">
      <legend className={legend === "hidden" ? "sr-only" : "type-h2 w-full text-center text-heading"}>Book style</legend>
      {showReason ? (
        <p id="wizard-style-reason" className="type-small mt-1 text-center text-muted-foreground" data-testid="style-reason">
          {reason}
        </p>
      ) : null}
      <div
        className={
          locked
            ? "mx-auto mt-3 grid w-full max-w-[18rem] grid-cols-1"
            : legend === "hidden"
              ? "grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5"
              : "mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5"
        }
      >
        {options.map((id) => (
          <ChoiceCard
            key={id}
            name="wizard-designStyle"
            value={id}
            label={DESIGN_STYLE_LABELS[id]}
            badge={!locked && recommended === id ? RECOMMENDED_BADGE : undefined}
            media={
              // Reserved height per shape (steps-motion.css .ws-spread-box); the spread fits inside it.
              <span className="ws-spread-box" data-format={format}>
                <span className="ws-spread" data-testid={`style-spread-${id}`}>
                  <span className="ws-spread-page ws-spread-left">
                    <StylePreview style={id} format={format} variant="card" className="h-auto w-full" />
                  </span>
                  <span className="ws-spread-page ws-spread-right">
                    <StylePreview style={id} format={format} variant="card" className="h-auto w-full" />
                  </span>
                </span>
              </span>
            }
            checked={onStyle || locked ? designStyle === id : undefined}
            defaultChecked={onStyle || locked ? undefined : designStyle === id}
            onChange={locked || !onStyle ? undefined : () => onStyle(id)}
            onPick={locked || !onStyle ? undefined : () => onStyle(id)}
            size="large"
            testId={`style-${id}`}
          />
        ))}
      </div>
      {error ? (
        <p id="wizard-style-error" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export type StepStyleProps = Omit<StyleChoicesProps, "legend" | "recommended" | "reason"> & { headlineId: string };

/** The style cards under their own headline (the /dev-style board). */
export function StepStyle({ headlineId, locked = false, ...choices }: StepStyleProps) {
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div className="flex flex-col gap-2">
        <WizardHeadline id={headlineId} focusable>
          Choose a book style
        </WizardHeadline>
        <p className="text-center text-base text-muted-foreground">Each style comes with its own page layouts.</p>
      </div>
      {locked ? <DesignLockedNote /> : null}
      <StyleChoices {...choices} locked={locked} legend="hidden" />
    </div>
  );
}
