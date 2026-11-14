// Wizard step 2 "What's this book for?" (M19 T3, D-071): six compact occasion cards (2 columns at
// 375 px, 3 from sm) and a small optional "Captions in English / العربية" switch underneath.
// Radio names are prefixed "wizard-" so only the step-4 hidden inputs reach the create action.

import { Baby, Ellipsis, Gem, GraduationCap, Plane, Users, type LucideIcon } from "lucide-react";
import { ChoiceCard } from "@/components/wizard/ChoiceCard";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { CAPTION_LANG_LABELS, CAPTION_LANGS, OCCASION_LABELS, OCCASIONS, type CaptionLang, type Occasion } from "@/lib/book/options";
import { wizardHeadline } from "@/lib/books/wizard-steps";

const OCCASION_ICONS: Record<Occasion, LucideIcon> = {
  wedding: Gem,
  travel: Plane,
  baby: Baby,
  graduation: GraduationCap,
  family: Users,
  other: Ellipsis,
};

const SEGMENT_CLASS =
  "relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg px-3 text-sm text-muted-foreground select-none has-checked:bg-card has-checked:font-medium has-checked:text-foreground has-checked:shadow-card has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-background";

export type StepOccasionProps = {
  occasion: Occasion | null;
  captionLang: CaptionLang;
  onOccasion: (occasion: Occasion) => void;
  onCaptionLang: (lang: CaptionLang) => void;
  headlineId: string;
  /** Server field errors (occasion / caption language). */
  error?: string;
};

export function StepOccasion({ occasion, captionLang, onOccasion, onCaptionLang, headlineId, error }: StepOccasionProps) {
  return (
    <div className="flex flex-col gap-6">
      <WizardHeadline id={headlineId} focusable>
        {wizardHeadline(2)}
      </WizardHeadline>
      <fieldset className="min-w-0" aria-describedby={error ? "wizard-occasion-error" : undefined}>
        <legend className="sr-only">Occasion</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="occasion-grid">
          {OCCASIONS.map((id) => {
            const Icon = OCCASION_ICONS[id];
            return (
              <ChoiceCard
                key={id}
                name="wizard-occasion"
                value={id}
                label={OCCASION_LABELS[id]}
                media={<Icon aria-hidden="true" strokeWidth={1.5} />}
                checked={occasion === id}
                onChange={() => onOccasion(id)}
                size="compact"
                testId={`occasion-${id}`}
              />
            );
          })}
        </div>
        {error ? (
          <p id="wizard-occasion-error" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="mx-auto flex w-full max-w-xs min-w-0 flex-col items-center gap-2">
        <legend className="mb-2 w-full text-center text-sm text-muted-foreground">
          Captions in <span className="text-muted-foreground/80">(optional)</span>
        </legend>
        <div className="grid w-full grid-cols-2 gap-1 rounded-xl bg-muted p-1" data-testid="caption-lang">
          {CAPTION_LANGS.map((id) => (
            <label key={id} className={SEGMENT_CLASS}>
              <input
                type="radio"
                name="wizard-captionLang"
                value={id}
                checked={captionLang === id}
                onChange={() => onCaptionLang(id)}
                className="absolute inset-0 cursor-pointer opacity-0"
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
      </fieldset>
    </div>
  );
}
