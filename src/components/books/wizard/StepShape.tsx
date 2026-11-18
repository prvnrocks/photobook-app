// The page-shape choice of the wizard's Design step (M19 T4, D-071; M20 T4, D-072; Task 5: one part
// of step 5, after the photos): two big cards, Portrait / Landscape, each with a small 3D book
// wearing the user's cover (title + occasion emblem): the portrait one stands up, the landscape one
// lies wide, and both tilt toward the pointer / tap (CSS vars --tx/--ty set on pointer move; motion
// only, steps-motion.css). The chosen card shows a "fits …" hint over the art (absolute: no layout
// shift). `recommended` puts a "Recommended" badge on that card and `reason` one plain line under the
// legend — a suggestion only, the user picks. Locked design (D-070): only the current shape, read-only.

import type { PointerEvent } from "react";
import { ChoiceCard } from "@/components/wizard/ChoiceCard";
import type { Occasion } from "@/lib/book/options";
import { RECOMMENDED_BADGE } from "@/lib/books/design-choice";
import type { WizardFormat } from "@/lib/books/wizard-steps";
import { FORM_FORMATS, FORMAT_HINTS, FORMAT_SHORT_LABELS } from "@/lib/design/defaults";
import { CoverFront, isArabicTitle } from "./WizardBookPreview";
import "./steps-motion.css";

/** What each shape suits, shown on the selected card. */
export const FORMAT_FITS: Record<WizardFormat, string> = {
  A5_PORTRAIT: "Fits phone photos",
  A5_LANDSCAPE: "Fits landscapes",
};

export type ShapeChoicesProps = {
  format: WizardFormat | null;
  onFormat: (format: WizardFormat) => void;
  /** Shape can't change any more: show the current one read-only. Defensive only — never true today (see DesignLockedNote). */
  locked?: boolean;
  error?: string;
  /** The book so far, drawn on the little books' covers. */
  title?: string;
  occasion?: Occasion | null;
  /** The recommended shape (badge on its card); null / omitted = no badge. */
  recommended?: WizardFormat | null;
  /** One plain line saying why (shown only with `recommended`). */
  reason?: string | null;
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

export function ShapeChoices({
  format,
  onFormat,
  locked = false,
  error,
  title = "",
  occasion = null,
  recommended = null,
  reason = null,
}: ShapeChoicesProps) {
  const options = locked && format ? [format] : FORM_FORMATS;
  const shown = title.trim();
  const arabic = isArabicTitle(shown);
  const showReason = !locked && recommended !== null && !!reason;
  const describedBy = [showReason ? "wizard-format-reason" : null, error ? "wizard-format-error" : null].filter(Boolean).join(" ");
  return (
    <fieldset className="min-w-0" aria-describedby={describedBy || undefined} data-testid="design-shape">
      <legend className="type-h2 w-full text-center text-heading">Page shape</legend>
      {showReason ? (
        <p id="wizard-format-reason" className="type-small mt-1 text-center text-muted-foreground" data-testid="format-reason">
          {reason}
        </p>
      ) : null}
      <div className={locked ? "mx-auto mt-3 grid w-full max-w-[18rem] grid-cols-1" : "mt-3 grid grid-cols-2 gap-3 sm:gap-5"}>
        {options.map((id) => (
          <div key={id} className="flex min-w-0" onPointerMove={onTilt} onPointerDown={onTilt} onPointerLeave={onTiltEnd} data-testid={`format-tilt-${id}`}>
            <ChoiceCard
              name="wizard-format"
              value={id}
              label={FORMAT_SHORT_LABELS[id]}
              hint={FORMAT_HINTS[id]}
              badge={!locked && recommended === id ? RECOMMENDED_BADGE : undefined}
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
              // Tapping the card that is already shown as selected makes it the user's own choice too.
              onPick={locked ? undefined : () => onFormat(id)}
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
  );
}
