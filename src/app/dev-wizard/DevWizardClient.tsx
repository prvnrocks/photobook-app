"use client";
// Client half of /dev-wizard (dev only): the real step components inside the real band / body, with
// stubbed actions. See page.tsx.

import { useCallback, useState } from "react";
import { StepOccasion } from "@/components/books/wizard/StepOccasion";
import { WizardPreviewAside } from "@/components/books/wizard/WizardBookPreview";
import { StepDesign } from "@/components/books/wizard/steps/StepDesign";
import { StepStory, type StoryDraft } from "@/components/books/wizard/steps/StepStory";
import { WizardBand } from "@/components/wizard/WizardBand";
import { WizardBody } from "@/components/wizard/WizardBody";
import type { Occasion } from "@/lib/book/options";
import { NO_DESIGN_PICK, resolveDesignChoice, type DesignPick, type StoredDesign } from "@/lib/books/design-choice";
import { defaultStyleFor } from "@/lib/design/defaults";
import { recommendDesign, type DesignRecommendation } from "@/lib/design/recommend";
import { EMPTY_STORY_ANSWERS, type RecommendDesignResult, type StoryAnswersResult } from "@/lib/story/answers";
import { storyQuestionsFor } from "@/lib/story/questions";

export type DevWizardStep = "story" | "design" | "occasion";
export type DevWizardRec = "landscape" | "portrait" | "mixed" | "none";

const TITLE = "Days by the Sea";
const BOOK = "00000000-0000-4000-8000-000000000000";

const sizes = (n: number, width: number, height: number) => Array.from({ length: n }, () => ({ width, height }));
const PHOTOS: Record<Exclude<DevWizardRec, "none">, { width: number; height: number }[]> = {
  landscape: sizes(10, 1600, 1067),
  portrait: sizes(10, 1067, 1600),
  mixed: [...sizes(5, 1600, 1067), ...sizes(5, 1067, 1600)],
};

const loadStub = async (): Promise<StoryAnswersResult> => ({ ok: true, context: { ...EMPTY_STORY_ANSWERS, answers: [] } });
const saveStub = async (): Promise<StoryAnswersResult> => ({ ok: true, context: { ...EMPTY_STORY_ANSWERS, answers: [], rev: 1 } });

function filledStory(occasion: Occasion | null): StoryDraft {
  // v3: q1 = who is in the photos (chips), q2 = one short memory
  const [, q1, q2] = storyQuestionsFor(occasion);
  const answers: Record<string, string> = {};
  if (q1) answers[q1.id] = q1.suggestions[1] ?? q1.suggestions[0] ?? "";
  if (q2) answers[q2.id] = "The night we watched the sun go down from the old harbour";
  return { storyTone: "heartfelt", answers, touched: true, loaded: "loaded" };
}

export function DevWizardClient({
  step,
  occasion,
  rec,
  fill,
}: {
  step: DevWizardStep;
  occasion: Occasion | null;
  rec: DevWizardRec;
  fill: boolean;
}) {
  const [story, setStory] = useState<StoryDraft | null>(() => (fill ? filledStory(occasion) : null));
  const [pick, setPick] = useState<DesignPick>(NO_DESIGN_PICK);
  const [recommendation, setRecommendation] = useState<DesignRecommendation | null>(null);
  const [picked, setPicked] = useState<Occasion | null>(occasion);
  const [note, setNote] = useState("");
  const stored: StoredDesign = { format: "A5_PORTRAIT", designStyle: defaultStyleFor(occasion) };
  const chosen = resolveDesignChoice({ stored, pick, recommendation, occasion });
  // Stable identity: StepDesign asks again whenever `recommend` changes.
  const recommend = useCallback(
    async (): Promise<RecommendDesignResult> =>
      rec === "none"
        ? { ok: false, error: "unavailable" }
        : { ok: true, recommendation: recommendDesign({ occasion, photos: PHOTOS[rec] }) },
    [rec, occasion],
  );

  const stepNumber = step === "occasion" ? 2 : step === "story" ? 4 : 5;
  return (
    <div className="flex min-h-dvh flex-col bg-background" data-testid="dev-wizard">
      <main className="flex w-full flex-1 flex-col">
        <div className="flex w-full min-w-0 flex-1 flex-col" data-testid="new-book-wizard" data-step={stepNumber}>
          <WizardBand step={stepNumber} title={TITLE} />
          <WizardBody
            wide
            aside={
              <WizardPreviewAside
                title={TITLE}
                occasion={step === "occasion" ? picked : occasion}
                format={step === "design" ? chosen.format : null}
                designStyle={step === "design" ? chosen.designStyle : null}
                open={step === "design"}
                typing={false}
              />
            }
            asideBelowLg="hide"
          >
            {step === "occasion" ? (
              <form className="flex w-full min-w-0 flex-col gap-8">
                <StepOccasion occasion={picked} onOccasion={setPicked} headlineId="wizard-headline" />
              </form>
            ) : step === "story" ? (
              <StepStory
                bookId={BOOK}
                occasion={occasion}
                headlineId="wizard-headline"
                value={story}
                onChange={setStory}
                onBack={() => setNote("Back")}
                onContinue={() => setNote("Continue")}
                load={loadStub}
                save={saveStub}
              />
            ) : (
              <StepDesign
                bookId={BOOK}
                headlineId="wizard-headline"
                title={TITLE}
                occasion={occasion}
                stored={stored}
                pick={pick}
                onPick={setPick}
                recommendation={recommendation}
                onRecommendation={setRecommendation}
                onBack={() => setNote("Back")}
                onContinue={() => setNote("Create my book")}
                recommend={recommend}
              />
            )}
            <p className="sr-only" role="status" data-testid="dev-wizard-note">
              {note}
            </p>
          </WizardBody>
        </div>
      </main>
    </div>
  );
}
