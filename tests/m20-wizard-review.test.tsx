// @vitest-environment jsdom
// M20 T8 (D-072): wizard step 7 "Review your book". In a DOM:
//   - hero: count "AI kept X of Y photos", cover, chapters with dates, 3 caption previews (dir="auto",
//     Arabic font), honest AI-off wording and banners; no Rebuild button
//   - a toggle persists via togglePhotoAction, the counter follows, Undo toggles back
//   - Generate: changed choices → updateAlbumAction then confirmAlbumAction; unchanged → confirm only;
//     user_edited / busy go on; failures show a calm error and retry (without repeating a done update)
//   - refresh override: a broken thumb re-fetches step 7 (fetchWizardStep), never router.refresh
//   - reduced motion: the counter shows its final value at once
//   - classic ReviewGrid unchanged without the new props (no undo toast, router refresh)
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  toggle: vi.fn(),
  update: vi.fn(),
  confirm: vi.fn(),
  fetchStep: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/app/books/[id]/review/actions", () => ({
  togglePhotoAction: mocks.toggle,
  updateAlbumAction: mocks.update,
  confirmAlbumAction: mocks.confirm,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: mocks.refresh }),
  unstable_rethrow: (e: unknown) => {
    const d = (e as { digest?: unknown } | null)?.digest;
    if (typeof d === "string" && d.startsWith("NEXT_REDIRECT")) throw e;
  },
}));
vi.mock("@/lib/books/wizard-client", () => ({ fetchWizardStep: mocks.fetchStep }));

import { StepReview } from "@/components/books/wizard/steps/StepReview";
import { needsAlbumUpdate, reviewCaptionPicks, reviewChapters, updateStepOutcome } from "@/components/books/wizard/steps/review-step-model";
import { ReviewGrid } from "@/components/review/ReviewGrid";
import type { WizardStep7Data } from "@/lib/books/wizard-client";
import type { ReviewTilePhoto } from "@/lib/review/ui";

const BOOK = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function photo(n: number, over: Partial<ReviewTilePhoto> = {}): ReviewTilePhoto {
  return { id: id(n), status: "kept", dropReason: null, userOverride: false, dupGroup: null, width: 400, height: 300, thumbUrl: `https://x.test/t${n}.jpg`, ...over };
}

function step7(over: Partial<WizardStep7Data> = {}): WizardStep7Data {
  const photos = [photo(1), photo(2), photo(3), photo(4, { status: "dropped", dropReason: "blurry" }), photo(5, { status: "dropped", dropReason: "screenshot" })];
  return {
    step: 7,
    bookId: BOOK,
    title: "Days by the Sea",
    rawTitle: "Days by the Sea",
    occasion: "travel",
    format: "A5_PORTRAIT",
    designStyle: "classic",
    captionLang: "en",
    isPaid: false,
    aiOn: true,
    resolved: 7,
    photos,
    albumPhotoIds: [id(1), id(2), id(3)],
    aiUsed: true,
    userEdited: false,
    building: false,
    rebuild: { variant: "rebuild", rebuildsLeft: 2 },
    captionsPreview: {
      chapters: [
        { title: "Arrival", dateLabel: "3 May 2026" },
        { title: "على الشاطئ", dateLabel: "4 May 2026" },
      ],
      pages: [
        { chapter: 0, caption: { text: "Salt air and the first sunset.", source: "ai" }, captionable: true },
        { chapter: 0, caption: { text: "Bags down, shoes off.", source: "ai" }, captionable: true },
        { chapter: 1, caption: { text: "يوم هادئ على الشاطئ", source: "ai" }, captionable: true },
        { chapter: 1, caption: { text: "A fourth caption", source: "user" }, captionable: true },
      ],
    },
    banner: null,
    captionsNote: null,
    coverPhotoId: id(2),
    counts: { kept: 3, total: 5 },
    ...over,
  } as WizardStep7Data;
}

let container: HTMLDivElement;
let root: Root;
const $ = (t: string) => container.querySelector<HTMLElement>(`[data-testid="${t}"]`);
const $$ = (t: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${t}"]`)];
const tile = (n: number) => container.querySelector<HTMLButtonElement>(`[data-testid="review-tile"][data-photo-id="${id(n)}"]`)!;
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};
const click = async (el: HTMLElement | null) => {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
};

function render(data: WizardStep7Data, onConfirm = vi.fn()) {
  act(() => root.render(<StepReview data={data} headlineId="wizard-headline" onConfirm={onConfirm} />));
  return onConfirm;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.toggle.mockReset().mockResolvedValue({ ok: true });
  mocks.update.mockReset().mockResolvedValue({ ok: true, changed: true, pages: 6 });
  mocks.confirm.mockReset().mockResolvedValue(undefined);
  mocks.fetchStep.mockReset().mockImplementation(async () => ({ ok: true, data: step7() }));
  mocks.refresh.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("step 7 review — summary", () => {
  it("shows the count, cover, chapters with dates and 3 caption previews; no Rebuild", () => {
    render(step7());
    expect($("wizard-headline")?.textContent).toBe("Review your book");
    expect($("review-kept")?.textContent).toBe("AI kept 3 of 5 photos");
    expect($("review-kept-visual")?.textContent).toBe("AI kept 3 of 5 photos"); // reduced motion in jsdom: final at once
    expect($("review-cover-img")?.getAttribute("src")).toBe("https://x.test/t2.jpg");
    const chapters = $$("review-chapter");
    expect(chapters).toHaveLength(2);
    expect(chapters[0].textContent).toContain("Arrival");
    expect(chapters[0].textContent).toContain("3 May 2026");
    expect(chapters[0].textContent).toContain("2 pages");
    const caps = $$("review-caption-text");
    expect(caps.map((c) => c.textContent)).toEqual(["Salt air and the first sunset.", "Bags down, shoes off.", "يوم هادئ على الشاطئ"]);
    for (const c of caps) expect(c.getAttribute("dir")).toBe("auto");
    expect(caps[2].getAttribute("lang")).toBe("ar");
    expect(caps[2].className).toContain("font-arabic");
    expect(caps[0].className).not.toContain("font-arabic");
    expect(container.innerHTML).not.toContain("rebuild");
    expect(container.textContent).not.toMatch(/Rebuild|Try AI again/i);
    // reasons as today
    expect($$("review-tab-dropped")).toHaveLength(1);
    expect($("wizard-generate")?.textContent).toContain("Generate album");
  });

  it("AI off: honest wording and the ai_off banner; Arabic book uses the Arabic font for chapters", () => {
    render(step7({ aiUsed: false, banner: "ai_off", captionLang: "ar" }));
    expect($("review-kept")?.textContent).toBe("3 of 5 photos in your book");
    expect($("review-subline")?.textContent).toContain("simple rules and laid them out by date");
    expect($("review-banner-ai_off")?.textContent).toContain("AI isn't switched on yet");
    expect($$("review-chapter")[0].querySelector("[dir=auto]")?.className).toContain("font-arabic");
    expect(container.textContent).not.toContain("AI kept");
  });

  it("building: Generate disabled, Check again re-fetches step 7", async () => {
    render(step7({ building: true, banner: "building" }));
    expect(($("wizard-generate") as HTMLButtonElement).disabled).toBe(true);
    await click($("review-check-again"));
    expect(mocks.fetchStep).toHaveBeenCalledWith(BOOK, 7);
    expect(($("wizard-generate") as HTMLButtonElement).disabled).toBe(false); // fresh data: not building
  });

  it("captions note under a banner; no cover → placeholder", () => {
    render(step7({ banner: "partial", captionsNote: "Some pages may not have captions yet.", coverPhotoId: null }));
    expect($("review-banner-captions-note")?.textContent).toBe("Some pages may not have captions yet.");
    expect($("review-cover-img")).toBeNull();
  });
});

describe("step 7 review — toggles", () => {
  it("a toggle persists via togglePhotoAction, the counter follows, Undo toggles back", async () => {
    render(step7());
    await click(tile(1));
    expect(mocks.toggle).toHaveBeenCalledWith(BOOK, id(1), false, { revalidate: false }); // no /books/new re-render per tap
    expect($("review-kept")?.textContent).toBe("AI kept 2 of 5 photos");
    expect($("review-count-dropped")?.textContent).toBe("(3)");
    expect($("review-undo-toast")?.textContent).toContain("Moved to Left out");
    await click($("review-undo"));
    expect(mocks.toggle).toHaveBeenLastCalledWith(BOOK, id(1), true, { revalidate: false });
    expect($("review-kept")?.textContent).toBe("AI kept 3 of 5 photos");
    expect($("review-undo-toast")).toBeNull();
  });

  it("a failed toggle reverts and shows the error toast", async () => {
    mocks.toggle.mockResolvedValueOnce({ ok: false, error: "We couldn't save that. Please try again." });
    render(step7());
    await click(tile(1));
    expect($("review-kept")?.textContent).toBe("AI kept 3 of 5 photos");
    expect($("review-toast")?.textContent).toContain("couldn't save");
  });

  it("refresh override: a broken thumb re-fetches step 7, never router.refresh", async () => {
    render(step7());
    const img = tile(1).querySelector("img")!;
    await act(async () => {
      img.dispatchEvent(new Event("error"));
    });
    await flush();
    expect(mocks.fetchStep).toHaveBeenCalledWith(BOOK, 7);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("step 7 review — Generate album", () => {
  it("with changed choices → updateAlbumAction, then confirmAlbumAction", async () => {
    const onConfirm = render(step7());
    await click($("review-tab-dropped"));
    await click(tile(4)); // keep a left-out photo the album doesn't use
    await click($("wizard-generate"));
    expect(mocks.update).toHaveBeenCalledWith(BOOK, { revalidate: false });
    expect(mocks.confirm).toHaveBeenCalledWith(BOOK);
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.confirm.mock.invocationCallOrder[0]);
    expect(onConfirm).toHaveBeenCalledTimes(1); // confirm returned without redirecting → wizard navigates
  });

  it("without changes → confirm only", async () => {
    render(step7());
    await click($("wizard-generate"));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalledWith(BOOK);
  });

  it.each(["user_edited", "busy"] as const)("update answers %s → continue to confirm", async (error) => {
    mocks.update.mockResolvedValueOnce({ ok: false, error });
    render(step7());
    await click(tile(1));
    await click($("wizard-generate"));
    expect(mocks.confirm).toHaveBeenCalledWith(BOOK);
    expect($("review-generate-error")).toBeNull();
  });

  it("update fails → calm error, retry repeats it; a done update isn't repeated after a confirm error", async () => {
    mocks.update.mockResolvedValueOnce({ ok: false, error: "failed" });
    render(step7());
    await click(tile(1));
    await click($("wizard-generate"));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect($("review-generate-error")?.textContent).toContain("couldn't apply your photo changes");
    expect(($("wizard-generate") as HTMLButtonElement).disabled).toBe(false);

    mocks.confirm.mockRejectedValueOnce(new Error("auth timeout"));
    await click($("review-generate-retry"));
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect($("review-generate-error")?.textContent).toContain("couldn't open your book");

    await click($("review-generate-retry"));
    expect(mocks.update).toHaveBeenCalledTimes(2); // synced already
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect($("review-generate-error")).toBeNull();
  });

  it("a thrown update counts as a failure", async () => {
    mocks.update.mockRejectedValueOnce(new Error("network"));
    render(step7());
    await click(tile(1));
    await click($("wizard-generate"));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect($("review-generate-error")).not.toBeNull();
  });

  it("disabled and busy while working; grid inert", async () => {
    let release!: () => void;
    mocks.confirm.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    render(step7());
    await click($("wizard-generate"));
    const btn = $("wizard-generate") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.textContent).toContain("Opening your book");
    expect(container.querySelector("[inert]")).not.toBeNull();
    await click(btn);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it("user-edited album: Continue in the editor, no update", async () => {
    render(step7({ userEdited: true }));
    expect($("review-edited")).not.toBeNull();
    await click(tile(1));
    await click($("wizard-generate"));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalled();
  });
});

describe("step 7 review — motion", () => {
  it("count-up animates from 0 when motion is allowed, static under reduced motion", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    render(step7());
    expect($("review-kept-visual")?.textContent).toBe("AI kept 0 of 5 photos");
    expect($("review-kept")?.textContent).toBe("AI kept 3 of 5 photos"); // screen readers: final value
    await act(async () => {
      for (let i = 0; i < 50 && frames.length; i++) frames.shift()!(performance.now() + 5000);
    });
    expect($("review-kept-visual")?.textContent).toBe("AI kept 3 of 5 photos");
    act(() => root.unmount());
    root = createRoot(container);

    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    frames.length = 0;
    render(step7());
    expect($("review-kept-visual")?.textContent).toBe("AI kept 3 of 5 photos");
    expect(frames).toHaveLength(0);
  });

  it("the wizard grid carries the motion hooks; the CSS animates only inside no-preference", async () => {
    render(step7());
    expect($("review-grid")?.hasAttribute("data-motion")).toBe(true);
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/src/components/books/wizard/steps/review-motion.css`, "utf8");
    const media = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(media).toBeGreaterThan(0);
    expect(css.slice(0, media)).not.toMatch(/animation:|transition:/);
  });
});

describe("classic ReviewGrid without the new props", () => {
  it("no undo toast, no motion hooks; thumb error uses router refresh", async () => {
    const toggle = vi.fn().mockResolvedValue({ ok: true });
    act(() => root.render(<ReviewGrid photos={step7().photos} aiUsed toggle={toggle} />));
    expect($("review-grid")?.hasAttribute("data-motion")).toBe(false);
    expect($("review-header")?.textContent).toBe("AI kept 3 of 5");
    await click(tile(1));
    expect($("review-undo-toast")).toBeNull();
    const img = tile(2).querySelector("img")!;
    await act(async () => {
      img.dispatchEvent(new Event("error"));
    });
    expect(mocks.refresh).toHaveBeenCalled();
  });
});

describe("review-step-model", () => {
  it("needsAlbumUpdate follows the classic unsynced rule, plus no album with kept photos", () => {
    const photos = step7().photos;
    const album = [id(1), id(2), id(3)];
    expect(needsAlbumUpdate(photos, album, { userEdited: false, building: false })).toBe(false);
    const dropped = photos.map((p) => (p.id === id(1) ? { ...p, status: "dropped", userOverride: true } : p));
    expect(needsAlbumUpdate(dropped, album, { userEdited: false, building: false })).toBe(true);
    expect(needsAlbumUpdate(dropped, album, { userEdited: true, building: false })).toBe(false);
    expect(needsAlbumUpdate(photos, [], { userEdited: false, building: false })).toBe(true);
  });
  it("updateStepOutcome / chapters / picks", () => {
    expect(updateStepOutcome({ ok: true, changed: false, pages: 2 })).toEqual({ go: true });
    expect(updateStepOutcome({ ok: false, error: "signed_out" })).toEqual({ go: true });
    expect(updateStepOutcome(null).go).toBe(false);
    expect(reviewChapters(step7().captionsPreview).map((c) => c.pages)).toEqual([2, 2]);
    expect(reviewCaptionPicks(step7().captionsPreview, "en", 2)).toHaveLength(2);
    expect(reviewCaptionPicks(null, "en")).toEqual([]);
  });
});
