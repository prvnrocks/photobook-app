import { describe, expect, it } from "vitest";
import { bookCardHref, bookCardStep, RUNNING_AI_STATUSES, type BookCardState } from "@/lib/dashboard/card-target";

const ID = "22222222-2222-4222-8222-222222222222";
const base: BookCardState = { id: ID, page_count: 0, photo_count: 0, ai_status: "idle", user_edited: false };

describe("bookCardStep / bookCardHref", () => {
  it("no photos → upload step; href goes straight into wizard step 3, Photos (M20 T9, one hop; Task 5 order)", () => {
    expect(bookCardStep(base)).toBe("upload");
    expect(bookCardHref(base)).toBe(`/books/new?book=${ID}&step=3`);
  });

  it("photos but no album → build step; href = wizard step 6 (its gate moves on: run done → 7, AI off → classic)", () => {
    expect(bookCardStep({ ...base, photo_count: 3 })).toBe("build");
    expect(bookCardHref({ ...base, photo_count: 3 })).toBe(`/books/new?book=${ID}&step=6`);
    expect(bookCardHref({ ...base, photo_count: 3, ai_status: null })).toBe(`/books/new?book=${ID}&step=6`);
  });

  it.each(RUNNING_AI_STATUSES)("build running (%s) → the build page (only it can tell a rebuild from a first build)", (s) => {
    expect(bookCardStep({ ...base, ai_status: s })).toBe("build");
    expect(bookCardStep({ ...base, ai_status: s, page_count: 12, photo_count: 40 })).toBe("build");
    expect(bookCardHref({ ...base, ai_status: s })).toBe(`/books/${ID}/build`);
    expect(bookCardHref({ ...base, ai_status: s, page_count: 12, photo_count: 40 })).toBe(`/books/${ID}/build`);
  });

  it("built (AI or rule album), never edited → editor (D-070: review only via the chip)", () => {
    for (const ai_status of ["done", "partial", "failed", "idle", null]) {
      expect(bookCardHref({ ...base, page_count: 10, photo_count: 30, ai_status })).toBe(`/books/${ID}/edit`);
    }
  });

  it("built and user-edited → editor", () => {
    expect(bookCardHref({ ...base, page_count: 10, photo_count: 30, ai_status: "done", user_edited: true })).toBe(
      `/books/${ID}/edit`,
    );
  });

  it("page_count wins over photo_count: album with 0 ready photos still opens the editor", () => {
    expect(bookCardStep({ ...base, page_count: 4 })).toBe("edit");
    expect(bookCardStep({ ...base, page_count: 4, user_edited: true })).toBe("edit");
  });
});
