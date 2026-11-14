// Wizard step 4 "Choose a book style" (M19 T4, D-071): four large cards (2×2, also at 375 px) with the
// StylePreview art drawn in the chosen shape. Until the user picks, the occasion's default style is
// selected (D-068, effectiveStyle). Locked design (T8 edit mode): only the current style, read-only.

import { StylePreview } from "@/components/books/DesignPreview";
import { ChoiceCard } from "@/components/wizard/ChoiceCard";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { wizardHeadline, type WizardFormat } from "@/lib/books/wizard-steps";
import { DESIGN_STYLE_LABELS, FORM_DESIGN_STYLES, type FormDesignStyle } from "@/lib/design/defaults";
import { DesignLockedNote } from "./DesignLockedNote";

/** Card art sized by height (the card variant's viewBox hugs the page): ~2/3 of the card. */
const STYLE_ART: Record<WizardFormat, string> = {
  A5_PORTRAIT: "h-32 max-w-full sm:h-48",
  A5_LANDSCAPE: "h-24 max-w-full sm:h-36",
};

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
    <div className="flex flex-col gap-6">
      <WizardHeadline id={headlineId} focusable>
        {wizardHeadline(4)}
      </WizardHeadline>
      {locked ? <DesignLockedNote /> : null}
      <fieldset className="min-w-0" aria-describedby={error ? "wizard-style-error" : undefined}>
        <legend className="sr-only">Book style</legend>
        <div className={locked ? "mx-auto grid w-full max-w-[18rem] grid-cols-1" : "grid grid-cols-2 gap-3 sm:gap-4"}>
          {options.map((id) => (
            <ChoiceCard
              key={id}
              name="wizard-designStyle"
              value={id}
              label={DESIGN_STYLE_LABELS[id]}
              media={<StylePreview style={id} format={format} variant="card" className={STYLE_ART[format]} />}
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
