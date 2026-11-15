// Wizard step 4 "Choose a book style" (M19 T4, D-071; M20 T4, D-072): four large cards (2×2, also at
// 375 px), each a two-page spread of that style drawn in the chosen shape. With motion the spread is
// closed (one page) and slides open on hover / when selected; reduced motion shows every spread open
// (steps-motion.css). The chosen style also tints the live preview, which opens to that spread.
// Until the user picks, the occasion's default style is selected (D-068, effectiveStyle). Locked
// design (T8 edit mode): only the current style, read-only.

import { StylePreview } from "@/components/books/DesignPreview";
import { ChoiceCard } from "@/components/wizard/ChoiceCard";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { wizardHeadline, type WizardFormat } from "@/lib/books/wizard-steps";
import { DESIGN_STYLE_LABELS, FORM_DESIGN_STYLES, type FormDesignStyle } from "@/lib/design/defaults";
import { DesignLockedNote } from "./DesignLockedNote";
import "./steps-motion.css";

export type StepStyleProps = {
  /** The style shown as selected (the user's pick, else the occasion default). */
  designStyle: FormDesignStyle;
  format: WizardFormat;
  onStyle: (style: FormDesignStyle) => void;
  headlineId: string;
  /** Defensive only — never true today (see DesignLockedNote). */
  locked?: boolean;
  error?: string;
};

export function StepStyle({ designStyle, format, onStyle, headlineId, locked = false, error }: StepStyleProps) {
  const options = locked ? [designStyle] : FORM_DESIGN_STYLES;
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div className="flex flex-col gap-2">
        <WizardHeadline id={headlineId} focusable>
          {wizardHeadline(4)}
        </WizardHeadline>
        <p className="text-center text-base text-muted-foreground">Each style comes with its own page layouts.</p>
      </div>
      {locked ? <DesignLockedNote /> : null}
      <fieldset className="min-w-0" aria-describedby={error ? "wizard-style-error" : undefined}>
        <legend className="sr-only">Book style</legend>
        <div className={locked ? "mx-auto grid w-full max-w-[18rem] grid-cols-1" : "grid grid-cols-2 gap-3 sm:gap-5"}>
          {options.map((id) => (
            <ChoiceCard
              key={id}
              name="wizard-designStyle"
              value={id}
              label={DESIGN_STYLE_LABELS[id]}
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
              checked={designStyle === id}
              onChange={locked ? undefined : () => onStyle(id)}
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
    </div>
  );
}
