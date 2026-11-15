// Wizard step 3 "Choose a page shape" (M19 T4, D-071; M20 T4, D-072): two big cards, Portrait /
// Landscape, each with a small 3D book wearing the user's cover (title + occasion emblem): the
// portrait one stands up, the landscape one lies wide, and both tilt toward the pointer / tap
// (CSS vars --tx/--ty set on pointer move; motion only, steps-motion.css). The chosen card shows a
// "fits …" hint over the art (absolute: no layout shift). Locked design (T8 edit mode, D-070): only
// the current shape, read-only.

import type { PointerEvent } from "react";
import { ChoiceCard } from "@/components/wizard/ChoiceCard";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import type { Occasion } from "@/lib/book/options";
import { wizardHeadline, type WizardFormat } from "@/lib/books/wizard-steps";
import { FORM_FORMATS, FORMAT_HINTS, FORMAT_SHORT_LABELS } from "@/lib/design/defaults";
import { DesignLockedNote } from "./DesignLockedNote";
import { CoverFront, isArabicTitle } from "./WizardBookPreview";
import "./steps-motion.css";

/** What each shape suits, shown on the selected card. */
export const FORMAT_FITS: Record<WizardFormat, string> = {
  A5_PORTRAIT: "Fits phone photos",
  A5_LANDSCAPE: "Fits landscapes",
};

export type StepShapeProps = {
  format: WizardFormat | null;
  onFormat: (format: WizardFormat) => void;
  headlineId: string;
  /** Shape can't change any more: show the current one read-only with a note. Defensive only — never true today (see DesignLockedNote). */
  locked?: boolean;
  error?: string;
  /** The draft so far, drawn on the little books' covers. */
  title?: string;
  occasion?: Occasion | null;
};

function onTilt(e: PointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const x = (e.clientX - r.left) / r.width - 0.5;
  const y = (e.clientY - r.top) / r.height - 0.5;
  e.currentTarget.style.setProperty("--tx", x.toFixed(3));
  e.currentTarget.style.setProperty("--ty", y.toFixed(3));
}

function onTiltEnd(e: PointerEvent<HTMLElement>) {
  e.currentTarget.style.removeProperty("--tx");
  e.currentTarget.style.removeProperty("--ty");
}

export function StepShape({ format, onFormat, headlineId, locked = false, error, title = "", occasion = null }: StepShapeProps) {
  const options = locked && format ? [format] : FORM_FORMATS;
  const shown = title.trim();
  const arabic = isArabicTitle(shown);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <WizardHeadline id={headlineId} focusable>
          {wizardHeadline(3)}
        </WizardHeadline>
        <p className="text-center text-base text-muted-foreground">Pick the shape most of your photos are.</p>
      </div>
      {locked ? <DesignLockedNote /> : null}
      <fieldset className="min-w-0" aria-describedby={error ? "wizard-format-error" : undefined}>
        <legend className="sr-only">Page shape</legend>
        <div className={locked ? "mx-auto grid w-full max-w-[18rem] grid-cols-1" : "grid grid-cols-2 gap-3 sm:gap-5"}>
          {options.map((id) => (
            <div key={id} className="flex min-w-0" onPointerMove={onTilt} onPointerDown={onTilt} onPointerLeave={onTiltEnd} data-testid={`format-tilt-${id}`}>
              <ChoiceCard
                name="wizard-format"
                value={id}
                label={FORMAT_SHORT_LABELS[id]}
                hint={FORMAT_HINTS[id]}
                media={
                  // One art box height for both cards, so the labels line up. Book sizes are in em.
                  <span className="ws-shape-art relative flex h-40 w-full items-center justify-center text-[15px] sm:h-60 sm:text-[23px]">
                    <span className="ws-book" data-format={id}>
                      <span className="ws-book-pages" />
                      <CoverFront title={shown} arabic={arabic} occasion={occasion} />
                    </span>
                    <span
                      className="ws-shape-fit absolute inset-x-0 bottom-0 mx-auto w-max max-w-full rounded-full bg-success px-3 py-1 text-xs font-semibold text-white shadow-card"
                      data-testid={`format-fit-${id}`}
                    >
                      {FORMAT_FITS[id]}
                    </span>
                  </span>
                }
                checked={format === id}
                onChange={locked ? undefined : () => onFormat(id)}
                size="large"
                testId={`format-${id}`}
                className="w-full"
              />
            </div>
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
