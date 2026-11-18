// @vitest-environment jsdom
// M20 T6 (D-072), Task 5 order: one continuous wizard on /books/new. In a DOM:
//   - created (on step-2 Continue) → step 3 Photos in place (no router.push, same band node,
//     book_created once from the flash); step-3 Back → step 2 edit → save → step 3 again (one book)
//   - 3 Photos → 4 Story → 5 Design: NO build is asked for on step 3; the story copy and the design
//     pick survive Back / Forward; the design is saved only when it differs, then the build is asked
//     for on step-5 Continue → step 6 (+ ?auto=1 data) / step 7 / editor; build done → 7 by replace
//   - popstate guards via the flow (photos picked → 1–2 locked; uploading → stays on 3; run → Back
//     stays on 6)
//   - hard-load data the gate moved on (3 → 7) and the mode guard (another book → reload)
//   - Uploader (wizard): never starts a build — "Continue" after the upload; classic Uploader still
//     router.push-es.
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
vi.mock("@/app/books/story-actions", () => ({
  loadStoryAnswersAction: vi.fn(),
  saveStoryAnswersAction: vi.fn(),
  recommendDesignAction: vi.fn(),
}));

type Cb = () => void;
vi.mock("@/components/books/wizard/steps/StepPhotos", () => ({
  StepPhotos: (p: {
    data: { bookId: string; readyCount: number };
    headlineId: string;
    onBack: Cb;
    onPhotosPicked: Cb;
    onContinue: (ready: number) => void;
    onBusyChange?: (busy: boolean) => void;
  }) => (
    <div data-testid="stub-photos" data-book={p.data.bookId} data-ready={p.data.readyCount}>
      <h1 id={p.headlineId} tabIndex={-1}>Add your photos</h1>
      <button type="button" data-testid="stub-back" onClick={p.onBack} />
      <button type="button" data-testid="stub-pick" onClick={p.onPhotosPicked} />
      <button type="button" data-testid="stub-busy" onClick={() => p.onBusyChange?.(true)} />
      <button type="button" data-testid="stub-idle" onClick={() => p.onBusyChange?.(false)} />
      <button type="button" data-testid="stub-continue" onClick={() => p.onContinue(6)} />
      <button type="button" data-testid="stub-continue-few" onClick={() => p.onContinue(3)} />
    </div>
  ),
}));
vi.mock("@/components/books/wizard/steps/StepStory", () => ({
  StepStory: (p: {
    bookId: string;
    occasion: string | null;
    headlineId: string;
    value: { answers: Record<string, string>; storyTone: string | null } | null;
    onChange: (v: unknown) => void;
    onBack: Cb;
    onContinue: Cb;
  }) => (
    <div data-testid="stub-story" data-book={p.bookId} data-occasion={p.occasion ?? ""} data-value={JSON.stringify(p.value)}>
      <h1 id={p.headlineId} tabIndex={-1}>Every memory has a story.</h1>
      <button
        type="button"
        data-testid="stub-story-type"
        onClick={() => p.onChange({ storyTone: "joyful", answers: { "travel.companions": "My sister" }, touched: true, loaded: "loaded" })}
      />
      <button type="button" data-testid="stub-story-back" onClick={p.onBack} />
      <button type="button" data-testid="stub-story-continue" onClick={p.onContinue} />
    </div>
  ),
}));
vi.mock("@/components/books/wizard/steps/StepDesign", () => ({
  StepDesign: (p: {
    bookId: string;
    headlineId: string;
    stored: unknown;
    pick: { format: string | null; designStyle: string | null };
    onPick: (pick: unknown) => void;
    recommendation: unknown;
    onRecommendation: (r: unknown) => void;
    error?: string | null;
    buildError?: string | null;
    pending?: boolean;
    onBack: Cb;
    onContinue: Cb;
  }) => (
    <div
      data-testid="stub-design"
      data-stored={JSON.stringify(p.stored)}
      data-pick={JSON.stringify(p.pick)}
      data-rec={JSON.stringify(p.recommendation)}
      data-error={p.error ?? ""}
      data-build-error={p.buildError ?? ""}
      data-pending={String(!!p.pending)}
    >
      <h1 id={p.headlineId} tabIndex={-1}>Choose your book design</h1>
      <button type="button" data-testid="stub-pick-landscape" onClick={() => p.onPick({ ...p.pick, format: "A5_LANDSCAPE" })} />
      <button type="button" data-testid="stub-pick-classic" onClick={() => p.onPick({ ...p.pick, designStyle: "classic" })} />
      <button
        type="button"
        data-testid="stub-recommend"
        onClick={() =>
          p.onRecommendation({ format: "A5_LANDSCAPE", formatReason: "mostly_landscape", designStyle: "editorial", styleReason: "occasion_default" })
        }
      />
      <button
        type="button"
        data-testid="stub-recommend-portrait"
        onClick={() =>
          p.onRecommendation({ format: "A5_PORTRAIT", formatReason: "mostly_portrait", designStyle: "scrapbook", styleReason: "occasion_default" })
        }
      />
      <button type="button" data-testid="stub-design-back" onClick={p.onBack} />
      <button type="button" data-testid="stub-design-continue" onClick={p.onContinue} />
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
const { WIZARD_CONFIRMED_STORAGE_KEY, rememberAlbumConfirmed, forgetAlbumConfirmed, wasAlbumConfirmedHere } = await import(
  "@/lib/books/wizard-confirmed"
);
const { Uploader } = await import("@/components/upload/Uploader");
const { DESIGN_HANDOVER_GRACE_MS, BUILD_START_FAILED } = await import("@/components/books/wizard/steps/WizardDataSteps");
const { designPickStorageKey, serializeDesignPick } = await import("@/lib/books/design-choice");
const { WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft, EMPTY_WIZARD_DRAFT } = await import("@/lib/books/wizard-steps");
type Props = import("@/components/books/NewBookWizard").NewBookWizardProps;
type WizardDraft = import("@/lib/books/wizard-steps").WizardDraft;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The provisional design of a new travel book: the default shape + the occasion's style (Magazine).
const DRAFT: WizardDraft = { title: "Sea days", occasion: "travel", format: "A5_PORTRAIT", designStyle: "magazine" };
const base = (step: number, bookId = BOOK) => ({
  step, bookId, title: "Sea days", rawTitle: "Sea days", occasion: "travel", format: "A5_PORTRAIT",
  designStyle: "magazine", captionLang: "en", isPaid: false, aiOn: true, resolved: step,
});
const step3 = (over: Record<string, unknown> = {}) => ({
  ...base(3), userId: "u1", existing: [], maxUpload: 150, readyCount: 0, pendingCount: 0, hasDoc: false,
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
  served = { "3": step3(), "6": step6(), "7": step7() };
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
const buildPosts = () => fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/ai/runs");
/** A book that already has photos (what the server sends on a hard load of steps 3–5). */
const withPhotos = (over: Record<string, unknown> = {}) =>
  step3({ existing: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, fingerprint: `f${i}`, upload_state: "ready" })), readyCount: 6, hasDoc: true, ...over });
const previewAttr = (name: string) => $("wizard-aside").querySelector('[data-testid="wizard-preview"]')!.getAttribute(name);
const FORM_DRAFT = { title: "Sea days", occasion: "travel" as const };
const storeFormDraft = () =>
  window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft({ ...EMPTY_WIZARD_DRAFT, ...FORM_DRAFT }));
const created = (over: Record<string, unknown> = {}) => ({ ok: true, bookId: BOOK, next: `/books/new?book=${BOOK}&step=3`, step3: step3(), ...over });
/** Hard load of the Design step of a book with photos. */
const mountDesign = (data: Record<string, unknown> = withPhotos()) =>
  mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode: edit(), initialData: data as never });


describe("created → step 3 (Photos) in place", () => {
  it("no router.push, same band node, step-3 data from the action, book_created once, no build; Back → 2 (edit) → save → 3", async () => {
    mocks.createBookAction.mockResolvedValue(created({ next: `/books/new?book=${BOOK}&step=3&_ev=book_created` }));
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    storeFormDraft();
    await mount("/books/new?step=2", { initialStep: 2, mode: { kind: "create" } });
    const band = $("wizard-band");
    const shell = $("new-book-wizard");
    const len = window.history.length;

    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    expect(shownStep()).toBe("3");
    expect($("wizard-band")).toBe(band);
    expect($("new-book-wizard")).toBe(shell);
    expect($("wizard-step-panel").getAttribute("data-step-anim")).toBe("css");
    expect($("wizard-step-panel").getAttribute("data-step-dir")).toBe("forward");
    expect($("wizard-stepper").getAttribute("data-step")).toBe("3");
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(url()).toBe(`/books/new?book=${BOOK}&step=3`);
    expect(window.history.length).toBe(len + 1);
    // Step-3 data came with the action: no request for it. Creating the book starts no build.
    expect(wizardFetches()).toEqual([]);
    expect(buildPosts()).toEqual([]);
    await waitFor(() => expect(mocks.trackEvent).toHaveBeenCalledTimes(1));
    expect(mocks.trackEvent).toHaveBeenCalledWith({ name: "book_created", props: {} });

    // In-page Back from step 3 (before picking) → step 2 of THIS book (edit mode).
    await click($("stub-back"));
    expect(shownStep()).toBe("2");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=2`);
    expect($("new-book-wizard").getAttribute("data-mode")).toBe("edit");
    expect($("wizard-step-panel")).toBeNull();
    expect($("new-book-form").getAttribute("data-step-dir")).toBe("back");
    // Continue saves (no second create) and shows step 3 again in place.
    await click($("wizard-save"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    expect(mocks.updateBookSetupAction).toHaveBeenCalledTimes(1);
    expect(mocks.updateBookSetupAction).toHaveBeenCalledWith(BOOK, { title: "Sea days", occasion: "travel" });
    expect(mocks.createBookAction).toHaveBeenCalledTimes(1);
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(url()).toBe(`/books/new?book=${BOOK}&step=3`);
    expect(wizardFetches()).toEqual([`/api/books/${BOOK}/wizard?step=3`]);
    expect($("wizard-band")).toBe(band);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("analytics off (no flash on next) → no book_created from the client", async () => {
    mocks.createBookAction.mockResolvedValue(created());
    storeFormDraft();
    await mount("/books/new?step=2", { initialStep: 2, mode: { kind: "create" } });
    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    await settle(30);
    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });
});

describe("M20 review: no duplicate book, mode guard after the in-place create", () => {
  it("double submit (tap + Enter in one frame) → createBookAction once; Continue stays disabled until step 3", async () => {
    // useActionState queues a second dispatch until the first resolves, so every call answers with
    // success: a duplicate would show up as a second (queued) call after the release.
    const pending: ((v: unknown) => void)[] = [];
    const ok = created();
    let released = false;
    mocks.createBookAction.mockImplementation(() =>
      released ? Promise.resolve(ok) : new Promise((resolve) => pending.push(resolve)),
    );
    storeFormDraft();
    await mount("/books/new?step=2", { initialStep: 2, mode: { kind: "create" } });
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
    expect(url()).toBe(`/books/new?book=${BOOK}&step=3`);
  });

  it("a failed create re-enables Continue and a retry creates again (once)", async () => {
    mocks.createBookAction.mockResolvedValueOnce({ ok: false, error: "Nope" });
    storeFormDraft();
    await mount("/books/new?step=2", { initialStep: 2, mode: { kind: "create" } });
    await click($("create-book"));
    await waitFor(() => expect($("new-book-error")).toBeTruthy());
    expect($<HTMLButtonElement>("create-book").disabled).toBe(false);
    mocks.createBookAction.mockResolvedValueOnce(created());
    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    expect(mocks.createBookAction).toHaveBeenCalledTimes(2);
  });

  it("soft nav to plain /books/new after an in-place create (props still create) → reload", async () => {
    mocks.createBookAction.mockResolvedValue(created());
    storeFormDraft();
    await mount("/books/new?step=2", { initialStep: 2, mode: { kind: "create" } });
    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    expect(reload).not.toHaveBeenCalled();
    window.history.pushState(null, "", "/books/new");
    await render({ initialStep: 1, mode: { kind: "create" }, dashboardBack: <a href="/dashboard">Back</a> });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("Task 5: Photos → Story → Design — the build starts on step-5 Continue, never on step 3", () => {
  it("create → photos → Continue → Story → Continue → Design: no build request and no design save on the way", async () => {
    mocks.createBookAction.mockResolvedValue(created());
    storeFormDraft();
    await mount("/books/new?step=2", { initialStep: 2, mode: { kind: "create" } });
    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    // Without a photo Continue does nothing… (the real step doesn't even offer it)
    await click($("stub-pick"));
    await click($("stub-continue"));
    await waitFor(() => expect($("stub-story")).toBeTruthy());
    expect(shownStep()).toBe("4");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=4`);
    expect(window.history.state).toMatchObject({ wizardStep: 4, wizardPrev: 3 });
    expect($("wizard-step-label").textContent).toBe("Step 4 of 7");
    expect($("stub-story").getAttribute("data-occasion")).toBe("travel");
    expect($("stub-story").getAttribute("data-value")).toBe("null"); // nothing invented, nothing prefilled
    expect(document.activeElement?.textContent).toBe("Every memory has a story.");

    await click($("stub-story-continue"));
    await waitFor(() => expect($("stub-design")).toBeTruthy());
    expect(shownStep()).toBe("5");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=5`);
    // The provisional design the server stored for the new book; the user hasn't chosen yet.
    expect(JSON.parse($("stub-design").getAttribute("data-stored")!)).toEqual({ format: "A5_PORTRAIT", designStyle: "magazine" });
    expect(JSON.parse($("stub-design").getAttribute("data-pick")!)).toEqual({ format: null, designStyle: null });
    expect(buildPosts()).toEqual([]);
    expect(mocks.updateBookSetupAction).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    // Steps 1–2 are locked now (photos are in); 3–4 can be revisited from the stepper.
    expect($("wizard-step-2").querySelector("button")).toBeNull();
    expect($("wizard-step-3-button")).toBeTruthy();
    expect($("wizard-step-4-button")).toBeTruthy();
  });

  it("the story copy survives Back / Forward (the wizard keeps it); the Photos step refetches its data on return", async () => {
    await mount(`/books/new?book=${BOOK}&step=3`, { initialStep: 3, mode: edit(), initialData: withPhotos() as never });
    served["3"] = withPhotos({ readyCount: 9 });
    await click($("stub-continue"));
    await waitFor(() => expect($("stub-story")).toBeTruthy());
    await click($("stub-story-type"));
    const typed = $("stub-story").getAttribute("data-value");
    expect(JSON.parse(typed!)).toMatchObject({ storyTone: "joyful", answers: { "travel.companions": "My sister" } });
    // forward to Design and back
    await click($("stub-story-continue"));
    await waitFor(() => expect($("stub-design")).toBeTruthy());
    await click($("stub-design-back"));
    await waitFor(() => expect($("stub-story")).toBeTruthy());
    expect($("stub-story").getAttribute("data-value")).toBe(typed);
    // back to Photos: fresh data (the upload list must match the book), then forward again
    await click($("stub-story-back"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    expect(wizardFetches()).toEqual([`/api/books/${BOOK}/wizard?step=3`]);
    expect($("stub-photos").getAttribute("data-ready")).toBe("9");
    await act(async () => {
      window.history.forward();
      await tick(30);
    });
    await settle();
    expect(shownStep()).toBe("4");
    expect($("stub-story").getAttribute("data-value")).toBe(typed);
    expect(buildPosts()).toEqual([]);
  });

  it("Design Continue with the stored design unchanged: no save, ONE build request → step 6 (push, ?auto=1 data) → 7 (replace) → editor", async () => {
    await mountDesign();
    served["6"] = step6({ auto: true });
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(mocks.updateBookSetupAction).not.toHaveBeenCalled();
    expect(buildPosts()).toHaveLength(1);
    expect(JSON.parse(String((buildPosts()[0][1] as RequestInit).body))).toEqual({ bookId: BOOK, auto: true });
    expect(shownStep()).toBe("6");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=6`);
    expect(window.history.state).toMatchObject({ wizardStep: 6, wizardPrev: 5 }); // pushed
    const len = window.history.length;
    const content = $("wizard-content");
    expect($("wizard-aside")).toBeTruthy(); // the build step keeps the live preview aside
    expect(wizardFetches()).toEqual([`/api/books/${BOOK}/wizard?step=6&auto=1`]);
    expect($("stub-sorting").getAttribute("data-auto")).toBe("true");
    expect($("stub-sorting").getAttribute("data-handover")).toBe("yes");

    await click($("stub-done"));
    await waitFor(() => expect($("stub-review")).toBeTruthy());
    expect(shownStep()).toBe("7");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
    expect(window.history.length).toBe(len); // the build step replaced
    // Preview drops the aside and takes the full library width — same content column node.
    expect($("wizard-aside")).toBeNull();
    expect($("wizard-content")).toBe(content);
    expect($("wizard-content").className).not.toContain("max-w-");
    expect($("stub-review").getAttribute("data-kept")).toBe("9");
    expect(assign).not.toHaveBeenCalled();

    await click($("stub-confirm"));
    expect(assign).toHaveBeenCalledWith(`/books/${BOOK}/edit`);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(buildPosts()).toHaveLength(1);
  });

  it("a changed design is saved FIRST (updateBookSetupAction, shape + style only), then the build is asked for", async () => {
    const order: string[] = [];
    mocks.updateBookSetupAction.mockImplementation(async () => {
      order.push("save");
      return { ok: true, setup: {}, relaidOut: true };
    });
    fetchMock.mockImplementation(async (u: string) => {
      if (u === "/api/ai/runs") {
        order.push("build");
        return new Response(JSON.stringify({ runId: RUN, mode: "live", state: "queued" }), { status: 201 });
      }
      return new Response(JSON.stringify(served[new URL(u, "http://x").searchParams.get("step") ?? ""]), { status: 200 });
    });
    await mountDesign();
    await click($("stub-pick-landscape"));
    expect(previewAttr("data-format")).toBe("A5_LANDSCAPE");
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(mocks.updateBookSetupAction).toHaveBeenCalledTimes(1);
    expect(mocks.updateBookSetupAction).toHaveBeenCalledWith(BOOK, { format: "A5_LANDSCAPE", designStyle: "magazine" });
    expect(order).toEqual(["save", "build"]);
  });

  it("a recommendation is preselected only while the user hasn't chosen; a manual pick wins and survives a new recommendation", async () => {
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: true });
    await mountDesign();
    expect(previewAttr("data-format")).toBe("A5_PORTRAIT");
    expect(previewAttr("data-style")).toBe("magazine");
    expect(previewAttr("data-open")).toBe("true");
    // Recommendation arrives: both fields follow it (nothing chosen yet).
    await click($("stub-recommend"));
    expect(previewAttr("data-format")).toBe("A5_LANDSCAPE");
    expect(previewAttr("data-style")).toBe("editorial");
    expect(JSON.parse($("stub-design").getAttribute("data-pick")!)).toEqual({ format: null, designStyle: null });
    // The user picks a style by hand; a later (different) recommendation moves only the shape.
    await click($("stub-pick-classic"));
    expect(previewAttr("data-style")).toBe("classic");
    await click($("stub-recommend-portrait"));
    expect(previewAttr("data-format")).toBe("A5_PORTRAIT");
    expect(previewAttr("data-style")).toBe("classic");
    await click($("stub-pick-landscape"));
    await click($("stub-recommend-portrait"));
    expect(previewAttr("data-format")).toBe("A5_LANDSCAPE");
    // Back / Forward keep the picks.
    await click($("stub-design-back"));
    await waitFor(() => expect($("stub-story")).toBeTruthy());
    await click($("stub-story-continue"));
    await waitFor(() => expect($("stub-design")).toBeTruthy());
    expect(JSON.parse($("stub-design").getAttribute("data-pick")!)).toEqual({ format: "A5_LANDSCAPE", designStyle: "classic" });
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(mocks.updateBookSetupAction).toHaveBeenCalledWith(BOOK, { format: "A5_LANDSCAPE", designStyle: "classic" });
  });

  it("an accepted recommendation (never touched) is what gets saved when it differs from the provisional design", async () => {
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: true });
    await mountDesign();
    await click($("stub-recommend"));
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(mocks.updateBookSetupAction).toHaveBeenCalledWith(BOOK, { format: "A5_LANDSCAPE", designStyle: "editorial" });
  });

  it("a refresh on the Design step keeps the user's own pick (sessionStorage), over the stored design and the recommendation", async () => {
    window.sessionStorage.setItem(designPickStorageKey(BOOK), serializeDesignPick({ format: "A5_LANDSCAPE", designStyle: null }));
    await mountDesign();
    expect(JSON.parse($("stub-design").getAttribute("data-pick")!)).toEqual({ format: "A5_LANDSCAPE", designStyle: null });
    await click($("stub-recommend-portrait"));
    expect(previewAttr("data-format")).toBe("A5_LANDSCAPE");
    expect(previewAttr("data-style")).toBe("scrapbook"); // the style wasn't picked → follows the recommendation
  });

  it("a failed design save stays on step 5 with the error and asks for NO build; a retry goes on", async () => {
    mocks.updateBookSetupAction.mockResolvedValueOnce({ ok: false, error: "failed" });
    await mountDesign();
    await click($("stub-pick-landscape"));
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-design").getAttribute("data-error")).toContain("couldn't save"));
    expect(shownStep()).toBe("5");
    expect(buildPosts()).toEqual([]);
    expect($("stub-design").getAttribute("data-pending")).toBe("false");
    mocks.updateBookSetupAction.mockResolvedValueOnce({ ok: true, setup: {}, relaidOut: true });
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(buildPosts()).toHaveLength(1);
  });

  it("the setup locked meanwhile (a build started elsewhere) → the server gate picks the step; no build request", async () => {
    mocks.updateBookSetupAction.mockResolvedValue({ ok: false, error: "locked", reason: "ai_started" });
    await mountDesign();
    await click($("stub-pick-landscape"));
    await click($("stub-design-continue"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/books/new?book=${BOOK}&step=5`));
    expect(buildPosts()).toEqual([]);
  });

  it("fewer photos than the automatic build wants → step 6 starts the build the plain way (no auto request, no hand-over)", async () => {
    await mount(`/books/new?book=${BOOK}&step=3`, { initialStep: 3, mode: edit(), initialData: withPhotos({ readyCount: 3 }) as never });
    await click($("stub-continue-few"));
    await waitFor(() => expect($("stub-story")).toBeTruthy());
    await click($("stub-story-continue"));
    await waitFor(() => expect($("stub-design")).toBeTruthy());
    served["6"] = step6({ activeRunId: null });
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(buildPosts()).toEqual([]);
    expect(wizardFetches().at(-1)).toBe(`/api/books/${BOOK}/wizard?step=6`);
    expect($("stub-sorting").getAttribute("data-run")).toBe("");
    expect($("stub-sorting").getAttribute("data-handover")).toBe("no");
    // Back / browser Back can't reopen the Design step while the run starts.
    await historyBack();
    expect(shownStep()).toBe("6");
    expect($("stub-design")).toBeNull();
  });

  it("limit → stays on Design with the reason (nothing locked); Back still works", async () => {
    fetchMock.mockImplementation(async (u: string) =>
      u === "/api/ai/runs"
        ? new Response(JSON.stringify({ error: "limit", limit: "daily_builds" }), { status: 429 })
        : new Response(JSON.stringify(served[new URL(u, "http://x").searchParams.get("step") ?? ""]), { status: 200 }),
    );
    await mountDesign();
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-design").getAttribute("data-build-error")).toContain("3 free AI builds"));
    expect(shownStep()).toBe("5");
    expect($("stub-design").getAttribute("data-pending")).toBe("false");
    await click($("stub-design-back"));
    await waitFor(() => expect($("stub-story")).toBeTruthy());
  });

  it("a network error on the build request → the plain message on Design; Continue asks again", async () => {
    let fail = true;
    fetchMock.mockImplementation(async (u: string) => {
      if (u === "/api/ai/runs") {
        if (fail) throw new Error("offline");
        return new Response(JSON.stringify({ runId: RUN, mode: "live", state: "queued" }), { status: 201 });
      }
      return new Response(JSON.stringify(served[new URL(u, "http://x").searchParams.get("step") ?? ""]), { status: 200 });
    });
    await mountDesign();
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-design").getAttribute("data-build-error")).toBe(BUILD_START_FAILED));
    fail = false;
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(buildPosts()).toHaveLength(2);
  });

  it("not_first (the first run already finished elsewhere) → step 7 by replace; user_edited → the editor", async () => {
    fetchMock.mockImplementation(async (u: string) =>
      u === "/api/ai/runs"
        ? new Response(JSON.stringify({ error: "not_first" }), { status: 409 })
        : new Response(JSON.stringify(served[new URL(u, "http://x").searchParams.get("step") ?? ""]), { status: 200 }),
    );
    await mountDesign();
    const len = window.history.length;
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-review")).toBeTruthy());
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
    expect(window.history.length).toBe(len);

    act(() => root.unmount());
    root = createRoot(container);
    fetchMock.mockImplementation(async (u: string) =>
      u === "/api/ai/runs" ? new Response(JSON.stringify({ error: "user_edited" }), { status: 409 }) : new Response("{}", { status: 404 }),
    );
    await mountDesign();
    await click($("stub-design-continue"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/books/${BOOK}/edit`));
  });
});

describe("M20b: every first build goes through step 6 (AI off / rule runs included)", () => {
  it("a rule run done inside the POST → step 6 with the hand-over (never the editor), then 7", async () => {
    // The gate already says 7 (the run finished) — step 6 must still play it through.
    served["6"] = step6({ activeRunId: null, resolved: 7, aiOn: false });
    fetchMock.mockImplementation(async (u: string) =>
      u === "/api/ai/runs"
        ? new Response(JSON.stringify({ runId: RUN, mode: "rule", state: "done" }), { status: 201 })
        : new Response(JSON.stringify(served[new URL(u, "http://x").searchParams.get("step") ?? ""]), { status: 200 }),
    );
    await mountDesign(withPhotos({ aiOn: false }));
    await click($("stub-design-continue"));
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

  it("answer still pending after the grace moment → step 6 at once with the pending answer, steps ≤ 5 locked", async () => {
    fetchMock.mockImplementation(async (u: string) =>
      u === "/api/ai/runs"
        ? new Promise<Response>(() => {})
        : new Response(JSON.stringify(served[new URL(u, "http://x").searchParams.get("step") ?? ""]), { status: 200 }),
    );
    await mountDesign();
    await click($("stub-design-continue"));
    expect(shownStep()).toBe("5"); // a quick answer gets a moment to arrive first
    expect($("stub-design").getAttribute("data-pending")).toBe("true");
    await settle(DESIGN_HANDOVER_GRACE_MS + 60);
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(url()).toBe(`/books/new?book=${BOOK}&step=6`);
    expect($("stub-sorting").getAttribute("data-handover")).toBe("yes");
    expect(wizardFetches().some((u) => u.includes("step=6") && u.includes("auto=1"))).toBe(true);
    await historyBack();
    expect(shownStep()).toBe("6"); // the Design step can't come back while the run starts
    expect(assign).not.toHaveBeenCalled();
    expect(buildPosts()).toHaveLength(1);
  });

  it("without a hand-over, step 6 data the gate moved on (finished run) still follows the gate → 7", async () => {
    served["6"] = step6({ activeRunId: null, resolved: 7 });
    await mount(`/books/new?book=${BOOK}&step=3`, { initialStep: 3, mode: edit(), initialData: withPhotos({ readyCount: 3 }) as never });
    await click($("stub-continue-few"));
    await waitFor(() => expect($("stub-story")).toBeTruthy());
    await click($("stub-story-continue"));
    await waitFor(() => expect($("stub-design")).toBeTruthy());
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-review")).toBeTruthy());
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
  });
});

describe("popstate guards via the flow", () => {
  it("step 3 before picking: browser Back → step 2 (edit); after picking: Back stays on 3 and steps 1–2 lock", async () => {
    window.history.replaceState(null, "", `/books/new?book=${BOOK}&step=2`);
    window.history.pushState({ wizardStep: 3, wizardPrev: 2 }, "", `/books/new?book=${BOOK}&step=3`);
    await mount(`/books/new?book=${BOOK}&step=3`, { initialStep: 3, mode: edit(), initialData: step3() as never });
    expect(shownStep()).toBe("3");
    await historyBack();
    expect(shownStep()).toBe("2");
    // forward again (through Continue: edits are saved), pick photos, then Back is refused
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    await click($("wizard-save"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    expect(shownStep()).toBe("3");
    await click($("stub-pick"));
    await historyBack();
    expect(shownStep()).toBe("3");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=3`);
    // stepper: steps 1–2 locked now
    expect($("wizard-step-2").querySelector("button")).toBeNull();
    expect($("wizard-step-1").querySelector("button")).toBeNull();
  });

  it("a hard load with photos in the book locks steps 1–2 from the start (Back from Story → Photos, no further)", async () => {
    window.history.replaceState(null, "", `/books/new?book=${BOOK}&step=2`);
    window.history.pushState(null, "", `/books/new?book=${BOOK}&step=3`);
    window.history.pushState(null, "", `/books/new?book=${BOOK}&step=4`);
    await mount(`/books/new?book=${BOOK}&step=4`, { initialStep: 4, mode: edit(), initialData: withPhotos() as never });
    expect(shownStep()).toBe("4");
    expect($("stub-story")).toBeTruthy();
    expect(wizardFetches()).toEqual([]); // the Story step needs no wizard data
    await historyBack();
    expect(shownStep()).toBe("3");
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    await historyBack();
    expect(shownStep()).toBe("3");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=3`);
  });

  it("while photos upload the wizard stays on step 3; once settled Forward works again", async () => {
    await mount(`/books/new?book=${BOOK}&step=3`, { initialStep: 3, mode: edit(), initialData: withPhotos() as never });
    await click($("stub-continue"));
    await waitFor(() => expect($("stub-story")).toBeTruthy());
    await historyBack();
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    await click($("stub-busy"));
    await act(async () => {
      window.history.forward();
      await tick(30);
    });
    await settle();
    expect(shownStep()).toBe("3");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=3`);
    await click($("stub-idle"));
    await click($("stub-continue"));
    await waitFor(() => expect($("stub-story")).toBeTruthy());
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
    window.history.replaceState(null, "", `/books/new?book=${OTHER}&step=2`);
    window.history.pushState(null, "", `/books/new?book=${BOOK}&step=3`);
    await mount(`/books/new?book=${BOOK}&step=3`, { initialStep: 3, mode: edit(), initialData: step3() as never });
    await historyBack();
    expect(reload).toHaveBeenCalled();
  });
});

describe("step data and the server", () => {
  it("step data the gate moved on (3 asked, run finished → 7) follows the gate", async () => {
    served["3"] = step3({ resolved: 7 });
    window.sessionStorage.clear();
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    await mount(`/books/new?book=${BOOK}&step=2`, { initialStep: 2, mode: edit() });
    await click($("wizard-save"));
    await waitFor(() => expect($("stub-review")).toBeTruthy());
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
  });

  it("step data the gate moved on (3 asked, a build is running → 6) follows the gate", async () => {
    served["3"] = step3({ resolved: 6, firstRun: "active" });
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    await mount(`/books/new?book=${BOOK}&step=2`, { initialStep: 2, mode: edit() });
    await click($("wizard-save"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(url()).toBe(`/books/new?book=${BOOK}&step=6`);
    expect(buildPosts()).toEqual([]); // resumed, never a second run
  });

  it("a load error offers Try again", async () => {
    await mount(`/books/new?book=${BOOK}&step=2`, { initialStep: 2, mode: edit() });
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 503 }));
    await click($("wizard-save"));
    await waitFor(() => expect($("wizard-step-error")).toBeTruthy());
    await click($("wizard-step-retry"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
  });

  it("hard load: the URL is made to match the step the server resolved (an old ?step=5 bookmark → 7 / 3)", async () => {
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 7, mode: edit(), initialData: step7() as never });
    expect(shownStep()).toBe("7");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=7`);
    act(() => root.unmount());
    root = createRoot(container);
    // Old numbering: 5 was "photos". A book without photos lands on the new Photos step.
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 3, mode: edit(), initialData: step3() as never });
    expect(shownStep()).toBe("3");
    expect(url()).toBe(`/books/new?book=${BOOK}&step=3`);
    expect($("stub-photos")).toBeTruthy();
  });

  it("hard load of Story / Design: rendered straight away from the server's props, no wizard fetch, no build", async () => {
    await mount(`/books/new?book=${BOOK}&step=4`, { initialStep: 4, mode: edit(), initialData: withPhotos() as never });
    expect($("stub-story")).toBeTruthy();
    expect($("stub-story").getAttribute("data-occasion")).toBe("travel");
    act(() => root.unmount());
    root = createRoot(container);
    await mountDesign();
    expect($("stub-design")).toBeTruthy();
    expect(JSON.parse($("stub-design").getAttribute("data-stored")!)).toEqual({ format: "A5_PORTRAIT", designStyle: "magazine" });
    expect(wizardFetches()).toEqual([]);
    expect(buildPosts()).toEqual([]);
  });

  it("a stored design that isn't the provisional one any more counts as the user's choice after a reload", async () => {
    const mode = { kind: "edit" as const, bookId: BOOK, draft: { ...DRAFT, format: "A5_LANDSCAPE" as const, designStyle: "classic" as const }, designLock: null };
    await mount(`/books/new?book=${BOOK}&step=5`, { initialStep: 5, mode, initialData: withPhotos() as never });
    expect(JSON.parse($("stub-design").getAttribute("data-pick")!)).toEqual({ format: "A5_LANDSCAPE", designStyle: "classic" });
    await click($("stub-recommend-portrait"));
    expect(previewAttr("data-format")).toBe("A5_LANDSCAPE");
    expect(previewAttr("data-style")).toBe("classic");
    // Nothing differs from the stored book → no save on Continue.
    await click($("stub-design-continue"));
    await waitFor(() => expect($("stub-sorting")).toBeTruthy());
    expect(mocks.updateBookSetupAction).not.toHaveBeenCalled();
  });

  it("mode guard: the server sends another book → reload; the same book → no reload", async () => {
    await mount(`/books/new?book=${BOOK}&step=3`, { initialStep: 3, mode: edit(), initialData: step3() as never });
    const dashboardBack = <a href="/dashboard">Back</a>;
    await render({ initialStep: 3, mode: edit(), initialData: step3() as never, dashboardBack });
    expect(reload).not.toHaveBeenCalled();
    await render({ initialStep: 2, mode: edit(OTHER), dashboardBack });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("mode guard: a create-mode server render after the in-place create, at an edit URL (revalidation) → kept", async () => {
    mocks.createBookAction.mockResolvedValue(created());
    storeFormDraft();
    await mount("/books/new?step=2", { initialStep: 2, mode: { kind: "create" } });
    await click($("create-book"));
    await waitFor(() => expect($("stub-photos")).toBeTruthy());
    // revalidatePath in a later server action re-renders the page at the current (edit) URL
    await render({ initialStep: 3, mode: edit(), initialData: step3() as never, dashboardBack: <a href="/dashboard">Back</a> });
    expect(reload).not.toHaveBeenCalled();
    expect($("stub-photos")).toBeTruthy();
  });
});

// --- Uploader (wizard): uploads only ----------------------------------------------------------------

describe("Uploader wizard (Task 5): never starts a build — Continue after the upload", () => {
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

  it("5+ photos uploaded and finalized: NO /api/ai/runs request, no 'starting your book'; Continue hands the ready count to the wizard", async () => {
    const onContinue = vi.fn();
    const onPhotosPicked = vi.fn();
    const onBack = vi.fn();
    const onBusyChange = vi.fn();
    await act(async () => {
      root.render(
        <Uploader {...uploaderProps} variant="wizard" onContinue={onContinue} onPhotosPicked={onPhotosPicked} onBack={onBack} onBusyChange={onBusyChange} />,
      );
    });
    // Back is a button (no server link), shown before picking; the pick area wears the T5 art.
    expect($("wizard-back").tagName).toBe("BUTTON");
    expect($("upload-pick").querySelector('[data-testid="upload-pick-art"]')).toBeTruthy();
    expect($("upload-wizard-continue")).toBeNull(); // nothing to continue with yet
    await pick(6);
    expect(onPhotosPicked).toHaveBeenCalledTimes(1);
    await waitFor(() => expect($("upload-summary")).toBeTruthy());
    await settle(80);
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/ai/runs")).toBe(false);
    expect($("upload-auto-starting")).toBeNull();
    expect($("build-album")).toBeNull();
    expect(container.textContent ?? "").not.toMatch(/sort|starting your book|make my book/i);
    expect($("wizard-back")).toBeNull();
    // busy while uploading / finalizing, then settled
    expect(onBusyChange.mock.calls.map((c) => c[0])).toContain(true);
    expect(onBusyChange.mock.calls.at(-1)?.[0]).toBe(false);
    expect(onContinue).not.toHaveBeenCalled(); // never by itself
    const next = $<HTMLButtonElement>("upload-wizard-continue");
    expect(next.tagName).toBe("BUTTON");
    expect(next.textContent).toBe("Continue");
    await click(next);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledWith(6);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalledWith("ai_build_done", expect.anything());
    expect($("upload-add-more")).toBeTruthy(); // more photos can still be added
  });

  it("fewer than 5 photos: still no build request and no 'start it now' — just Continue", async () => {
    const onContinue = vi.fn();
    await act(async () => {
      root.render(<Uploader {...uploaderProps} variant="wizard" onContinue={onContinue} />);
    });
    await pick(2);
    await waitFor(() => expect($("upload-summary")).toBeTruthy());
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/ai/runs")).toBe(false);
    expect($("upload-auto-fallback")).toBeNull();
    await click($("upload-wizard-continue"));
    expect(onContinue).toHaveBeenCalledWith(2);
  });

  it("a return visit with photos already in the book offers Continue at once; an empty book doesn't", async () => {
    const onContinue = vi.fn();
    await act(async () => {
      root.render(<Uploader {...uploaderProps} readyCount={4} variant="wizard" onContinue={onContinue} />);
    });
    expect($("build-album")).toBeNull();
    await click($("upload-wizard-continue"));
    expect(onContinue).toHaveBeenCalledWith(4);
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<Uploader {...uploaderProps} variant="wizard" onContinue={onContinue} />);
    });
    expect($("upload-wizard-continue")).toBeNull();
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

// --- M20c: a confirmed (generated) book never shows the wizard ------------------------------------------

describe("M20c: confirmed book → leave for the editor with replace", () => {
  let replace: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    replace = vi.spyOn(wizardWindow, "replace").mockImplementation(() => {});
  });
  afterEach(() => replace.mockRestore());

  it("Back from the editor restores the cached Review tree → replace to the editor, nothing rendered or fetched", async () => {
    rememberAlbumConfirmed(BOOK);
    await mount(`/books/new?book=${BOOK}&step=7`, { initialStep: 7, mode: edit(), initialData: step7() as never });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`/books/${BOOK}/edit`);
    expect(assign).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(wizardFetches()).toEqual([]);
  });

  it("an older wizard entry of the same book (step 3 / 2) leaves too; another book's marker doesn't", async () => {
    rememberAlbumConfirmed(BOOK);
    await mount(`/books/new?book=${BOOK}&step=3`, { initialStep: 3, mode: edit(), initialData: step3() as never });
    expect(replace).toHaveBeenCalledWith(`/books/${BOOK}/edit`);
    act(() => root.unmount());
    root = createRoot(container);
    replace.mockClear();
    await mount(`/books/new?book=${BOOK}&step=2`, { initialStep: 2, mode: edit() });
    expect(replace).toHaveBeenCalledWith(`/books/${BOOK}/edit`);

    act(() => root.unmount());
    root = createRoot(container);
    replace.mockClear();
    await mount(`/books/new?book=${OTHER}&step=7`, { initialStep: 7, mode: edit(OTHER), initialData: step7({ bookId: OTHER }) as never });
    expect(replace).not.toHaveBeenCalled();
    expect($("stub-review")).toBeTruthy();
  });

  it("server props answering 'editor' → replace (not assign)", async () => {
    await mount(`/books/new?book=${BOOK}&step=7`, {
      initialStep: 7,
      mode: edit(),
      initialData: step7({ resolved: "editor" }) as never,
    });
    expect(replace).toHaveBeenCalledWith(`/books/${BOOK}/edit`);
    expect(assign).not.toHaveBeenCalled();
  });

  it("a fetched step whose gate answers 'editor' → replace (no history loop)", async () => {
    served["3"] = step3({ resolved: "editor" });
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    await mount(`/books/new?book=${BOOK}&step=2`, { initialStep: 2, mode: edit() });
    await click($("wizard-save"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/books/${BOOK}/edit`));
    expect(assign).not.toHaveBeenCalledWith(`/books/${BOOK}/edit`);
  });

  it("unconfirmed book: Review renders as before", async () => {
    await mount(`/books/new?book=${BOOK}&step=7`, { initialStep: 7, mode: edit(), initialData: step7() as never });
    expect(replace).not.toHaveBeenCalled();
    expect($("stub-review")).toBeTruthy();
  });

  it("the marker helpers: ids only, forget removes, junk storage is ignored", () => {
    rememberAlbumConfirmed(BOOK);
    rememberAlbumConfirmed(BOOK);
    expect(JSON.parse(window.sessionStorage.getItem(WIZARD_CONFIRMED_STORAGE_KEY)!)).toEqual([BOOK]);
    expect(wasAlbumConfirmedHere(BOOK)).toBe(true);
    expect(wasAlbumConfirmedHere(OTHER)).toBe(false);
    forgetAlbumConfirmed(BOOK);
    expect(wasAlbumConfirmedHere(BOOK)).toBe(false);
    expect(window.sessionStorage.getItem(WIZARD_CONFIRMED_STORAGE_KEY)).toBeNull();
    window.sessionStorage.setItem(WIZARD_CONFIRMED_STORAGE_KEY, "{not json");
    expect(wasAlbumConfirmedHere(BOOK)).toBe(false);
    window.sessionStorage.setItem(WIZARD_CONFIRMED_STORAGE_KEY, JSON.stringify({ a: 1 }));
    expect(wasAlbumConfirmedHere(BOOK)).toBe(false);
  });
});
