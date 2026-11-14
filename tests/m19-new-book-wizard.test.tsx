// @vitest-environment jsdom
// M19 T3/T4/T8 (D-071): the /books/new creation wizard, steps 1–4, in a DOM: URL step changes with
// pushState, browser back via popstate, sessionStorage restore, missing-step redirects, style that
// follows the occasion until picked, the create form's hidden fields, server errors jumping to their
// step, and edit mode (prefill + save, and the server page's locked redirect).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createBookAction: vi.fn(),
  updateBookSetupAction: vi.fn(),
  push: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  user: { id: "u1", email: "sara@example.com" } as { id: string; email: string } | null,
  book: null as Record<string, unknown> | null,
  hasRun: false,
  memory: null as { language?: string; tone?: string } | null,
  acceptLanguage: "",
}));

vi.mock("@/app/books/actions", () => ({
  createBookAction: mocks.createBookAction,
  updateBookSetupAction: mocks.updateBookSetupAction,
}));
vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/books/new",
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "accept-language": mocks.acceptLanguage }),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({ getMyBook: async () => mocks.book }));
vi.mock("@/lib/db/agent-runs", () => ({ hasAnyRunForBook: async () => mocks.hasRun }));
vi.mock("@/lib/db/memory", () => ({ getOwnMemoryView: async () => mocks.memory }));
vi.mock("@/lib/db/profiles", () => ({ getMyProfile: async () => null }));

const { NewBookWizard, wizardWindow } = await import("@/components/books/NewBookWizard");
const { default: NewBookPage } = await import("@/app/books/new/page");
type Mode = import("@/components/books/NewBookWizard").NewBookWizardMode;
const { WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft, EMPTY_WIZARD_DRAFT } = await import("@/lib/books/wizard-steps");
type WizardDraft = import("@/lib/books/wizard-steps").WizardDraft;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK = "22222222-2222-4222-8222-222222222222";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.createBookAction.mockReset();
  mocks.updateBookSetupAction.mockReset();
  mocks.push.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function mount(url: string, mode: Mode = { kind: "create", initialLang: "en" }) {
  window.history.replaceState(null, "", url);
  const step = Number(new URL(window.location.href).searchParams.get("step") ?? "1");
  const initialStep = (step >= 1 && step <= 4 ? step : 1) as 1 | 2 | 3 | 4;
  await act(async () => {
    root.render(
      <NewBookWizard
        initialStep={initialStep}
        mode={mode}
        dashboardBack={
          <a href="/dashboard" data-testid="wizard-back">
            Back
          </a>
        }
      />,
    );
  });
}

const $ = <T extends Element = HTMLElement>(testId: string) =>
  container.querySelector<T & Element>(`[data-testid="${testId}"]`) as unknown as T;
const urlStep = () => new URL(window.location.href).searchParams.get("step");
const shownStep = () => $("new-book-wizard").getAttribute("data-step");
const label = () => $("wizard-step-label").textContent;
const radio = (testId: string) => $(testId).querySelector("input") as HTMLInputElement;

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function typeInto(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Polls until `check` passes (React flushes action results on its own schedule). */
async function waitFor(check: () => void, timeout = 1000) {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
    }
    await act(async () => {
      await tick(10);
    });
  }
}

/** The in-page Back: a history.back() when the previous step pushed this one (async popstate). */
async function back() {
  await act(async () => {
    $("wizard-back").click();
    await tick(30);
  });
}

async function historyBack() {
  await act(async () => {
    window.history.back();
    await tick(30);
  });
}

function store(draft: Partial<WizardDraft>) {
  window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft({ ...EMPTY_WIZARD_DRAFT, ...draft }));
}

function stored(): WizardDraft | null {
  const raw = window.sessionStorage.getItem(WIZARD_DRAFT_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as WizardDraft) : null;
}

describe("new book wizard — steps and URL", () => {
  it("step 1: title (dir=auto) with the server Back link; Continue pushes ?step=2 and updates the label", async () => {
    await mount("/books/new");
    expect(shownStep()).toBe("1");
    expect(label()).toBe("Step 1 of 6");
    expect($("wizard-headline").textContent).toBe("Give your book a title");
    const input = $<HTMLInputElement>("book-title");
    expect(input.getAttribute("dir")).toBe("auto");
    expect(container.textContent).toContain("You can change it later.");
    expect($("wizard-back").getAttribute("href")).toBe("/dashboard");

    await typeInto(input, "Days by the Sea");
    expect($("wizard-cover-title").textContent).toBe("Days by the Sea");
    const lengthBefore = window.history.length;
    await click($("wizard-continue"));
    expect(urlStep()).toBe("2");
    expect(window.history.length).toBe(lengthBefore + 1);
    expect(shownStep()).toBe("2");
    expect(label()).toBe("Step 2 of 6");
    expect($("wizard-progress").getAttribute("aria-valuenow")).toBe("2");
    expect(stored()?.title).toBe("Days by the Sea");
    // focus moves to the new headline
    expect(document.activeElement).toBe($("wizard-headline"));
  });

  it("empty title is allowed; Enter in the field continues", async () => {
    await mount("/books/new?step=1");
    expect($<HTMLButtonElement>("wizard-continue").disabled).toBe(false);
    const form = $<HTMLFormElement>("new-book-form");
    await act(async () => {
      form.requestSubmit();
    });
    expect(urlStep()).toBe("2");
  });

  it("an over-long title blocks Continue and shows the counter + message", async () => {
    await mount("/books/new");
    await typeInto($<HTMLInputElement>("book-title"), "x".repeat(121));
    expect($("book-title-count").textContent).toBe("121/120");
    expect($("book-title-error").textContent).toContain("120 characters or fewer");
    expect($<HTMLButtonElement>("wizard-continue").disabled).toBe(true);
  });

  it("step 2: six occasion cards (2 cols, 3 from sm), Continue disabled until one is picked, language switch", async () => {
    await mount("/books/new");
    await click($("wizard-continue"));
    for (const id of ["wedding", "travel", "baby", "graduation", "family", "other"]) {
      expect($(`occasion-${id}`)).toBeTruthy();
    }
    expect($("occasion-grid").className).toContain("grid-cols-2 gap-3 sm:grid-cols-3");
    expect($<HTMLButtonElement>("wizard-continue").disabled).toBe(true);
    expect($<HTMLInputElement>("lang-en").checked).toBe(true);
    const ar = $("lang-ar").parentElement!.querySelector("span[lang]")!;
    expect(ar.getAttribute("lang")).toBe("ar");
    expect(ar.className).toContain("font-arabic");
    await click($("lang-ar"));
    expect(stored()?.captionLang).toBe("ar");
    await click(radio("occasion-travel"));
    expect($<HTMLButtonElement>("wizard-continue").disabled).toBe(false);
    await click($("wizard-continue"));
    expect(urlStep()).toBe("3");
    expect(label()).toBe("Step 3 of 6");
  });

  it("caption language defaults to the server's suggestion (memory / browser)", async () => {
    store({ title: "", occasion: null });
    await mount("/books/new?step=2", { kind: "create", initialLang: "ar" });
    expect($<HTMLInputElement>("lang-ar").checked).toBe(true);
  });

  it("browser back (popstate) returns to the previous step; Back button uses history when it can", async () => {
    await mount("/books/new");
    await click($("wizard-continue"));
    await click(radio("occasion-wedding"));
    await click($("wizard-continue"));
    expect(shownStep()).toBe("3");
    await historyBack();
    expect(shownStep()).toBe("2");
    expect(urlStep()).toBe("2");
    expect(label()).toBe("Step 2 of 6");
    // forward again
    await act(async () => {
      window.history.forward();
      await tick(30);
    });
    expect(shownStep()).toBe("3");
    // in-page Back
    await back();
    expect(shownStep()).toBe("2");
    expect(urlStep()).toBe("2");
  });

  it("Back on a deep-linked step goes to the previous step (replace)", async () => {
    store({ title: "T", occasion: "family", format: "A5_PORTRAIT" });
    await mount("/books/new?step=3");
    expect(shownStep()).toBe("3");
    await back();
    expect(shownStep()).toBe("2");
    expect(urlStep()).toBe("2");
  });
});

describe("new book wizard — draft restore and missing steps", () => {
  it("restores choices from sessionStorage after a refresh", async () => {
    store({ title: "أيام البحر", occasion: "wedding", captionLang: "ar", format: "A5_LANDSCAPE" });
    await mount("/books/new?step=3");
    expect(shownStep()).toBe("3");
    expect(radio("format-A5_LANDSCAPE").checked).toBe(true);
    await back();
    expect(radio("occasion-wedding").checked).toBe(true);
    expect($<HTMLInputElement>("lang-ar").checked).toBe(true);
    await back();
    expect($<HTMLInputElement>("book-title").value).toBe("أيام البحر");
  });

  it("a step whose earlier answers are missing redirects to the first missing step", async () => {
    store({ title: "Only a title" });
    await mount("/books/new?step=4");
    expect(shownStep()).toBe("2");
    expect(urlStep()).toBe("2");
    expect(label()).toBe("Step 2 of 6");
  });

  it("a visit with nothing stored starts at step 1", async () => {
    await mount("/books/new?step=3");
    expect(shownStep()).toBe("1");
    expect(urlStep()).toBe("1");
  });

  it("a corrupt stored draft is ignored", async () => {
    window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, "{not json");
    await mount("/books/new?step=2");
    expect(shownStep()).toBe("1");
  });
});

describe("new book wizard — shape, style and submit", () => {
  it("shape: no default; Continue disabled until a shape is picked", async () => {
    store({ title: "", occasion: "travel" });
    await mount("/books/new?step=3");
    expect(radio("format-A5_PORTRAIT").checked).toBe(false);
    expect($<HTMLButtonElement>("wizard-continue").disabled).toBe(true);
    await click(radio("format-A5_PORTRAIT"));
    await click($("wizard-continue"));
    expect(shownStep()).toBe("4");
  });

  it("style follows the occasion's default until the user picks one (D-068)", async () => {
    store({ title: "", occasion: "travel", format: "A5_LANDSCAPE" });
    await mount("/books/new?step=4");
    expect(radio("style-geometric").checked).toBe(true);
    // previews drawn in the chosen shape
    expect($("style-modern").innerHTML).toContain('width="45" height="31"');
    await back();
    await back();
    await click(radio("occasion-baby"));
    await click($("wizard-continue"));
    await click($("wizard-continue"));
    expect(radio("style-scrapbook").checked).toBe(true);
    await click(radio("style-classic"));
    await back();
    await back();
    await click(radio("occasion-wedding"));
    await click($("wizard-continue"));
    await click($("wizard-continue"));
    expect(radio("style-classic").checked).toBe(true);
  });

  it("Continue on step 4 submits the hidden fields to createBookAction (no tone) and clears the draft", async () => {
    let sent: FormData | null = null;
    let storedDuringSubmit: string | null = "unset";
    let release = () => {};
    mocks.createBookAction.mockImplementation(async (_prev: unknown, fd: FormData) => {
      sent = fd;
      storedDuringSubmit = window.sessionStorage.getItem(WIZARD_DRAFT_STORAGE_KEY);
      // The real action redirects (never resolves). Resolve at the end instead: React entangles every
      // later transition with a pending async action, so a forever-pending one would stall other tests.
      return new Promise((resolve) => {
        release = () => resolve({ ok: false });
      });
    });
    store({ title: "Days by the Sea", occasion: "travel", captionLang: "ar", format: "A5_LANDSCAPE" });
    await mount("/books/new?step=4");
    const submit = $<HTMLButtonElement>("create-book");
    expect(submit.textContent).toBe("Continue");
    await click(submit);
    expect(mocks.createBookAction).toHaveBeenCalledTimes(1);
    const fd = sent as unknown as FormData;
    expect(fd.get("title")).toBe("Days by the Sea");
    expect(fd.get("occasion")).toBe("travel");
    expect(fd.get("captionLang")).toBe("ar");
    expect(fd.get("format")).toBe("A5_LANDSCAPE");
    expect(fd.get("designStyle")).toBe("geometric");
    expect(fd.has("tone")).toBe(false);
    expect(fd.getAll("designStyle")).toHaveLength(1);
    expect(storedDuringSubmit).toBeNull();
    expect($("create-book").textContent).toContain("Creating your book…");
    expect($<HTMLButtonElement>("create-book").disabled).toBe(true);
    await act(async () => {
      release();
      await tick(10);
    });
  });

  it("a server field error shows a Notice and jumps to the step that owns the field; the draft is kept", async () => {
    mocks.createBookAction.mockResolvedValue({
      ok: false,
      error: "Please check the highlighted fields.",
      fieldErrors: { format: "Please choose a shape.", designStyle: "Please choose a style." },
    });
    store({ title: "T", occasion: "family", format: "A5_PORTRAIT" });
    await mount("/books/new?step=4");
    await click($("create-book"));
    await waitFor(() => expect(shownStep()).toBe("3"));
    expect(urlStep()).toBe("3");
    expect($("new-book-error-message").textContent).toBe("Please choose a shape.");
    expect($("new-book-error").getAttribute("role")).toBe("alert");
    expect(stored()?.occasion).toBe("family");
  });

  it("success: the history entry becomes the book's edit URL, then step 5 is pushed (M19 BUG-2)", async () => {
    mocks.createBookAction.mockResolvedValue({
      ok: true,
      bookId: BOOK,
      next: `/books/${BOOK}/upload?_ev=book_created`,
    });
    store({ title: "T", occasion: "family", format: "A5_PORTRAIT" });
    await mount("/books/new?step=4");
    const before = window.history.length;
    await click($("create-book"));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
    expect(mocks.push).toHaveBeenCalledWith(`/books/${BOOK}/upload?_ev=book_created`);
    // Replaced, not pushed: browser Back from step 5 lands on /books/new?book=<id>&step=4.
    expect(window.location.pathname + window.location.search).toBe(`/books/new?book=${BOOK}&step=4`);
    expect(window.history.length).toBe(before);
    expect(stored()).toBeNull();
    expect($<HTMLButtonElement>("create-book").disabled).toBe(true);
    expect($("create-book").textContent).toContain("Creating your book…");
  });

  it("create mode remounted on a created book's entry (browser Back) reloads it — never an empty wizard", async () => {
    const reload = vi.spyOn(wizardWindow, "reload").mockImplementation(() => {});
    try {
      await mount(`/books/new?book=${BOOK}&step=4`);
      expect(reload).toHaveBeenCalledWith(`${window.location.origin}/books/new?book=${BOOK}&step=4`);
      expect($("new-book-wizard").getAttribute("data-reopening")).toBe("true");
      expect($("wizard-step-label")).toBeNull();
      expect($("create-book")).toBeNull();
      // The URL is left alone (no bounce to ?step=1).
      expect(window.location.search).toBe(`?book=${BOOK}&step=4`);
    } finally {
      reload.mockRestore();
    }
  });

  it("a non-field error stays on step 4", async () => {
    mocks.createBookAction.mockResolvedValue({ ok: false, error: "We couldn't create your book. Please try again." });
    store({ title: "", occasion: "other", format: "A5_PORTRAIT" });
    await mount("/books/new?step=4");
    await click($("create-book"));
    await waitFor(() => expect($("new-book-error")).toBeTruthy());
    expect(shownStep()).toBe("4");
    expect($("new-book-error-message").textContent).toContain("couldn't create");
  });
});

describe("new book wizard — edit mode (T8)", () => {
  const editDraft: WizardDraft = {
    title: "",
    occasion: "graduation",
    captionLang: "en",
    format: "A5_PORTRAIT",
    designStyle: "classic",
  };

  it("prefills from the book and ignores sessionStorage; Continue saves and goes to the upload step", async () => {
    store({ title: "Other draft", occasion: "baby", format: "A5_LANDSCAPE", designStyle: "scrapbook" });
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    await mount(`/books/new?book=${BOOK}&step=4`, { kind: "edit", bookId: BOOK, draft: editDraft, designLock: null });
    expect(shownStep()).toBe("4");
    expect(radio("style-classic").checked).toBe(true);
    await back();
    expect(radio("format-A5_PORTRAIT").checked).toBe(true);
    expect(new URL(window.location.href).searchParams.get("book")).toBe(BOOK);
    await click(radio("format-A5_LANDSCAPE"));
    await click($("wizard-continue"));
    await click($("wizard-save"));
    expect(mocks.updateBookSetupAction).toHaveBeenCalledWith(BOOK, {
      title: null,
      occasion: "graduation",
      captionLang: "en",
      format: "A5_LANDSCAPE",
      designStyle: "classic",
    });
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/books/${BOOK}/upload`));
    // edit mode never writes the new-book draft
    expect(stored()?.title).toBe("Other draft");
  });

  it("design locked: shape / style read-only with a note, and not sent", async () => {
    mocks.updateBookSetupAction.mockResolvedValue({ ok: true, setup: {}, relaidOut: false });
    await mount(`/books/new?book=${BOOK}&step=3`, {
      kind: "edit",
      bookId: BOOK,
      draft: { ...editDraft, title: "Grad 2026" },
      designLock: "user_edited",
    });
    expect($("wizard-design-locked")).toBeTruthy();
    expect($("format-A5_LANDSCAPE")).toBeNull();
    expect(radio("format-A5_PORTRAIT").checked).toBe(true);
    await click($("wizard-continue"));
    expect($("style-modern")).toBeNull();
    await click($("wizard-save"));
    expect(mocks.updateBookSetupAction).toHaveBeenCalledWith(BOOK, {
      title: "Grad 2026",
      occasion: "graduation",
      captionLang: "en",
    });
  });

  it("a save field error jumps to its step", async () => {
    mocks.updateBookSetupAction.mockResolvedValue({
      ok: false,
      error: "invalid",
      fieldErrors: { title: "Title must be 120 characters or fewer." },
    });
    await mount(`/books/new?book=${BOOK}&step=4`, { kind: "edit", bookId: BOOK, draft: editDraft, designLock: null });
    await click($("wizard-save"));
    await waitFor(() => expect(shownStep()).toBe("1"));
    expect($("new-book-error-message").textContent).toContain("120 characters");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("/books/new server page", () => {
  type Element = { props: Record<string, unknown> };
  const wizardProps = (el: unknown) => ((el as Element).props.children as Element).props as {
    initialStep: number;
    mode: Mode;
  };
  const run = (params: Record<string, string>) => NewBookPage({ searchParams: Promise.resolve(params) });

  beforeEach(() => {
    mocks.user = { id: "u1", email: "sara@example.com" };
    mocks.book = null;
    mocks.hasRun = false;
    mocks.memory = null;
    mocks.acceptLanguage = "";
  });

  it("signed out → login with next=/books/new", async () => {
    mocks.user = null;
    await expect(run({ step: "3" })).rejects.toThrow("REDIRECT:/login?next=%2Fbooks%2Fnew");
  });

  it("create: step from ?step=, caption language from memory, else the browser", async () => {
    mocks.memory = { language: "ar" };
    let props = wizardProps(await run({ step: "3" }));
    expect(props.initialStep).toBe(3);
    expect(props.mode).toEqual({ kind: "create", initialLang: "ar" });
    mocks.memory = null;
    mocks.acceptLanguage = "ar-AE,ar;q=0.9";
    props = wizardProps(await run({ step: "9" }));
    expect(props.initialStep).toBe(1);
    expect(props.mode).toEqual({ kind: "create", initialLang: "ar" });
  });

  it("edit: missing / foreign book → 404", async () => {
    await expect(run({ book: BOOK, step: "4" })).rejects.toThrow("NOT_FOUND");
    await expect(run({ book: "not-a-uuid" })).rejects.toThrow("NOT_FOUND");
  });

  it("edit: prefills the draft from the book (null title → empty)", async () => {
    mocks.book = {
      id: BOOK,
      title: null,
      occasion: "wedding",
      tone: "romantic",
      caption_lang: "ar",
      doc: {},
      format: "A5_LANDSCAPE",
      design_style: "scrapbook",
    };
    const props = wizardProps(await run({ book: BOOK, step: "4" }));
    expect(props.mode).toEqual({
      kind: "edit",
      bookId: BOOK,
      draft: { title: "", occasion: "wedding", captionLang: "ar", format: "A5_LANDSCAPE", designStyle: "scrapbook" },
      designLock: null,
    });
  });

  it("edit: details locked (an AI run exists) → the editor", async () => {
    mocks.book = { id: BOOK, title: "T", occasion: "other", caption_lang: "en", doc: {}, format: "A5_PORTRAIT", design_style: "modern" };
    mocks.hasRun = true;
    await expect(run({ book: BOOK, step: "2" })).rejects.toThrow(`REDIRECT:/books/${BOOK}/edit`);
  });
});
