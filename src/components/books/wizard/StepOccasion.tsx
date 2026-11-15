// Wizard step 2 "What's this book for?" (M19 T3, D-071; M20 T4, D-072): six occasion tiles with big
// icons in emerald circles (2 columns at 375 px, 3 from sm). They rise in one after another; the
// chosen tile glows emerald and its icon does a small wiggle (steps-motion.css). The caption language
// is no longer asked: the server picks it (Arabic-script title → memory → browser → English, D-072).
// Radio names are prefixed "wizard-" so only the step-4 hidden inputs reach the create action.

import { Baby, Ellipsis, Gem, GraduationCap, Plane, Users, type LucideIcon } from "lucide-react";
import { ChoiceCard } from "@/components/wizard/ChoiceCard";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { OCCASION_LABELS, OCCASIONS, type Occasion } from "@/lib/book/options";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import "./steps-motion.css";

const OCCASION_ICONS: Record<Occasion, LucideIcon> = {
  wedding: Gem,
  travel: Plane,
  baby: Baby,
  graduation: GraduationCap,
  family: Users,
  other: Ellipsis,
};

export type StepOccasionProps = {
  occasion: Occasion | null;
  onOccasion: (occasion: Occasion) => void;
  headlineId: string;
  /** Server field error for the occasion. */
  error?: string;
};

export function StepOccasion({ occasion, onOccasion, headlineId, error }: StepOccasionProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <WizardHeadline id={headlineId} focusable>
          {wizardHeadline(2)}
        </WizardHeadline>
        <p className="text-center text-base text-muted-foreground">We&apos;ll match the style and the words to it.</p>
      </div>
      <fieldset className="ws-occ min-w-0" aria-describedby={error ? "wizard-occasion-error" : undefined}>
        <legend className="sr-only">Occasion</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4" data-testid="occasion-grid">
          {OCCASIONS.map((id, i) => {
            const Icon = OCCASION_ICONS[id];
            return (
              <div key={id} className="ws-rise flex min-w-0" style={{ "--i": i } as React.CSSProperties}>
                <ChoiceCard
                  name="wizard-occasion"
                  value={id}
                  label={OCCASION_LABELS[id]}
                  media={
                    <span className="ws-occ-icon">
                      <Icon aria-hidden="true" strokeWidth={1.75} />
                    </span>
                  }
                  checked={occasion === id}
                  onChange={() => onOccasion(id)}
                  size="compact"
                  testId={`occasion-${id}`}
                  className="w-full"
                />
              </div>
            );
          })}
        </div>
        {error ? (
          <p id="wizard-occasion-error" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
