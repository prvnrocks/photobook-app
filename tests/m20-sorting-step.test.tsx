// @vitest-environment jsdom
// M20 T7 (D-072): wizard step 6 "Sorting your photos".
//   - checklist rows + photo phase follow the server-reported RunState only (pure + rendered)
//   - stop states → calm card (Open my book / Try again where the classic screen offers it) and
//     WizardDataSteps dispatches buildStopped with the right reason
//   - finished → "Your book is ready to review" moment → onDone (after READY_MS) with prefetched
//     step-7 data handed to the wizard (setStepData) → buildDone; ai_build_done tracked once
//   - calm hint after 20 s; reduced motion: shorter ready moment + CSS motion only under no-preference
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunState, RunTick } from "@/lib/runs/client";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  startRun: vi.fn(),
  getRun: vi.fn(),
  advanceRun: vi.fn(),
  fetchWizardStep: vi.fn(),
  track: vi.fn(),
  replace: vi.fn(),
  // Stable like Next's router (BuildProgress's run loop depends on it).
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

const { wizardChecklist, wizardSortPhase, wizardRowsDone } = await import("@/lib/runs/build-checklist");
const { BuildProgress, STOP_REASON, WIZARD_READY_COPY, WIZARD_SLOW_HINT_COPY, WIZARD_SLOW_HINT_MS } = await import(
  "@/components/review/BuildProgress"
);
const { StepSorting, READY_MS, READY_MS_REDUCED } = await import("@/components/books/wizard/steps/StepSorting");
const { WizardDataSteps } = await import("@/components/books/wizard/steps/WizardDataSteps");
type WizardStepDataMap = import("@/components/books/wizard/steps/WizardDataSteps").WizardStepDataMap;
type Step6 = import("@/lib/books/wizard-client").WizardStep6Data;
type Step7 = import("@/lib/books/wizard-client").WizardStep7Data;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

const STEP6: Step6 = {
  step: 6,
  bookId: BOOK,
  title: "Summer",
  rawTitle: "Summer",
  occasion: "travel",
  format: "a5_portrait",
  designStyle: "classic",
  captionLang: "en",
  isPaid: false,
  aiOn: true,
  resolved: 6,
  activeRunId: RUN,
  readError: false,
  trigger: "build",
  dailyCap: 3,
  auto: true,
  fanUrls: ["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg"],
} as unknown as Step6;
const STEP7 = { step: 7, bookId: BOOK, resolved: 7, counts: { kept: 12 } } as unknown as Step7;

const tick = (state: RunState, done = false): RunTick => ({
  state,
  done,
  aiStatus: done ? "ok" : null,
  errorCode: null,
  progress: { phase: state, photosTotal: 0, photosDone: 0, captionsTotal: 0, captionsDone: 0 } as RunTick["progress"],
});
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
const flush = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

function renderSteps(stepData: WizardStepDataMap = { 6: STEP6 }) {
  const dispatch = vi.fn();
  const updates: WizardStepDataMap[] = [];
  let current = stepData;
  const setStepData = vi.fn((u: SetStateAction<WizardStepDataMap>) => {
    current = typeof u === "function" ? u(current) : u;
    updates.push(current);
  });
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
        headlineId="wizard-headline"
      />,
    ),
  );
  return { dispatch, updates };
}

// --- truthful mapping ------------------------------------------------------------------------------

describe("checklist + photo phase per RunState (pure)", () => {
  const cases: [RunState, string[], string][] = [
    ["queued", ["todo", "todo", "todo"], "fan"],
    ["curating", ["current", "todo", "todo"], "fan"],
    ["storytelling", ["done", "current", "todo"], "sort"],
    ["captioning", ["done", "done", "current"], "piles"],
    ["critiquing", ["done", "done", "current"], "piles"],
    ["repairing", ["done", "done", "current"], "piles"],
    ["validating", ["done", "done", "current"], "piles"],
    ["failed", ["todo", "todo", "todo"], "fan"],
    ["done", ["done", "done", "done"], "ready"],
  ];
  it.each(cases)("%s", (state, rows, phase) => {
    const list = wizardChecklist(state);
    expect(list.map((r) => r.state)).toEqual(rows);
    expect(wizardSortPhase(state)).toBe(phase);
    expect(wizardRowsDone(list)).toBe(rows.filter((r) => r === "done").length);
  });
  it("finished → all rows done, phase ready, from any state", () => {
    for (const s of ["queued", "curating", "storytelling", "validating"] as const) {
      expect(wizardChecklist(s, true).map((r) => r.state)).toEqual(["done", "done", "done"]);
      expect(wizardSortPhase(s, true)).toBe("ready");
    }
  });
  it("row labels", () => {
    expect(wizardChecklist("queued").map((r) => r.label)).toEqual([
      "Checking for duplicates and blurry photos",
      "Finding places and moments",
      "Preparing your book",
    ]);
  });
});

describe("rendered checklist follows the reported run state", () => {
  it.each([
    ["curating", "fan", ["current", "todo", "todo"], 0],
    ["storytelling", "sort", ["done", "current", "todo"], 1],
    ["captioning", "piles", ["done", "done", "current"], 2],
    ["validating", "piles", ["done", "done", "current"], 2],
  ] as const)("%s → phase %s", async (state, phase, rows, done) => {
    mocks.getRun.mockResolvedValue({ kind: "view", view: { ...tick(state), mode: "live" } });
    renderSteps();
    await flush();
    const section = $("build-progress")!;
    expect(section.getAttribute("data-state")).toBe(state);
    expect(section.getAttribute("data-sort-phase")).toBe(phase);
    expect(["sift", "moments", "book"].map((id) => $(`build-step-${id}`)!.getAttribute("data-state"))).toEqual(rows);
    expect($("build-sort-bar")!.getAttribute("data-done")).toBe(String(done));
    // the user's photos, beside the checklist on ≥ lg
    expect(host.querySelectorAll('[data-testid="build-photo-fan"] img')).toHaveLength(3);
    expect(section.className).toContain("lg:grid-cols-");
    expect($("build-keep-open")).not.toBeNull();
    expect(mocks.startRun).not.toHaveBeenCalled(); // resumes the active run (G3)
  });

  it("queued at first: everything todo, fan phase, no slow hint yet", () => {
    renderSteps();
    expect($("build-progress")!.getAttribute("data-sort-phase")).toBe("fan");
    expect(host.querySelectorAll('li[data-state="todo"]')).toHaveLength(3);
    expect($("build-slow-hint")).toBeNull();
  });
});

describe("calm hint after a while", () => {
  it(`shows "${WIZARD_SLOW_HINT_COPY}" after ${WIZARD_SLOW_HINT_MS} ms while still running; rows unchanged`, () => {
    vi.useFakeTimers();
    renderSteps();
    act(() => {
      vi.advanceTimersByTime(WIZARD_SLOW_HINT_MS - 100);
    });
    expect($("build-slow-hint")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect($("build-slow-hint")!.textContent).toBe(WIZARD_SLOW_HINT_COPY);
    expect(host.querySelectorAll('li[data-state="todo"]')).toHaveLength(3); // time never moves the checklist
  });
});

// --- stop states ----------------------------------------------------------------------------------

describe("stop states → calm card + buildStopped", () => {
  const noRun = { ...STEP6, activeRunId: null } as Step6;

  it.each([
    ["limit", { kind: "limit", limit: "daily_builds" }, "build-limit", "limit", false],
    ["user_edited", { kind: "user_edited" }, "build-user-edited", "user_edited", false],
    ["not_found", { kind: "not_found" }, "build-error", "not_found", true],
    ["signed_out", { kind: "signed_out" }, "build-error", "signed_out", false],
    ["failed at start", { kind: "started", runId: RUN, mode: "live", state: "failed" }, "build-error", "failed", true],
  ] as const)("%s", async (_name, outcome, testId, reason, retry) => {
    mocks.startRun.mockResolvedValue(outcome);
    const { dispatch } = renderSteps({ 6: noRun });
    await flush();
    const card = $(testId)!;
    expect(card).not.toBeNull();
    expect(card.getAttribute("data-variant")).toBe("wizard");
    expect(dispatch).toHaveBeenCalledWith({ type: "buildStopped", reason });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "buildDone" });
    expect(!!$("build-retry")).toBe(retry);
    if (reason === "signed_out") {
      expect($("build-sign-in")!.getAttribute("href")).toContain("/login?next=");
      expect($("build-to-editor")).toBeNull();
    } else {
      const open = $("build-to-editor")!;
      expect(open.textContent).toBe("Open my book");
      expect(open.getAttribute("href")).toBe(`/books/${BOOK}/edit`);
    }
    expect($("build-progress")).toBeNull();
  });

  it("run fails mid-way → failed; Try again resumes running", async () => {
    mocks.advanceRun.mockResolvedValueOnce({ kind: "tick", tick: tick("failed", true) });
    const { dispatch } = renderSteps();
    await flush();
    expect(dispatch).toHaveBeenCalledWith({ type: "buildStopped", reason: "failed" });
    expect(mocks.track).toHaveBeenCalledWith("ai_build_done", expect.objectContaining({ mode: "ai", outcome: "failed", auto: true }));
    mocks.startRun.mockImplementation(never);
    act(() => ($("build-retry") as HTMLButtonElement).click());
    expect($("build-progress")).not.toBeNull();
  });

  it("every classic stop maps to a flow reason", () => {
    expect(STOP_REASON).toEqual({
      signed_out: "signed_out",
      not_found: "not_found",
      unavailable: "unavailable",
      server_unavailable: "unavailable",
      run_failed: "failed",
      user_edited: "user_edited",
      limit: "limit",
    });
  });
});

// --- finishing ------------------------------------------------------------------------------------

describe("finished → ready moment → step 7 (with prefetched data)", () => {
  it("ready line + phase, prefetches step 7, onDone only after READY_MS, data handed to the wizard", async () => {
    mocks.advanceRun.mockResolvedValueOnce({ kind: "tick", tick: tick("validating", true) });
    mocks.fetchWizardStep.mockResolvedValue({ ok: true, data: STEP7 });
    const { dispatch, updates } = renderSteps();
    await flush();
    expect($("build-progress")!.getAttribute("data-sort-phase")).toBe("ready");
    expect($("build-ready")!.textContent).toBe(WIZARD_READY_COPY);
    expect(host.querySelectorAll('li[data-state="done"]')).toHaveLength(3);
    expect(mocks.fetchWizardStep).toHaveBeenCalledWith(BOOK, 7, expect.anything());
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("ai_build_done", expect.objectContaining({ mode: "ai", outcome: "ok", auto: true }));
    expect(mocks.replace).not.toHaveBeenCalled(); // wizard: no editor redirect
    await flush(READY_MS - 400);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "buildDone" });
    await flush(600);
    expect(dispatch).toHaveBeenCalledWith({ type: "buildDone" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)?.[7]).toBe(STEP7);
  });

  it("prefetch that resolves elsewhere (editor) or fails → buildDone without data", async () => {
    mocks.advanceRun.mockResolvedValueOnce({ kind: "tick", tick: tick("validating", true) });
    mocks.fetchWizardStep.mockResolvedValue({ ok: true, data: { ...STEP7, resolved: "editor" } });
    const { dispatch, updates } = renderSteps();
    await flush(READY_MS + 200);
    expect(dispatch).toHaveBeenCalledWith({ type: "buildDone" });
    expect(updates).toHaveLength(0);
  });

  it("rule run done at start → also the ready moment, then buildDone", async () => {
    mocks.startRun.mockResolvedValue({ kind: "started", runId: RUN, mode: "rule", state: "done" });
    mocks.fetchWizardStep.mockResolvedValue({ ok: false, error: "failed" });
    const { dispatch } = renderSteps({ 6: { ...STEP6, activeRunId: null } as Step6 });
    await flush();
    expect($("build-ready")).not.toBeNull();
    expect(mocks.track).toHaveBeenCalledWith("ai_build_done", expect.objectContaining({ mode: "rules", outcome: "ok" }));
    await flush(READY_MS + 200);
    expect(dispatch).toHaveBeenCalledWith({ type: "buildDone" });
  });

  it("reduced motion: shorter ready moment", async () => {
    reduceMotion = true;
    mocks.advanceRun.mockResolvedValueOnce({ kind: "tick", tick: tick("validating", true) });
    mocks.fetchWizardStep.mockResolvedValue({ ok: true, data: STEP7 });
    const { dispatch } = renderSteps();
    await flush(READY_MS_REDUCED + 150);
    expect(READY_MS_REDUCED).toBeLessThan(READY_MS);
    expect(dispatch).toHaveBeenCalledWith({ type: "buildDone" });
  });

  it("StepSorting alone: onDone gets the step-7 data", async () => {
    mocks.advanceRun.mockResolvedValueOnce({ kind: "tick", tick: tick("validating", true) });
    mocks.fetchWizardStep.mockResolvedValue({ ok: true, data: STEP7 });
    const onDone = vi.fn();
    act(() => root.render(<StepSorting data={STEP6} headlineId="h" onDone={onDone} />));
    await flush(READY_MS + 200);
    expect(onDone).toHaveBeenCalledWith(STEP7);
  });
});

describe("default (classic) variant unchanged", () => {
  it("finished → router.replace(editor), no ready line, no phase", async () => {
    mocks.advanceRun.mockResolvedValueOnce({ kind: "tick", tick: tick("validating", true) });
    act(() => root.render(<BuildProgress bookId={BOOK} activeRunId={RUN} trigger="build" isPaid={false} dailyCap={3} />));
    await flush();
    expect(mocks.replace).toHaveBeenCalledWith(`/books/${BOOK}/edit`);
    expect($("build-ready")).toBeNull();
    expect(host.querySelector("[data-sort-phase]")).toBeNull();
    expect($("build-bar")).not.toBeNull();
  });

  it("classic stop states keep the Notice (no wizard card)", async () => {
    mocks.startRun.mockResolvedValue({ kind: "limit", limit: "daily_builds" });
    const onStop = vi.fn();
    act(() => root.render(<BuildProgress bookId={BOOK} activeRunId={null} trigger="build" isPaid={false} dailyCap={3} onStop={onStop} />));
    await flush();
    expect($("build-limit")!.getAttribute("data-variant")).toBeNull();
    expect($("build-to-editor")!.textContent).toBe("Open your book");
  });
});

// --- motion CSS -----------------------------------------------------------------------------------

describe("sorting-motion.css", () => {
  const raw = readFileSync(join(process.cwd(), "src/components/books/wizard/steps/sorting-motion.css"), "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

  it("every animation/transition sits under prefers-reduced-motion: no-preference (static poses otherwise)", () => {
    const open = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(open).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = css.indexOf("{", open); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const outside = css.slice(0, open) + css.slice(end + 1);
    const inside = css.slice(open, end);
    expect(outside).not.toMatch(/(^|[\s;{])(animation|transition)(-[a-z-]+)?\s*:/);
    for (const name of ["so-deal", "so-shuffle", "so-pop", "so-burst", "so-row-sweep"]) expect(inside).toContain(name);
    // static poses per phase exist outside the motion block
    expect(outside).toMatch(/\[data-sort-phase="ready"\] \.so-card \{\s*transform: var\(--so-ready\)/);
    expect(outside).toMatch(/\[data-sort-phase="piles"\] \.so-card \{\s*transform: var\(--so-pile\)/);
  });

  it("compositor-only keyframes (transform / opacity)", () => {
    const kfs = css.match(/@keyframes[^{]+\{[\s\S]*?\n\}/g) ?? [];
    expect(kfs.length).toBeGreaterThan(5);
    for (const kf of kfs) {
      const props = [...kf.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const p of props) expect(["transform", "opacity"]).toContain(p);
    }
  });

  it("imported by NewBookWizard (route stylesheet), not by the lazy steps chunk", () => {
    const wiz = readFileSync(join(process.cwd(), "src/components/books/NewBookWizard.tsx"), "utf8");
    expect(wiz).toContain('import "./wizard/steps/sorting-motion.css";');
    for (const f of ["StepSorting.tsx", "WizardDataSteps.tsx", "lazy-steps.tsx"]) {
      expect(readFileSync(join(process.cwd(), "src/components/books/wizard/steps", f), "utf8")).not.toMatch(/import "[^"]+\.css"/);
    }
  });
});
