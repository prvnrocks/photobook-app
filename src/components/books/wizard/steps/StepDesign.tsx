"use client";
// Wizard step 5 "Choose your book design" (Task 5): page shape + book style on one screen, chosen
// AFTER the photos are in, so both can be recommended (recommendDesignAction on entry: the shape from
// what most photos look like, the style from the occasion). The recommended cards carry a
// "Recommended" badge and one plain reason line; the recommendation is preselected only for a field
// the user hasn't picked (src/lib/books/design-choice.ts) — a manual pick always wins, also over a
// later recommendation. If the recommendation can't be loaded the step simply works without badges.
// Nothing is saved here: Continue hands over to the wizard (save when the design differs from the
// stored book, then ask for the first build → step 6). Reuses the M19/M20 cards (ShapeChoices,
// StyleChoices). Lazy-loaded with the other book steps (not in the /books/new first load).

import { useEffect, useRef, type FormEvent } from "react";
import { recommendDesignAction } from "@/app/books/story-actions";
import { Notice } from "@/components/app/Notice";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { WizardNav } from "@/components/wizard/WizardNav";
import type { Occasion } from "@/lib/book/options";
import {
  recommendedChoice,
  resolveDesignChoice,
  shapeReasonText,
  styleReasonText,
  type DesignPick,
  type StoredDesign,
} from "@/lib/books/design-choice";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import type { DesignRecommendation } from "@/lib/design/recommend";
import type { RecommendDesignResult } from "@/lib/story/answers";
import { DesignLockedNote } from "../DesignLockedNote";
import { ShapeChoices } from "../StepShape";
import { StyleChoices } from "../StepStyle";

export type StepDesignProps = {
  bookId: string;
  /** id of the step headline (focused after a step change). */
  headlineId: string;
  /** Drawn on the little books' covers. */
  title: string;
  occasion: Occasion | null;
  /** The book's stored design (provisional until the user saves another). */
  stored: StoredDesign;
  /** The user's own picks on this step (null per field = not chosen yet). */
  pick: DesignPick;
  onPick: (pick: DesignPick) => void;
  /** The last recommendation the wizard holds (shown at once on re-entry; refreshed on entry). */
  recommendation: DesignRecommendation | null;
  onRecommendation: (recommendation: DesignRecommendation) => void;
  /** Defensive only — never true today (see DesignLockedNote). */
  locked?: boolean;
  /** The design couldn't be saved. */
  error?: string | null;
  /** The build couldn't start (limit / connection): Continue asks again. */
  buildError?: string | null;
  /** Saving / asking for the build. */
  pending?: boolean;
  onBack: () => void;
  onContinue: () => void;
  /** Test seam; defaults to the server action. */
  recommend?: (bookId: string) => Promise<RecommendDesignResult>;
};

export function StepDesign({
  bookId,
  headlineId,
  title,
  occasion,
  stored,
  pick,
  onPick,
  recommendation,
  onRecommendation,
  locked = false,
  error = null,
  buildError = null,
  pending = false,
  onBack,
  onContinue,
  recommend = recommendDesignAction,
}: StepDesignProps) {
  const onRecommendationRef = useRef(onRecommendation);
  useEffect(() => {
    onRecommendationRef.current = onRecommendation;
  });

  // On entry: ask for the recommendation (the photos may have changed since the last visit). A failed
  // call changes nothing — the step works without badges (or keeps the earlier recommendation).
  useEffect(() => {
    if (locked) return;
    let alive = true;
    void Promise.resolve()
      .then(() => recommend(bookId))
      .then((res) => {
        if (alive && res.ok) onRecommendationRef.current(res.recommendation);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bookId, locked, recommend]);

  const chosen = resolveDesignChoice({ stored, pick, recommendation: locked ? null : recommendation, occasion });
  const rec = recommendedChoice(locked ? null : recommendation);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!pending) onContinue();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex w-full min-w-0 flex-col gap-8" data-testid="wizard-step-design">
      <div className="flex flex-col gap-2">
        <WizardHeadline id={headlineId} focusable>
          {wizardHeadline(5)}
        </WizardHeadline>
        <p className="text-center text-base text-muted-foreground" data-testid="design-intro">
          {rec.format || rec.designStyle
            ? "We marked what suits your photos. Choose what you like best."
            : "Choose the shape and style you like best."}
        </p>
      </div>

      {error ? (
        <Notice tone="error" data-testid="design-error">
          {error}
        </Notice>
      ) : null}
      {buildError ? (
        <Notice tone="error" data-testid="design-build-error">
          {buildError}
        </Notice>
      ) : null}
      {locked ? <DesignLockedNote /> : null}

      <ShapeChoices
        format={chosen.format}
        onFormat={(format) => onPick({ ...pick, format })}
        locked={locked}
        title={title}
        occasion={occasion}
        recommended={rec.format}
        reason={shapeReasonText(recommendation)}
      />
      <StyleChoices
        designStyle={chosen.designStyle}
        format={chosen.format}
        onStyle={(designStyle) => onPick({ ...pick, designStyle })}
        locked={locked}
        recommended={rec.designStyle}
        reason={styleReasonText(recommendation, occasion)}
      />

      <WizardNav
        onBack={onBack}
        continueLabel="Create my book"
        pendingLabel="Starting your book…"
        pending={pending}
        continueTestId="wizard-design-continue"
        className="mx-auto max-w-[36rem]"
      />
    </form>
  );
}
