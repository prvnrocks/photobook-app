import { describe, expect, it } from "vitest";
import { bookCardHref, bookCardStep, RUNNING_AI_STATUSES, type BookCardState } from "@/lib/dashboard/card-target";

const ID = "22222222-2222-4222-8222-222222222222";
const base: BookCardState = { id: ID, page_count: 0, photo_count: 0, ai_status: "idle", user_edited: false };

describe("bookCardStep / bookCardHref", () => {
  it("no photos → upload", () => {
    expect(bookCardHref(base)).toBe(`/books/${ID}/upload`);
  });

  it("photos but no album → build", () => {
    expect(bookCardStep({ ...base, photo_count: 3 })).toBe("build");
  });

  it.each(RUNNING_AI_STATUSES)("build running (%s) → build, even with an album", (s) => {
    expect(bookCardStep({ ...base, ai_status: s })).toBe("build");
    expect(bookCardStep({ ...base, ai_status: s, page_count: 12, photo_count: 40 })).toBe("build");
  });

  it("built, never edited → review (keep/drop step not skipped)", () => {
    for (const ai_status of ["done", "partial", "failed", "idle", null]) {
      expect(bookCardHref({ ...base, page_count: 10, photo_count: 30, ai_status })).toBe(`/books/${ID}/review`);
    }
  });

  it("built and user-edited → editor", () => {
    expect(bookCardHref({ ...base, page_count: 10, photo_count: 30, ai_status: "done", user_edited: true })).toBe(
      `/books/${ID}/edit`,
    );
  });

  it("page_count wins over photo_count: album with 0 ready photos still opens review/edit", () => {
    expect(bookCardStep({ ...base, page_count: 4 })).toBe("review");
    expect(bookCardStep({ ...base, page_count: 4, user_edited: true })).toBe("edit");
  });
});
