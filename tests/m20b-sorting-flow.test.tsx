// @vitest-environment jsdom
// M20b: after uploading, every first build goes through wizard step 6 Sorting → step 7 Review,
// in every AI mode (production runs AI off → rule builds).
//   - step 6 for a rule build: truthful rule wording, the rows play through over a short minimum
//     once the server confirmed "done" (reduced motion: at once), then "ready" → buildDone
//   - step 6 follows the Design step's hand-over (resolved or pending build-request answer; Task 5:
//     the request moved from the upload step to step-5 Continue) instead of POSTing
//   - ai_build_done { rules } fires once, from step 6 (moved from the upload screen)
//   - a failed rule run → the calm stop card without AI claims
//   - helpers: requestAutoBuildSettled (one retry), handoverStart mapping, replay rows
import { act, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoStartOutcome } from "@/lib/upload/auto-build-client";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  startRun: vi.fn(),
  getRun: vi.fn(),
  advanceRun: vi.fn(),
  fetchWizardStep: vi.fn(),
  track: vi.fn(),
  replace: vi.fn(),
  router: null as null | { push: () => void; replace: (h: string) => void; refresh: () => void },
}));

vi.mock("@/lib/runs/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/runs/client")>()),
  startRun: mocks.startRun,
  getRun: mocks.getRun,
  advanceRun: mocks.advanceRun,
}));
vi.mock("@/lib/books/wizard-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/books/wizard-client")>()),
  fetchWizardStep: mocks.fetchWizardStep,
}));
vi.mock("@/lib/analytics/client", () => ({ track: mocks.track, trackEvent: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => (mocks.router ??= { push: () => {}, replace: (h: string) => mocks.replace(h), refresh: () => {} }),
  usePathname: () => "/books/new",
}));
vi.mock("@/components/books/wizard/steps/StepPhotos", () => ({ StepPhotos: () => null }));
vi.mock("@/components/books/wizard/steps/StepReview", () => ({ StepReview: () => null }));

const { WIZARD_RULE_LABELS, wizardChecklist, wizardReplayChecklist, wizardPhaseOfRows } = await import(
  "@/lib/runs/build-checklist"
);
const { RULE_REPLAY_MS, RULE_REPLAY_MIN_ROW_MS, WIZARD_READY_COPY } = await import("@/components/review/BuildProgress");
const { READY_MS, READY_MS_REDUCED, resolveHandover, StepSorting } = await import("@/components/books/wizard/steps/StepSorting");
const { WizardDataSteps } = await import("@/components/books/wizard/steps/WizardDataSteps");
const { handoverStart, requestAutoBuildSettled, NOT_READY_RETRY_MS } = await import("@/lib/upload/auto-build-client");
type WizardStepDataMap = import("@/components/books/wizard/steps/WizardDataSteps").WizardStepDataMap;
type Step6 = import("@/lib/books/wizard-client").WizardStep6Data;
type Step7 = import("@/lib/books/wizard-client").WizardStep7Data;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const RUN2 = "33333333-3333-4333-8333-333333333333";

/** Step 6 data for an AI-off book whose rule build already finished (the gate says 7). */
const STEP6_OFF = {
  step: 6,
  bookId: BOOK,
  title: "Summer",
  rawTitle: "Summer",
  occasion: "travel",
  format: "a5_portrait",
  designStyle: "classic",
  captionLang: "en",
  isPaid: false,
  aiOn: false,
  resolved: 7,
  activeRunId: null,
  readError: false,
  trigger: "build",
  dailyCap: 3,
  auto: true,
  fanUrls: ["https://x/1.jpg", "https://x/2.jpg"],
} as unknown as Step6;
const STEP7 = { step: 7, bookId: BOOK, resolved: 7, counts: { kept: 12 } } as unknown as Step7;

const RULE_DONE: AutoStartOutcome = { kind: "started", runId: RUN, mode: "rule", state: "done" };
const never = () => new Promise<never>(() => {});

let host: HTMLDivElement;
let root: Root;
let reduceMotion = false;

beforeEach(() => {
  vi.clearAllMocks();
  reduceMotion = false;
  window.matchMedia = ((q: string) => ({
    matches: q.includes("reduce") ? reduceMotion : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  mocks.getRun.mockImplementation(never);
  mocks.advanceRun.mockImplementation(never);
  mocks.startRun.mockImplementation(never);
  mocks.fetchWizardStep.mockResolvedValue({ ok: true, data: STEP7 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const rowStates = () => ["sift", "moments", "book"].map((id) => $(`build-step-${id}`)?.getAttribute("data-state"));
const flush = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

/** Task 5: what the Story / Design steps get from the wizard (unused on step 6). */
const BOOK_STEP_PROPS = {
  story: { occasion: null, value: null, onChange: () => {} },
  design: {
    title: "",
    occasion: null,
    stored: { format: "A5_PORTRAIT" as const, designStyle: "modern" as const },
    pick: { format: null, designStyle: null },
    onPick: () => {},
    recommendation: null,
    onRecommendation: () => {},
    locked: false,
    error: null,
    save: async () => true,
    buildError: null,
  },
  factsRef: { current: { isPaid: false, dailyCap: null, ready: null } },
};

function renderSteps(handover: Promise<AutoStartOutcome> | null, stepData: WizardStepDataMap = { 6: STEP6_OFF }) {
  const dispatch = vi.fn();
  const handoverRef = { current: handover };
  const setStepData = vi.fn<(u: SetStateAction<WizardStepDataMap>) => void>();
  act(() =>
    root.render(
      <WizardDataSteps
        step={6}
        bookId={BOOK}
        stepData={stepData}
        setStepData={setStepData}
        dispatch={dispatch}
        leave={vi.fn()}
        leaving={false}
        autoRef={{ current: true }}
        handoverRef={handoverRef}
        headlineId="wizard-headline"
        {...BOOK_STEP_PROPS}
      />,
    ),
  );
  return { dispatch, handoverRef };
}

/**
 * Task 8: the Design step now starts the storybook job, so WizardDataSteps no longer hands an album
 * build over to step 6, and step 6 without an active ALBUM run is the storybook screen. StepSorting
 * keeps its hand-over support for books whose album build is still running (mid-deploy); it is
 * exercised here directly, wired the way WizardDataSteps wires it (onDone consumes the hand-over).
 */
function renderSorting(handover: Promise<AutoStartOutcome> | null, data: Step6 = STEP6_OFF) {
  const dispatch = vi.fn();
  const handoverRef = { current: handover };
  act(() =>
    root.render(
      <StepSorting
        data={data}
        headlineId="wizard-headline"
        handover={handoverRef.current}
        onDone={() => {
          handoverRef.current = null;
          dispatch({ type: "buildDone" });
        }}
        onStopped={(reason) => dispatch({ type: "buildStopped", reason })}
        onResumed={() => dispatch({ type: "buildResumed" })}
      />,
    ),
  );
  return { dispatch, handoverRef };
}

// --- pure helpers -----------------------------------------------------------------------------------

describe("rule checklist wording + replay rows (pure)", () => {
  it("rule labels say what the rule build does — no AI claims", () => {
    expect(wizardChecklist("queued", false, true).map((r) => r.label)).toEqual([
      "Leaving out duplicates and very blurry photos",
      "Grouping your photos by date and place",
      "Laying out your pages",
    ]);
    for (const label of Object.values(WIZARD_RULE_LABELS)) expect(label).not.toMatch(/\bAI\b|moments|caption/i);
    // the AI wording is unchanged
    expect(wizardChecklist("queued").map((r) => r.label)[1]).toBe("Finding places and moments");
  });

  it("replay rows: 0 → first current … 3 → all done; the photo phase follows the rows", () => {
    expect(wizardReplayChecklist(0).map((r) => r.state)).toEqual(["current", "todo", "todo"]);
    expect(wizardReplayChecklist(1).map((r) => r.state)).toEqual(["done", "current", "todo"]);
    expect(wizardReplayChecklist(2).map((r) => r.state)).toEqual(["done", "done", "current"]);
    expect(wizardReplayChecklist(3).map((r) => r.state)).toEqual(["done", "done", "done"]);
    expect([0, 1, 2, 3].map((n) => wizardPhaseOfRows(wizardReplayChecklist(n)))).toEqual(["fan", "sort", "piles", "ready"]);
    expect(wizardReplayChecklist(0)[0].label).toBe(WIZARD_RULE_LABELS.sift);
  });

  it("minimum replay ~2.5–3 s, never too fast per row", () => {
    expect(RULE_REPLAY_MS).toBeGreaterThanOrEqual(2_500);
    expect(RULE_REPLAY_MS).toBeLessThanOrEqual(3_000);
    expect(RULE_REPLAY_MIN_ROW_MS).toBeGreaterThan(0);
  });
});

describe("auto-start hand-over helpers (pure)", () => {
  it("handoverStart maps every answer", () => {
    expect(handoverStart(RULE_DONE)).toEqual({ kind: "started", runId: RUN, mode: "rule", state: "done" });
    expect(handoverStart({ kind: "already_running", runId: RUN })).toEqual({ kind: "already_running", runId: RUN });
    expect(handoverStart({ kind: "already_running", runId: null })).toEqual({ kind: "restart" });
    expect(handoverStart({ kind: "user_edited" })).toEqual({ kind: "user_edited" });
    expect(handoverStart({ kind: "limit", limit: "daily_builds" })).toEqual({ kind: "limit", limit: "daily_builds" });
    expect(handoverStart({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
    expect(handoverStart({ kind: "not_first" })).toEqual({ kind: "finished" });
    expect(handoverStart({ kind: "not_ready" })).toEqual({ kind: "restart" });
    expect(handoverStart({ kind: "error" })).toEqual({ kind: "restart" });
  });

  it("requestAutoBuildSettled: one retry after not_ready, then the final answer; never rejects", async () => {
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(409, { error: "not_ready" }))
      .mockResolvedValueOnce(res(201, { runId: RUN, mode: "rule", state: "done" }));
    const sleep = vi.fn(async () => {});
    await expect(requestAutoBuildSettled(BOOK, { fetchImpl, sleep })).resolves.toEqual(RULE_DONE);
    expect(sleep).toHaveBeenCalledWith(NOT_READY_RETRY_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const twice = vi.fn(async () => res(409, { error: "not_ready" }));
    await expect(requestAutoBuildSettled(BOOK, { fetchImpl: twice, sleep })).resolves.toEqual({ kind: "not_ready" });
    expect(twice).toHaveBeenCalledTimes(2);

    const boom = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(requestAutoBuildSettled(BOOK, { fetchImpl: boom, sleep })).resolves.toEqual({ kind: "error" });
  });

  it("resolveHandover: not_first re-reads step 6 — an active run is resumed, else on to Review", async () => {
    mocks.fetchWizardStep.mockResolvedValueOnce({ ok: true, data: { ...STEP6_OFF, activeRunId: RUN2 } });
    await expect(resolveHandover(Promise.resolve({ kind: "not_first" }), BOOK)).resolves.toEqual({
      kind: "already_running",
      runId: RUN2,
    });
    mocks.fetchWizardStep.mockResolvedValueOnce({ ok: true, data: STEP6_OFF });
    await expect(resolveHandover(Promise.resolve({ kind: "not_first" }), BOOK)).resolves.toEqual({ kind: "finished" });
    await expect(resolveHandover(Promise.reject(new Error("x")), BOOK)).resolves.toEqual({ kind: "restart" });
  });
});

// --- step 6 in rule mode --------------------------------------------------------------------------

describe("step 6, rule build done inside the POST (AI off)", () => {
  it("never skips to 7 on the gate; plays the rule rows through over the minimum, then ready → buildDone", async () => {
    const { dispatch, handoverRef } = renderSorting(Promise.resolve(RULE_DONE));
    await flush();
    const section = $("build-progress")!;
    expect(section).not.toBeNull();
    expect(dispatch).not.toHaveBeenCalledWith({ type: "buildDone" }); // gate said 7, hand-over wins
    expect(section.getAttribute("data-rules")).toBe("true");
    expect($("build-step-sift")!.textContent).toContain(WIZARD_RULE_LABELS.sift);
    expect($("build-step-moments")!.textContent).toContain(WIZARD_RULE_LABELS.moments);
    expect(mocks.startRun).not.toHaveBeenCalled(); // no second POST: the hand-over is the run
    expect(rowStates()).toEqual(["current", "todo", "todo"]);
    expect(section.getAttribute("data-sort-phase")).toBe("fan");
    expect($("build-ready")).toBeNull();
    // tracked once, from step 6, as a rules build started automatically
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("ai_build_done", expect.objectContaining({ mode: "rules", outcome: "ok", auto: true }));

    await flush(RULE_REPLAY_MS / 3 + 50);
    expect(rowStates()).toEqual(["done", "current", "todo"]);
    expect($("build-progress")!.getAttribute("data-sort-phase")).toBe("sort");
    await flush(RULE_REPLAY_MS / 3);
    expect(rowStates()).toEqual(["done", "done", "current"]);
    expect($("build-ready")).toBeNull();
    await flush(RULE_REPLAY_MS / 3);
    expect(rowStates()).toEqual(["done", "done", "done"]);
    expect($("build-ready")!.textContent).toBe(WIZARD_READY_COPY);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "buildDone" });
    await flush(READY_MS + 100);
    expect(dispatch).toHaveBeenCalledWith({ type: "buildDone" });
    expect(handoverRef.current).toBeNull(); // consumed
    expect(mocks.track).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("reduced motion: no replay — straight to the ready moment", async () => {
    reduceMotion = true;
    const { dispatch } = renderSorting(Promise.resolve(RULE_DONE));
    await flush();
    expect($("build-ready")).not.toBeNull();
    expect(rowStates()).toEqual(["done", "done", "done"]);
    await flush(READY_MS_REDUCED + 100);
    expect(dispatch).toHaveBeenCalledWith({ type: "buildDone" });
  });

  it("pending answer: step 6 shows the sorting (rule wording) while it waits, then plays through", async () => {
    let answer: (o: AutoStartOutcome) => void = () => {};
    const pending = new Promise<AutoStartOutcome>((r) => (answer = r));
    const { dispatch } = renderSorting(pending);
    await flush(50);
    expect($("build-progress")).not.toBeNull();
    expect($("build-progress")!.getAttribute("data-rules")).toBe("true");
    expect(rowStates()).toEqual(["todo", "todo", "todo"]); // nothing confirmed yet
    expect($("build-keep-open")).not.toBeNull();
    expect(mocks.startRun).not.toHaveBeenCalled();
    await act(async () => {
      answer(RULE_DONE);
    });
    await flush();
    expect(rowStates()[0]).toBe("current");
    await flush(RULE_REPLAY_MS + READY_MS + 200);
    expect(dispatch).toHaveBeenCalledWith({ type: "buildDone" });
    expect(mocks.startRun).not.toHaveBeenCalled();
  }, 10_000);

  it("a failed rule run → calm stop card without AI claims; buildStopped failed; rules failed tracked", async () => {
    const { dispatch } = renderSorting(Promise.resolve({ kind: "started", runId: RUN, mode: "rule", state: "failed" }));
    await flush();
    const card = $("build-error")!;
    expect(card).not.toBeNull();
    expect(card.getAttribute("data-variant")).toBe("wizard");
    expect(card.textContent).not.toMatch(/\bAI\b/);
    expect(card.textContent).toContain("We couldn't finish sorting your photos");
    expect(dispatch).toHaveBeenCalledWith({ type: "buildStopped", reason: "failed" });
    expect(mocks.track).toHaveBeenCalledWith("ai_build_done", expect.objectContaining({ mode: "rules", outcome: "failed" }));
  });

  it("a hand-over that made no run (error) → step 6 starts the build itself once (auto: false)", async () => {
    mocks.startRun.mockResolvedValue({ kind: "started", runId: RUN, mode: "rule", state: "done" });
    const { dispatch } = renderSorting(Promise.resolve({ kind: "error" }));
    await flush();
    expect(mocks.startRun).toHaveBeenCalledTimes(1);
    expect(mocks.startRun).toHaveBeenCalledWith(BOOK, "build");
    expect(mocks.track).toHaveBeenCalledWith("ai_build_done", expect.objectContaining({ mode: "rules", auto: false }));
    await flush(RULE_REPLAY_MS + READY_MS + 200);
    expect(dispatch).toHaveBeenCalledWith({ type: "buildDone" });
  }, 10_000);

  it("a live/replay run handed over → resumes that run id (no POST), AI wording", async () => {
    const live = { ...STEP6_OFF, aiOn: true, resolved: 6, activeRunId: RUN2 } as Step6;
    renderSteps(Promise.resolve({ kind: "started", runId: RUN, mode: "replay", state: "queued" }), { 6: live });
    await flush(20);
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.advanceRun).toHaveBeenCalledWith(RUN, expect.anything()); // the handed-over run, not activeRunId
    expect($("build-progress")!.getAttribute("data-rules")).toBeNull();
  });

  it("not_first hand-over with the first run finished → straight to the ready moment (no POST)", async () => {
    mocks.fetchWizardStep.mockImplementation(async (_b: string, step: number) =>
      step === 6 ? { ok: true, data: STEP6_OFF } : { ok: true, data: STEP7 },
    );
    const { dispatch } = renderSorting(Promise.resolve({ kind: "not_first" }));
    await flush(20);
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect($("build-ready")).not.toBeNull();
    await flush(READY_MS + 100);
    expect(dispatch).toHaveBeenCalledWith({ type: "buildDone" });
  });

  it("no hand-over (refresh on step 6), AI off, gate says 7 → follows the gate (G3: no second run)", async () => {
    const { dispatch } = renderSteps(null, {});
    mocks.fetchWizardStep.mockResolvedValue({ ok: true, data: STEP6_OFF });
    await flush(20);
    expect(dispatch).toHaveBeenCalledWith({ type: "buildDone" });
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it("no hand-over, AI off, active rule run (refresh mid-build) → resumes it with rule wording", async () => {
    renderSteps(null, { 6: { ...STEP6_OFF, resolved: 6, activeRunId: RUN } as Step6 });
    await flush(20);
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.advanceRun).toHaveBeenCalledWith(RUN, expect.anything());
    expect($("build-step-moments")!.textContent).toContain(WIZARD_RULE_LABELS.moments);
  });
});
