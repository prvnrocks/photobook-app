// @vitest-environment jsdom
// M20 T6 (D-072): one continuous wizard on /books/new. In a DOM:
//   - created → step 5 in place (no router.push, same band node, book_created once from the flash)
//   - step-5 Back → step 4 edit → save → step 5 again (still one book)
//   - popstate guards via the flow (photos picked → Back stays on 5; run → Back stays on 6)
//   - auto-start outcomes → step 6 (+ ?auto=1 data) / step 7 / editor; build done → 7 by replace
//   - hard-load data the gate moved on (5 → 7) and the mode guard (another book → reload)
//   - Uploader (wizard): advances only after the success burst AND the auto-start answer; classic
//     Uploader still router.push-es.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createBookAction: vi.fn(),
  updateBookSetupAction: vi.fn(),
  deleteUnfinishedAction: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  trackEvent: vi.fn(),
  track: vi.fn(),
  queue: null as null | { files: File[]; onEvent: (e: unknown) => void },
}));

vi.mock("@/app/books/actions", () => ({
  createBookAction: mocks.createBookAction,
  updateBookSetupAction: mocks.updateBookSetupAction,
  deleteUnfinishedAction: mocks.deleteUnfinishedAction,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, refresh: mocks.refresh }),
  usePathname: () => "/books/new",
}));
vi.mock("@/lib/analytics/client", () => ({ trackEvent: mocks.trackEvent, track: mocks.track }));

type Cb = () => void;
vi.mock("@/components/books/wizard/steps/StepPhotos", () => ({
  StepPhotos: (p: {
    data: { bookId: string };
    headlineId: string;
    onBack: Cb;
    onPhotosPicked: Cb;
    onAdvance: (o: unknown) => void;
    onAdvancePending: (p: Promise<unknown>) => void;
    onBuildNow: Cb;
  }) => (
    <div data-testid="stub-photos" data-book={p.data.bookId}>
      <h1 id={p.headlineId} tabIndex={-1}>Add your photos</h1>
      <button type="button" data-testid="stub-back" onClick={p.onBack} />
      <button type="button" data-testid="stub-pick" onClick={p.onPhotosPicked} />
      <button type="button" data-testid="stub-build-now" onClick={p.onBuildNow} />
      <button
        type="button"
        data-testid="stub-started"
        onClick={() => p.onAdvance({ kind: "started", runId: RUN, mode: "live", state: "queued" })}
      />
      <button type="button" data-testid="stub-not-first" onClick={() => p.onAdvance({ kind: "not_first" })} />
      <button type="button" data-testid="stub-user-edited" onClick={() => p.onAdvance({ kind: "user_edited" })} />
      <button
        type="button"
        data-testid="stub-rule-done"
        onClick={() => p.onAdvance({ kind: "started", runId: RUN, mode: "rule", state: "done" })}
      />
      <button type="button" data-testid="stub-pending" onClick={() => p.onAdvancePending(new Promise(() => {}))} />
    </div>
  ),
}));
vi.mock("@/components/books/wizard/steps/StepSorting", () => ({
  StepSorting: (p: { data: { activeRunId: string | null; auto: boolean }; onDone: Cb; handover?: Promise<unknown> | null }) => (
    <div
      data-testid="stub-sorting"
      data-run={p.data.activeRunId ?? ""}
      data-auto={String(p.data.auto)}
      data-handover={p.handover ? "yes" : "no"}
    >
      <button type="button" data-testid="stub-done" onClick={p.onDone} />
    </div>
  ),
}));
vi.mock("@/components/books/wizard/steps/StepReview", () => ({
  StepReview: (p: { data: { counts: { kept: number } }; onConfirm: Cb }) => (
    <div data-testid="stub-review" data-kept={p.data.counts.kept}>
      <button type="button" data-testid="stub-confirm" onClick={p.onConfirm} />
    </div>
  ),
}));

// Uploader harness: a scripted queue, finalize and the stage (onSettled = a button).
vi.mock("@/lib/upload/browser-queue", () => ({
  createBrowserUploadQueue: (deps: { onEvent: (e: unknown) => void }) => {
    const q = {
      files: [] as File[],
      onEvent: deps.onEvent,
      add(files: File[]) {
        q.files.push(...files);
      },
      colors: () => ({}),
      forgetColors: () => {},
      async start() {
        const n = q.files.length;
        deps.onEvent({ type: "progress", done: n, total: n, uploaded: n, failed: 0, skipped: 0, retried: 0 });
        return {
          total: n, uploaded: n, failed: 0, skipped: 0, retried: 0, skippedBy: {}, failedBy: {},
          notStarted: 0, limit: null, cancelled: false, fatal: null, pendingLeft: 0,
        };
      },
      pause() {},
      resume() {},
      cancel() {},
    };
    mocks.queue = q;
    return q;
  },
}));
vi.mock("@/lib/upload/finalize-client", () => ({
  colorsBody: () => null,
  finalizeWithPlaces: async () => ({
    ok: true,
    result: { photos: 5, withDate: 5, withGps: 0, withPlace: 0, dupPhotos: 0, pages: 4, wroteDoc: true, placesPending: 0 },
  }),
}));
vi.mock("@/components/upload/UploadProgress", () => ({
  UploadProgress: (p: { variant?: string; settled?: boolean; onSettled?: Cb }) => (
    <div data-testid="stub-progress" data-variant={p.variant} data-settled={String(!!p.settled)}>
      <button type="button" data-testid="stub-settle" onClick={() => p.onSettled?.()} />
    </div>
  ),
}));

const RUN = "33333333-3333-4333-8333-333333333333";
const BOOK = "22222222-2222-4222-8222-222222222222";
const OTHER = "44444444-4444-4444-8444-444444444444";

const { NewBookWizard, wizardWindow } = await import("@/components/books/NewBookWizard");
const { Uploader } = await import("@/components/upload/Uploader");
const { HANDOVER_GRACE_MS } = await import("@/components/upload/upload-stage-model");
const { WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft, EMPTY_WIZARD_DRAFT } = await import("@/lib/books/wizard-steps");
type Props = import("@/components/books/NewBookWizard").NewBookWizardProps;
type WizardDraft = import("@/lib/books/wizard-steps").WizardDraft;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DRAFT: WizardDraft = { title: "Sea days", occasion: "travel", format: "A5_PORTRAIT", designStyle: "modern" };
const base = (step: number, bookId = BOOK) => ({
  step, bookId, title: "Sea days", rawTitle: "Sea days", occasion: "travel", format: "A5_PORTRAIT",
  designStyle: "modern", captionLang: "en", isPaid: false, aiOn: true, resolved: step,
});
const step5 = (over: Record<string, unknown> = {}) => ({
  ...base(5), userId: "u1", existing: [], maxUpload: 150, readyCount: 0, pendingCount: 0, hasDoc: false,
  firstRun: "none", dailyCap: 3, ...over,
});
const step6 = (over: Record<string, unknown> = {}) => ({
  ...base(6), activeRunId: RUN, readError: false, trigger: "build", dailyCap: 3, auto: false, fanUrls: [], ...over,
});
const step7 = (over: Record<string, unknown> = {}) => ({
  ...base(7), photos: [], albumPhotoIds: [], aiUsed: true, userEdited: false, building: false,
  rebuild: null, captionsPreview: { pages: [] }, banner: null, captionsNote: null, coverPhotoId: null,
  counts: { kept: 9, total: 12 }, ...over,
});

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let served: Record<string, unknown>;
let reload: ReturnType<typeof vi.spyOn>;
let assign: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const m of [mocks.createBookAction, mocks.updateBookSetupAction, mocks.push, mocks.replace, mocks.trackEvent, mocks.track]) m.mockReset();
  served = { "5": step5(), "6": step6(), "7": step7() };
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/ai/runs")) {
      return new Response(JSON.stringify({ runId: RUN, mode: "live", state: "queued" }), { status: 201 });
    }
    const s = new URL(url, "http://x").searchParams.get("step") ?? "";
    return new Response(JSON.stringify(served[s]), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  reload = vi.spyOn(wizardWindow, "reload").mockImplementation(() => {});
  assign = vi.spyOn(wizardWindow, "assign").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  reload.mockRestore();
  assign.mockRestore();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`) as T;
const shownStep = () => $("new-book-wizard").getAttribute("data-step");
const url = () => window.location.pathname + window.location.search;

function render(props: Props) {
  return act(async () => {
    root.render(<NewBookWizard {...props} />);
  });
}

async function mount(href: string, props: Omit<Props, "dashboardBack">) {
  window.history.replaceState(null, "", href);
  await render({ ...props, dashboardBack: <a href="/dashboard" data-testid="wizard-back">Back</a> });
  await settle();
}

async function settle(ms = 20) {
  await act(async () => {
    await tick(ms);
  });
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

async function historyBack() {
  await act(async () => {
    window.history.back();
    await tick(30);
  });
  await settle();
}

async function waitFor(check: () => void, timeout = 1500) {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
    }
    await settle(10);
  }
}

const edit = (bookId = BOOK) => ({ kind: "edit" as const, bookId, draft: DRAFT, designLock: null });
const wizardFetches = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/wizard"));

describe("created → step 5 in place", () => {
  it("no router.push, same band node, step-5 data from the action, book_created once; Back → 4 (edit) → save → 5", async () => {
    mocks.createBookAction.mockResolvedValue({
      ok: true,
      bookId: BOOK,
      next: `/books/${BOOK}/upload?_ev=book_created`,
      step5: step5(),
    });
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft({ ...EMPTY_WIZARD_DRAFT, ...DRAFT }));
    await mount("/books/new?step=4", { initialStep: 4, mode: { kind: "create" } });
    const band = $("wizard-band");
    const shell = $("new-book-wizard");
    const len = window.history.length;

    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    expect(shownStep()).toBe("5");
    expect($("wizard-band")).toBe(band);
    expect($("new-book-wizard")).toBe(shell);
    expect($("wizard-step-panel").getAttribute("data-step-anim")).toBe("css");
    expect($("wizard-step-panel").getAttribute("data-step-dir")).toBe("forward");
    expect($("wizard-stepper").getAttribute("data-step")).toBe("5");
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(url()).toBe(`/books/new?book=${BOOK}&step=5`);
    expect(window.history.length).toBe(len + 1);
    // Step-5 data came with the action: no request for it.
    expect(wizardFetches()).toEqual([]);
    await waitFor(() => expect(mocks.trackEvent).toHaveBeenCalledTimes(1));
    expect(mocks.trackEvent).toHaveBeenCalledWith({ name: "book_created", props: {} });

    // In-page Back from step 5 (before picking) → step 4 of THIS book (edit mode).
    await click($("stub-back"));
    expect(shownStep()).toBe("4");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=4`);
    expect($("new-book-wizard").getAttribute("data-mode")).toBe("edit");
    expect($("wizard-step-panel")).toBeNull();
    expect($("new-book-form").getAttribute("data-step-dir")).toBe("back");
    // Continue saves (no second create) and shows step 5 again in place.
    await click($("wizard-save"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    expect(mocks.updateBookSetupAction).toHaveBeenCalledTimes(1);
    expect(mocks.createBookAction).toHaveBeenCalledTimes(1);
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(url()).toBe(`/books/new?book=${BOOK}&step=5`);
    expect(wizardFetches()).toEqual([`/api/books/${BOOK}/wizard?step=5`]);
    expect($("wizard-band")).toBe(band);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("analytics off (no flash on next) → no book_created from the client", async () => {
    mocks.createBookAction.mockResolvedValue({ ok: true, bookId: BOOK, next: `/books/${BOOK}/upload`, step5: step5() });
    window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft({ ...EMPTY_WIZARD_DRAFT, ...DRAFT }));
    await mount("/books/new?step=4", { initialStep: 4, mode: { kind: "create" } });
    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    await settle(30);
    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });
});

describe("M20 review: no duplicate book, mode guard after the in-place create", () => {
  it("double submit (tap + Enter in one frame) → createBookAction once; Continue stays disabled until step 5", async () => {
    // useActionState queues a second dispatch until the first resolves, so every call answers with
    // success: a duplicate would show up as a second (queued) call after the release.
    const pending: ((v: unknown) => void)[] = [];
    const ok = { ok: true, bookId: BOOK, next: `/books/new?book=${BOOK}&step=5`, step5: step5() };
    let released = false;
    mocks.createBookAction.mockImplementation(() =>
      released ? Promise.resolve(ok) : new Promise((resolve) => pending.push(resolve)),
    );
    window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft({ ...EMPTY_WIZARD_DRAFT, ...DRAFT }));
    await mount("/books/new?step=4", { initialStep: 4, mode: { kind: "create" } });
    const form = $<HTMLFormElement>("new-book-form");
    const button = $<HTMLButtonElement>("create-book");
    await act(async () => {
      form.requestSubmit(button);
      form.requestSubmit(button);
    });
    await settle();
    expect(mocks.createBookAction).toHaveBeenCalledTimes(1);
    expect($<HTMLButtonElement>("create-book").disabled).toBe(true);
    // A late submit while the create is in flight is refused too.
    await act(async () => {
      $<HTMLFormElement>("new-book-form").requestSubmit();
    });
    expect(mocks.createBookAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      released = true;
      for (const r of pending) r(ok);
    });
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    await settle(50);
    expect(mocks.createBookAction).toHaveBeenCalledTimes(1);
    expect(url()).toBe(`/books/new?book=${BOOK}&step=5`);
  });

  it("a failed create re-enables Continue and a retry creates again (once)", async () => {
    mocks.createBookAction.mockResolvedValueOnce({ ok: false, error: "Nope" });
    window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft({ ...EMPTY_WIZARD_DRAFT, ...DRAFT }));
    await mount("/books/new?step=4", { initialStep: 4, mode: { kind: "create" } });
    await click($("create-book"));
    await waitFor(() => expect($("new-book-error")).toBeTruthy());
    expect($<HTMLButtonElement>("create-book").disabled).toBe(false);
    mocks.createBookAction.mockResolvedValueOnce({ ok: true, bookId: BOOK, next: `/books/new?book=${BOOK}&step=5`, step5: step5() });
    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    expect(mocks.createBookAction).toHaveBeenCalledTimes(2);
  });

  it("soft nav to plain /books/new after an in-place create (props still create) → reload", async () => {
    mocks.createBookAction.mockResolvedValue({ ok: true, bookId: BOOK, next: `/books/new?book=${BOOK}&step=5`, step5: step5() });
    window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft({ ...EMPTY_WIZARD_DRAFT, ...DRAFT }));
    await mount("/books/new?step=4", { initialStep: 4, mode: { kind: "create" } });
    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    expect(reload).not.toHaveBeenCalled();
    window.history.pushState(null, "", "/books/new");
    await render({ initialStep: 1, mode: { kind: "create" }, dashboardBack: <a href="/dashboard">Back</a> });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("Make my book now → step 6; Back / browser Back can't reopen step 5 while the run starts", async () => {
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5() as never });
    served["6"] = step6({ activeRunId: null });
    await click($("stub-build-now"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    await historyBack();
    expect(shownStep()).toBe("6");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=6`);
    expect($("stub-photos")).toBeNull();
  });
});

describe("popstate guards via the flow", () => {
  it("step 5 before picking: browser Back → step 4 (edit); after picking: Back stays on 5", async () => {
    window.history.replaceState(null, "", `/books/new?book=${BOOK}&step=4`);
    window.history.pushState({ wizardStep: 5, wizardPrev: 4 }, "", `/books/new?book=${BOOK}&step=5`);
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5() as never });
    expect(shownStep()).toBe("5");
    await historyBack();
    expect(shownStep()).toBe("4");
    // forward again, pick photos, then Back is refused
    await act(async () => {
      window.history.forward();
      await tick(30);
    });
    await settle();
    expect(shownStep()).toBe("5");
    await click($("stub-pick"));
    await historyBack();
    expect(shownStep()).toBe("5");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=5`);
    // stepper: steps 1–4 locked now
    expect($("wizard-step-4").tagName).not.toBe("BUTTON");
  });

  it("step 6 (run): browser Back stays on 6", async () => {
    window.history.replaceState(null, "", `/books/new?book=${BOOK}&step=5`);
    window.history.pushState({ wizardStep: 6, wizardPrev: 5 }, "", `/books/new?book=${BOOK}&step=6`);
    await mount(`/books/new?book=${BOOK}&step=6`, { initialStep: 6, mode: edit(), initialData: step6() as never });
    expect($("stub-sorting").getAttribute("data-run")).toBe(RUN);
    await historyBack();
    expect(shownStep()).toBe("6");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=6`);
  });

  it("bug 6: a router rewriting the URL after popstate → the wizard re-asserts its own (history.state kept)", async () => {
    window.history.replaceState(null, "", `/books/new?book=${BOOK}&step=5`);
    window.history.pushState({ wizardStep: 6, wizardPrev: 5 }, "", `/books/new?book=${BOOK}&step=6`);
    await mount(`/books/new?book=${BOOK}&step=6`, { initialStep: 6, mode: edit(), initialData: step6() as never });
    // Stand-in for Next's app router: handles the same popstate after the wizard (registered later)
    // and writes the entry's URL + its own router state back — once synchronously, once a bit later
    // (its restore render committing).
    const stale = `/books/new?book=${BOOK}&step=5`;
    const router = () => {
      window.history.replaceState({ ...(window.history.state ?? {}), __NA: true, tree: "restored" }, "", stale);
      setTimeout(() => window.history.replaceState({ ...(window.history.state ?? {}), __NA: true }, "", stale), 30);
    };
    window.addEventListener("popstate", router);
    try {
      await historyBack();
      await settle(300);
    } finally {
      window.removeEventListener("popstate", router);
    }
    expect(shownStep()).toBe("6");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=6`);
    // Next's router data survives; only the wizard's keys changed.
    expect(window.history.state).toMatchObject({ __NA: true, tree: "restored", wizardStep: 6 });
  });

  it("bug 6: the re-assert never pulls back a navigation away from /books/new, nor fights a newer step change", async () => {
    window.history.replaceState(null, "", `/books/new?book=${BOOK}&step=5`);
    window.history.pushState({ wizardStep: 6, wizardPrev: 5 }, "", `/books/new?book=${BOOK}&step=6`);
    await mount(`/books/new?book=${BOOK}&step=6`, { initialStep: 6, mode: edit(), initialData: step6() as never });
    const away = () => window.history.replaceState(window.history.state, "", "/dashboard");
    window.addEventListener("popstate", away);
    try {
      await historyBack();
      await settle(300);
    } finally {
      window.removeEventListener("popstate", away);
    }
    expect(url()).toBe("/dashboard");
  });

  it("an entry naming another book → reload", async () => {
    window.history.replaceState(null, "", `/books/new?book=${OTHER}&step=4`);
    window.history.pushState(null, "", `/books/new?book=${BOOK}&step=5`);
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5() as never });
    await historyBack();
    expect(reload).toHaveBeenCalled();
  });
});

describe("auto-start outcome → step 6 / 7 / editor", () => {
  it("started → step 6 (push, ?auto=1 data) → build done → step 7 (replace) → Generate album → editor", async () => {
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5() as never });
    served["6"] = step6({ auto: true });
    await click($("stub-pick"));
    await click($("stub-started"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(shownStep()).toBe("6");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=6`);
    expect(window.history.state).toMatchObject({ wizardStep: 6, wizardPrev: 5 }); // pushed
    const len = window.history.length;
    const content = $("wizard-content");
    expect($("wizard-aside")).toBeTruthy(); // sorting keeps the live preview aside
    expect(wizardFetches()).toEqual([`/api/books/${BOOK}/wizard?step=6&auto=1`]);
    expect($("stub-sorting").getAttribute("data-auto")).toBe("true");

    await click($("stub-done"));
    await waitFor(() => expect($("stub-review")).toBeTruthy());
    expect(shownStep()).toBe("7");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
    expect(window.history.length).toBe(len); // sorting replaced
    // Review drops the aside and takes the full library width — same content column node.
    expect($("wizard-aside")).toBeNull();
    expect($("wizard-content")).toBe(content);
    expect($("wizard-content").className).not.toContain("max-w-");
    expect($("stub-review").getAttribute("data-kept")).toBe("9");
    expect(assign).not.toHaveBeenCalled();

    await click($("stub-confirm"));
    expect(assign).toHaveBeenCalledWith(`/books/${BOOK}/edit`);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("not_first (no active run at load) → step 7 by replace", async () => {
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5() as never });
    const len = window.history.length;
    await click($("stub-not-first"));
    await waitFor(() => expect($("stub-review")).toBeTruthy());
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
    expect(window.history.length).toBe(len);
  });

  it("user_edited → the editor (the one real navigation)", async () => {
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5() as never });
    await click($("stub-user-edited"));
    expect(assign).toHaveBeenCalledWith(`/books/${BOOK}/edit`);
  });

  it("fallback Make my book now → step 6 without ?auto", async () => {
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5() as never });
    served["6"] = step6({ activeRunId: null });
    await click($("stub-build-now"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(wizardFetches()).toEqual([`/api/books/${BOOK}/wizard?step=6`]);
    expect($("stub-sorting").getAttribute("data-run")).toBe("");
  });
});

describe("M20b: every first build goes through step 6 (AI off / rule runs included)", () => {
  it("a rule run done inside the POST → step 6 with the hand-over (never the editor), then 7", async () => {
    // The gate already says 7 (the run finished) — step 6 must still play it through.
    served["6"] = step6({ activeRunId: null, resolved: 7, aiOn: false });
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5({ aiOn: false }) as never });
    await click($("stub-pick"));
    await click($("stub-rule-done"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(shownStep()).toBe("6");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=6`);
    expect($("stub-sorting").getAttribute("data-handover")).toBe("yes");
    expect(assign).not.toHaveBeenCalled(); // no editor jump
    expect($("stub-review")).toBeNull();
    await click($("stub-done"));
    await waitFor(() => expect($("stub-review")).toBeTruthy());
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
    expect(assign).not.toHaveBeenCalled();
  });

  it("answer still pending after the success moment → step 6 at once, step 5 locked", async () => {
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5() as never });
    await click($("stub-pick"));
    await click($("stub-pending"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(url()).toBe(`/books/new?book=${BOOK}&step=6`);
    expect($("stub-sorting").getAttribute("data-handover")).toBe("yes");
    expect(wizardFetches().some((u) => u.includes("step=6") && u.includes("auto=1"))).toBe(true);
    await historyBack();
    expect(shownStep()).toBe("6"); // step 5 can't come back while the run starts
    expect(assign).not.toHaveBeenCalled();
  });

  it("without a hand-over, step 6 data the gate moved on (finished run) still follows the gate → 7", async () => {
    served["6"] = step6({ activeRunId: null, resolved: 7 });
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5() as never });
    await click($("stub-build-now"));
    await waitFor(() => expect($("stub-review")).toBeTruthy());
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
  });
});

describe("step data and the server", () => {
  it("step data the gate moved on (5 asked, run finished → 7) follows the gate", async () => {
    served["5"] = step5({ resolved: 7 });
    window.sessionStorage.clear();
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    await mount(`/books/new?book=${BOOK}&step=4`, { initialStep: 4, mode: edit() });
    await click($("wizard-save"));
    await waitFor(() => expect($("stub-review")).toBeTruthy());
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
  });

  it("a load error offers Try again", async () => {
    await mount(`/books/new?book=${BOOK}&step=4`, { initialStep: 4, mode: edit() });
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 503 }));
    await click($("wizard-save"));
    await waitFor(() => expect($("wizard-step-error")).toBeTruthy());
    await click($("wizard-step-retry"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
  });

  it("hard load: the URL is made to match the step the server resolved", async () => {
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 7, mode: edit(), initialData: step7() as never });
    expect(shownStep()).toBe("7");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
  });

  it("mode guard: the server sends another book → reload; the same book → no reload", async () => {
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: step5() as never });
    const dashboardBack = <a href="/dashboard">Back</a>;
    await render({ initialStep: 5, mode: edit(), initialData: step5() as never, dashboardBack });
    expect(reload).not.toHaveBeenCalled();
    await render({ initialStep: 4, mode: edit(OTHER), dashboardBack });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("mode guard: a create-mode server render after the in-place create, at an edit URL (revalidation) → kept", async () => {
    mocks.createBookAction.mockResolvedValue({ ok: true, bookId: BOOK, next: `/books/${BOOK}/upload`, step5: step5() });
    window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft({ ...EMPTY_WIZARD_DRAFT, ...DRAFT }));
    await mount("/books/new?step=4", { initialStep: 4, mode: { kind: "create" } });
    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    // revalidatePath in a later server action re-renders the page at the current (edit) URL
    await render({ initialStep: 5, mode: edit(), initialData: step5() as never, dashboardBack: <a href="/dashboard">Back</a> });
    expect(reload).not.toHaveBeenCalled();
    expect($("stub-photos")).toBeTruthy();
  });
});

// --- Uploader (wizard): settled → advance -----------------------------------------------------------

describe("Uploader wizard: advance after burst + auto-start answer", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
  });

  const uploaderProps = {
    bookId: BOOK, userId: "u1", isPaid: false, existing: [], maxUpload: 150, readyCount: 0, pendingCount: 0,
    hasDoc: false, firstRun: "none" as const, dailyCap: 3,
  };

  async function pick(n: number) {
    const input = container.querySelector<HTMLInputElement>('[data-testid="upload-input"]')!;
    const files = Array.from({ length: n }, (_, i) => new File(["x"], `p${i}.jpg`, { type: "image/jpeg" }));
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await tick(30);
    });
    await settle(30);
  }

  it("keeps the stage mounted (settled) through finalize + start; onAdvance only after onSettled; never router.push", async () => {
    const onAdvance = vi.fn();
    const onPhotosPicked = vi.fn();
    const onBack = vi.fn();
    await act(async () => {
      root.render(<Uploader {...uploaderProps} variant="wizard" onAdvance={onAdvance} onPhotosPicked={onPhotosPicked} onBack={onBack} />);
    });
    // Back is a button (no server link), shown before picking; the pick area wears the T5 art.
    expect($("wizard-back").tagName).toBe("BUTTON");
    expect($("upload-pick").querySelector('[data-testid="upload-pick-art"]')).toBeTruthy();
    await pick(5);
    expect(onPhotosPicked).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/ai/runs")).toBe(true));
    await settle(30);
    expect($("stub-progress").getAttribute("data-variant")).toBe("wizard");
    expect($("stub-progress").getAttribute("data-settled")).toBe("true");
    expect($("upload-summary")).toBeNull();
    expect($("wizard-back")).toBeNull();
    expect(onAdvance).not.toHaveBeenCalled();
    await click($("stub-settle"));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(onAdvance).toHaveBeenCalledWith({ kind: "started", runId: RUN, mode: "live", state: "queued" });
    expect(mocks.push).not.toHaveBeenCalled();
    // a second burst callback doesn't advance twice
    await click($("stub-settle"));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("burst first, answer later → advances on the answer", async () => {
    const onAdvance = vi.fn();
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(async (u: string) =>
      u === "/api/ai/runs" ? new Promise<Response>((r) => (release = r)) : new Response("{}", { status: 404 }),
    );
    await act(async () => {
      root.render(<Uploader {...uploaderProps} variant="wizard" onAdvance={onAdvance} />);
    });
    await pick(6);
    await waitFor(() => expect($("stub-progress")).toBeTruthy());
    await click($("stub-settle"));
    expect(onAdvance).not.toHaveBeenCalled();
    await act(async () => {
      release(new Response(JSON.stringify({ error: "already_running", runId: RUN }), { status: 409 }));
      await tick(30);
    });
    await settle(30);
    expect(onAdvance).toHaveBeenCalledWith({ kind: "already_running", runId: RUN });
  });

  it("M20b: burst first, answer pending → onAdvancePending(the request) right after the burst; the stage never says sorting", async () => {
    const onAdvance = vi.fn();
    const onAdvancePending = vi.fn();
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(async (u: string) =>
      u === "/api/ai/runs" ? new Promise<Response>((r) => (release = r)) : new Response("{}", { status: 404 }),
    );
    await act(async () => {
      root.render(<Uploader {...uploaderProps} variant="wizard" onAdvance={onAdvance} onAdvancePending={onAdvancePending} />);
    });
    await pick(6);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/ai/runs")).toBe(true));
    // upload only: no "Starting your book…" bar, no sorting copy anywhere on step 5
    expect($("upload-auto-starting")).toBeNull();
    expect($("upload-summary")).toBeNull();
    expect(container.textContent ?? "").not.toMatch(/sort|starting your book/i);
    expect(onAdvancePending).not.toHaveBeenCalled(); // waits for the success burst
    await click($("stub-settle"));
    // …and gives a quick answer HANDOVER_GRACE_MS (from the request) to land before handing over
    expect(onAdvancePending).not.toHaveBeenCalled();
    await settle(HANDOVER_GRACE_MS + 50);
    expect(onAdvancePending).toHaveBeenCalledTimes(1);
    expect(container.textContent ?? "").not.toMatch(/sort|starting your book/i);
    expect(onAdvance).not.toHaveBeenCalled();
    const handed = onAdvancePending.mock.calls[0][0] as Promise<unknown>;
    // the handed promise is the request itself: it resolves with the server's answer
    await act(async () => {
      release(new Response(JSON.stringify({ runId: RUN, mode: "rule", state: "done" }), { status: 201 }));
      await tick(30);
    });
    await expect(handed).resolves.toEqual({ kind: "started", runId: RUN, mode: "rule", state: "done" });
    await settle(30);
    expect(onAdvance).not.toHaveBeenCalled(); // handed over once, never twice
    expect(mocks.push).not.toHaveBeenCalled();
    // step 6 reports ai_build_done for the rule run — not the upload screen
    expect(mocks.track).not.toHaveBeenCalledWith("ai_build_done", expect.anything());
  });

  it("M20b: a rule run done before the burst ends → onAdvance(answer) after the burst, no rules tracking here", async () => {
    const onAdvance = vi.fn();
    fetchMock.mockImplementation(async (u: string) =>
      u === "/api/ai/runs"
        ? new Response(JSON.stringify({ runId: RUN, mode: "rule", state: "done" }), { status: 201 })
        : new Response("{}", { status: 404 }),
    );
    await act(async () => {
      root.render(<Uploader {...uploaderProps} variant="wizard" aiOn={false} onAdvance={onAdvance} onAdvancePending={vi.fn()} />);
    });
    await pick(5);
    await settle(60);
    expect(onAdvance).not.toHaveBeenCalled();
    await click($("stub-settle"));
    expect(onAdvance).toHaveBeenCalledWith({ kind: "started", runId: RUN, mode: "rule", state: "done" });
    expect(mocks.track).not.toHaveBeenCalledWith("ai_build_done", expect.anything());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("M20b: a fallback answer before the burst ends stays on step 5 (Make my book now), nothing handed over", async () => {
    const onAdvance = vi.fn();
    const onAdvancePending = vi.fn();
    fetchMock.mockImplementation(async (u: string) =>
      u === "/api/ai/runs"
        ? new Response(JSON.stringify({ error: "limit", limit: "daily_builds" }), { status: 429 })
        : new Response("{}", { status: 404 }),
    );
    await act(async () => {
      root.render(<Uploader {...uploaderProps} variant="wizard" onAdvance={onAdvance} onAdvancePending={onAdvancePending} onBuildNow={vi.fn()} />);
    });
    await pick(5);
    await settle(60);
    await waitFor(() => expect($("build-album")).toBeTruthy());
    expect(onAdvance).not.toHaveBeenCalled();
    expect(onAdvancePending).not.toHaveBeenCalled();
  });

  it("classic Uploader: a rule run done inside the POST → editor + ai_build_done rules (unchanged)", async () => {
    fetchMock.mockImplementation(async (u: string) =>
      u === "/api/ai/runs"
        ? new Response(JSON.stringify({ runId: RUN, mode: "rule", state: "done" }), { status: 201 })
        : new Response("{}", { status: 404 }),
    );
    await act(async () => {
      root.render(<Uploader {...uploaderProps} />);
    });
    await pick(5);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/books/${BOOK}/edit`));
    expect(mocks.track).toHaveBeenCalledWith("ai_build_done", expect.objectContaining({ mode: "rules", outcome: "ok", auto: true }));
  });

  it("classic Uploader unchanged: router.push to the build screen", async () => {
    await act(async () => {
      root.render(<Uploader {...uploaderProps} />);
    });
    await pick(5);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/books/${BOOK}/build?auto=1`));
  });
});
