"use client";

// Mounts the real StepStoryGeneration inside the wizard chrome with a stubbed job API (dev-only).

import { useMemo, useState } from "react";
import { StepStoryGeneration } from "@/components/books/wizard/steps/StepStoryGeneration";
import type { StoryRunApi } from "@/components/story/useStoryRun";
import { WizardBand } from "@/components/wizard/WizardBand";
import { WizardBody } from "@/components/wizard/WizardBody";
import type { WizardStep6Data } from "@/lib/books/wizard-client";
import { emptyStoryProgress, type StoryRunProgress, type StoryRunView } from "@/lib/storybook/run/progress";

export type DevStoryRunState = "running" | "failed" | "cancelled" | "starting" | "rule";

const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN = "00000000-0000-4000-8000-000000000801";
const TITLE = "Ten days by the water";

function progress(state: DevStoryRunState): StoryRunProgress {
  const p = emptyStoryProgress("writing");
  p.stages.discovering = { status: "done", done: 40, total: 40 };
  p.stages.organizing = { status: "done", moments: 7, chapters: 3 };
  if (state === "running") p.stages.writing = { status: "running", done: 1, chapters: 3 };
  if (state === "cancelled") {
    p.phase = "failed";
    p.stages.writing = { status: "failed", done: 1, chapters: 3 };
  }
  if (state === "failed") {
    p.phase = "failed";
    p.stages.writing = { status: "done", done: 3, chapters: 3 };
    p.stages.designing = { status: "failed" };
  }
  if (state === "rule") {
    p.phase = "done";
    p.stages.discovering = { status: "skipped" };
    p.stages.writing = { status: "skipped", chapters: 3 };
    p.stages.designing = { status: "done", pages: 18 };
    p.outcome = { ai: "none", notes: ["ai_off"], warnings: 0 };
  }
  return p;
}

function viewOf(state: DevStoryRunState): StoryRunView | null {
  if (state === "starting") return null;
  const failed = state === "failed" || state === "cancelled";
  return {
    runId: RUN,
    state: failed ? "failed" : state === "rule" ? "done" : "writing",
    progress: progress(state),
    done: failed || state === "rule",
    aiStatus: null,
    errorCode: state === "cancelled" ? "cancelled" : state === "failed" ? "conflict" : null,
    mode: state === "rule" ? "rule" : "replay",
  };
}

const never = <T,>() => new Promise<T>(() => {});

export function DevStoryRunClient({ state }: { state: DevStoryRunState }) {
  const [opened, setOpened] = useState(false);
  const data: WizardStep6Data = useMemo(
    () => ({
      step: 6,
      bookId: BOOK,
      title: TITLE,
      rawTitle: TITLE,
      occasion: "travel",
      format: "A5_PORTRAIT",
      designStyle: "classic",
      captionLang: "en",
      isPaid: false,
      aiOn: true,
      resolved: 6,
      story: viewOf(state),
      activeRunId: null,
      hasDoc: state === "failed",
      readError: false,
      trigger: "build",
      dailyCap: 3,
      auto: false,
      fanUrls: [],
    }),
    [state],
  );
  const api: StoryRunApi = useMemo(
    () => ({
      start: async () => (state === "starting" ? never() : { kind: "started" as const, runId: RUN, view: viewOf("running")! }),
      advance: () => never(),
      get: async () => ({ kind: "view" as const, view: viewOf("running")! }),
      cancel: async () => ({ kind: "view" as const, view: viewOf("cancelled")! }),
    }),
    [state],
  );
  return (
    <div className="flex min-h-dvh flex-col bg-background" data-testid="dev-story-run">
      <main className="flex w-full flex-1 flex-col">
        <div className="flex w-full min-w-0 flex-1 flex-col" data-testid="new-book-wizard" data-step={6}>
          <WizardBand step={6} title={TITLE} />
          <WizardBody>
            <StepStoryGeneration data={data} headlineId="wizard-headline" onDone={() => setOpened(true)} onOpenBook={data.hasDoc ? () => setOpened(true) : undefined} api={api} />
            <p className="sr-only" role="status" data-testid="dev-story-opened">
              {opened ? "editor" : ""}
            </p>
          </WizardBody>
        </div>
      </main>
    </div>
  );
}
