// Wizard step 3 "Choose a page shape" (M19 T4, D-071): two large cards, Portrait / Landscape, with
// the enlarged ShapePreview art. Locked design (T8 edit mode, D-070): only the current shape, read-only.

import { ShapePreview } from "@/components/books/DesignPreview";
import { ChoiceCard } from "@/components/wizard/ChoiceCard";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { wizardHeadline, type WizardFormat } from "@/lib/books/wizard-steps";
import { FORM_FORMATS, FORMAT_HINTS, FORMAT_SHORT_LABELS } from "@/lib/design/defaults";
import { DesignLockedNote } from "./DesignLockedNote";

/** Card art sized by height (the card variant's viewBox hugs the page): ~2/3 of the card. */
const SHAPE_ART: Record<WizardFormat, string> = {
  A5_PORTRAIT: "h-36 max-w-full sm:h-56",
  A5_LANDSCAPE: "h-[6.5rem] max-w-full sm:h-40",
};

export type StepShapeProps = {
  format: WizardFormat | null;
  onFormat: (format: WizardFormat) => void;
  headlineId: string;
  /** Shape can't change any more: show the current one read-only with a note. Defensive only — never true today (see DesignLockedNote). */
  locked?: boolean;
  error?: string;
};

export function StepShape({ format, onFormat, headlineId, locked = false, error }: StepShapeProps) {
  const options = locked && format ? [format] : FORM_FORMATS;
  return (
    <div className="flex flex-col gap-6">
      <WizardHeadline id={headlineId} focusable>
        {wizardHeadline(3)}
      </WizardHeadline>
      {locked ? <DesignLockedNote /> : null}
      <fieldset className="min-w-0" aria-describedby={error ? "wizard-format-error" : undefined}>
        <legend className="sr-only">Page shape</legend>
        <div className={locked ? "mx-auto grid w-full max-w-[18rem] grid-cols-1" : "grid grid-cols-2 gap-3 sm:gap-4"}>
          {options.map((id) => (
            <ChoiceCard
              key={id}
              name="wizard-format"
              value={id}
              label={FORMAT_SHORT_LABELS[id]}
              hint={FORMAT_HINTS[id]}
              media={
                // One art box height for both cards (the portrait's), so the labels line up.
                <span className="flex h-36 w-full items-center justify-center sm:h-56">
                  <ShapePreview format={id} variant="card" className={SHAPE_ART[id]} />
                </span>
              }
              checked={format === id}
              onChange={locked ? undefined : () => onFormat(id)}
              size="large"
              testId={`format-${id}`}
            />
          ))}
        </div>
        {error ? (
          <p id="wizard-format-error" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
