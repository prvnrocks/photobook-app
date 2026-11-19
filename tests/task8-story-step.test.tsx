// @vitest-environment jsdom
// Task 8: wizard step 6 "Your memories are becoming a story." — StepStoryGeneration + StoryProgress
// + useStoryRun with a scripted job API (no network): automatic start (once, also under StrictMode),
// real stage counts only (no percentage, no progressbar), refresh re-attach by the server's run id,
// Stop (once), stopped / failed / connection states with Try again, completion → the editor.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StepStoryGeneration, STORY_READY_MS } from "@/components/books/wizard/steps/StepStoryGeneration";
import { StoryProgress } from "@/components/story/StoryProgress";
import { CONNECTION_LOST, type StoryRunApi } from "@/components/story/useStoryRun";
import type { WizardStep6Data } from "@/lib/books/wizard-client";
import { emptyStoryProgress, STORY_HEADLINE, type StoryRunProgress, type StoryRunState, type StoryRunView } from "@/lib/storybook/run/progress";
import { parseStoryView, startStory } from "@/lib/storybook/run/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN = "00000000-0000-4000-8000-000000000801";
const RUN2 = "00000000-0000-4000-8000-000000000802";

function view(state: StoryRunState, over: Partial<StoryRunView> = {}, stages: Partial<StoryRunProgress["stages"]> = {}): StoryRunView {
  const p = emptyStoryProgress(state === "done" || state === "failed" ? "discovering" : state);
  p.phase = state;
  Object.assign(p.stages, stages);
  return { runId: RUN, state, progress: p, done: state === "done" || state === "failed", aiStatus: null, errorCode: null, mode: "live", ...over };
}
const writing = (done: number) => view("writing", {}, { discovering: { status: "done", done: 40, total: 40 }, organizing: { status: "done", moments: 7, chapters: 3 }, writing: { status: "running", done, chapters: 3 } });

const data = (story: StoryRunView | null, over: Partial<WizardStep6Data> = {}): WizardStep6Data => ({
  step: 6, bookId: BOOK, title: "T", rawTitle: "T", occasion: "travel", format: "A5_PORTRAIT", designStyle: "classic", captionLang: "en",
  isPaid: false, aiOn: true, resolved: 6, story, activeRunId: null, hasDoc: false, readError: false, trigger: "build", dailyCap: 3, auto: false, fanUrls: [], ...over,
});

const never = <T,>() => new Promise<T>(() => {});
function api(over: Partial<StoryRunApi> = {}): StoryRunApi & { [K in keyof StoryRunApi]: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => ({ kind: "started" as const, runId: RUN, view: view("discovering") })),
    advance: vi.fn(() => never()),
    cancel: vi.fn(async () => ({ kind: "view" as const, view: view("failed", { errorCode: "cancelled" }, { writing: { status: "failed", done: 1, chapters: 3 } }) })),
    get: vi.fn(async () => ({ kind: "view" as const, view: writing(1) })),
    ...over,
  } as never;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
const $ = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const wait = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};
const click = async (id: string) => {
  await act(async () => {
    $(id)!.click();
  });
};
const stage = (s: string) => $(`story-stage-${s}`)!;

function render(d: WizardStep6Data, a: StoryRunApi, onDone = vi.fn(), opts: { strict?: boolean; onOpenBook?: () => void; handover?: StoryRunView | null } = {}) {
  const el = <StepStoryGeneration data={d} headlineId="h" onDone={onDone} api={a} onOpenBook={opts.onOpenBook} handover={opts.handover ?? null} />;
  act(() => root.render(opts.strict ? <StrictMode>{el}</StrictMode> : el));
  return { onDone };
}

describe("step 6: the generation screen", () => {
  it("headline exactly as asked; four stage rows with labels; nothing fabricated (no %, no progressbar)", async () => {
    const a = api();
    render(data(writing(1)), a);
    expect(host.querySelector("h1")!.textContent).toBe("Your memories are becoming a story.");
    expect(STORY_HEADLINE).toBe("Your memories are becoming a story.");
    expect(["discovering", "organizing", "writing", "designing"].map((s) => stage(s).textContent?.replace(/\s*\(.*\)/, ""))).toEqual([
      "Discovering your best moments40 photos",
      "Organizing your memories7 moments · 3 chapters",
      "Writing your storyChapter 2 of 3",
      "Designing your pages",
    ]);
    expect(stage("writing").getAttribute("data-status")).toBe("running");
    expect(stage("writing").getAttribute("aria-current")).toBe("step");
    expect(stage("designing").textContent).toContain("(Waiting)"); // not colour only
    expect(host.textContent).not.toContain("%");
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(host.querySelector("progress")).toBeNull();
    expect($("story-live")!.getAttribute("aria-live")).toBe("polite");
    expect($("story-live")!.textContent).toBe("Writing your story — Chapter 2 of 3");
    expect(a.start).not.toHaveBeenCalled(); // a refresh re-attaches — never a second job
    expect(a.advance).toHaveBeenCalledWith(RUN, expect.anything());
  });

  it("no job yet → starts exactly once (StrictMode double effects included), then follows the server's run id", async () => {
    const a = api();
    render(data(null), a, vi.fn(), { strict: true });
    await wait(10);
    expect(a.start).toHaveBeenCalledTimes(1);
    expect(a.advance).toHaveBeenCalledWith(RUN, expect.anything());
  });

  it("ticks move the rows only with what the server reports, chapter by chapter, then the editor opens", async () => {
    const ticks = [writing(2), view("writing", {}, { writing: { status: "running", done: 3, chapters: 3, closing: true } }), view("done", {}, { designing: { status: "done", pages: 18 } })];
    const a = api({ advance: vi.fn(async () => ({ kind: "tick" as const, tick: ticks.shift() ?? never() })) as never });
    const { onDone } = render(data(writing(1)), a);
    await wait(10);
    expect(["Chapter 3 of 3", "Closing words"]).toContain($("story-stage-writing-detail")?.textContent);
    await wait(700);
    expect($("story-done")).not.toBeNull();
    expect($("story-live")!.textContent).toBe("Your story is ready.");
    expect(onDone).not.toHaveBeenCalled();
    await wait(STORY_READY_MS + 50);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("Stop: one cancel for repeated taps; the stopped card says why and offers to continue (a NEW job)", async () => {
    let finish: (v: unknown) => void = () => {};
    const a = api({ cancel: vi.fn(() => new Promise((r) => (finish = r))) as never });
    render(data(writing(1)), a);
    await click("story-stop");
    await click("story-stop");
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect($("story-stop")!.hasAttribute("disabled")).toBe(true);
    expect($("story-stop")!.textContent).toBe("Stopping…");
    await act(async () => finish({ kind: "view", view: view("failed", { errorCode: "cancelled" }, { writing: { status: "failed", done: 1, chapters: 3 } }) }));
    expect($("story-stopped")!.getAttribute("data-code")).toBe("cancelled");
    expect($("story-stopped-reason")!.textContent).toMatch(/You stopped this/);
    expect(stage("writing").getAttribute("data-status")).toBe("failed");
    expect($("story-try-again")!.textContent).toBe("Continue my story");
    // Try again → start (the server resumes the finished stages into the new job)
    const a2start = a.start;
    a.start.mockResolvedValueOnce({ kind: "started", runId: RUN2, view: { ...writing(1), runId: RUN2 } });
    const again = $("story-try-again")!;
    await act(async () => {
      again.click();
      again.click(); // a double tap in one frame
    });
    await wait(10);
    expect(a2start).toHaveBeenCalledTimes(1);
    expect(a.advance).toHaveBeenLastCalledWith(RUN2, expect.anything());
  });

  it("a failed job (refresh) shows its plain reason + Try again; 'Open my book' only when the book has pages", async () => {
    const failed = view("failed", { errorCode: "conflict" }, { designing: { status: "failed" } });
    const a = api();
    const open = vi.fn();
    render(data(failed, { hasDoc: true }), a, vi.fn(), { onOpenBook: open });
    expect($("story-stopped-reason")!.textContent).toMatch(/The book changed while we were designing it/);
    expect(stage("designing").textContent).toContain("(Stopped here)");
    await click("story-open-book");
    expect(open).toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(host);
    render(data(failed), api());
    expect($("story-open-book")).toBeNull();
  });

  it("connection lost (repeated network failures) → a calm error with Try again that re-attaches to the SAME job", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const a = api({ advance: vi.fn(async () => ({ kind: "network" as const })) as never });
    render(data(writing(1)), a);
    for (let i = 0; i < 8; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(17_000)));
    expect($("story-error")).not.toBeNull();
    expect($("story-error-reason")!.textContent).toBe(CONNECTION_LOST);
    a.advance.mockImplementation(() => never());
    await click("story-try-again");
    expect(a.get).toHaveBeenCalledWith(RUN);
    expect(a.start).not.toHaveBeenCalled();
  });

  it("a refused start (e.g. no photos) → the reason, Try again asks again", async () => {
    const a = api({ start: vi.fn(async () => ({ kind: "no_photos" as const })) as never });
    render(data(null), a);
    await wait(10);
    expect($("story-error-reason")!.textContent).toMatch(/Add a few photos first/);
    await click("story-try-again");
    await wait(10);
    expect(a.start).toHaveBeenCalledTimes(2);
  });

  it("the Design step's start answer is used at once (no second POST)", async () => {
    const a = api();
    render(data(null), a, vi.fn(), { handover: writing(0) });
    await wait(10);
    expect(a.start).not.toHaveBeenCalled();
    expect($("story-stage-writing-detail")!.textContent).toBe("Chapter 1 of 3");
  });

  it("a finished rule job says plainly that it was made without AI (static render)", () => {
    const done = view("done", { mode: "rule" }, { discovering: { status: "skipped" }, writing: { status: "skipped", chapters: 3 }, designing: { status: "done", pages: 18 } });
    done.progress.outcome = { ai: "none", notes: ["ai_off"], warnings: 0 };
    const html = renderToStaticMarkup(<StoryProgress phase={{ kind: "done", view: done }} busy={false} onStop={() => {}} onTryAgain={() => {}} />);
    expect(html).toContain("Made without AI");
    expect(html).toContain("Sorted without AI");
    expect(html).toContain("No text this time");
    expect(html).not.toContain("%");
  });

  it("targets are ≥ 44 px (Stop / Try again use the wizard's 48 px pill classes)", () => {
    const html = renderToStaticMarkup(<StoryProgress phase={{ kind: "running", view: writing(1), retrying: false }} busy={false} onStop={() => {}} onTryAgain={() => {}} />);
    expect(html).toMatch(/data-testid="story-stop"[^>]*/);
    expect(html).toContain("min-h-12");
  });
});

describe("storybook job client", () => {
  it("parseStoryView is strict on id / state / done and lenient on the rest", () => {
    expect(parseStoryView({ runId: RUN, state: "writing", done: false, progress: { stages: { writing: { status: "running", done: 1, chapters: 3 } } } })!.progress.stages.writing).toEqual({ status: "running", done: 1, chapters: 3 });
    expect(parseStoryView({ runId: "x", state: "writing", done: false })).toBeNull();
    expect(parseStoryView({ runId: RUN, state: "queued", done: false })).toBeNull();
  });

  it("startStory maps the route's answers (201 / 409 already_running + id / 409 no_photos / 503 story_unavailable)", async () => {
    const f = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    expect(await startStory(BOOK, { fetchImpl: f(201, { runId: RUN, mode: "live", view: view("discovering") }) })).toMatchObject({ kind: "started", runId: RUN });
    expect(await startStory(BOOK, { fetchImpl: f(409, { error: "already_running", runId: RUN }) })).toEqual({ kind: "already_running", runId: RUN });
    expect(await startStory(BOOK, { fetchImpl: f(409, { error: "no_photos" }) })).toEqual({ kind: "no_photos" });
    expect(await startStory(BOOK, { fetchImpl: f(503, { error: "story_unavailable" }) })).toEqual({ kind: "story_unavailable" });
    expect(await startStory("nope")).toEqual({ kind: "not_found" });
  });
});
