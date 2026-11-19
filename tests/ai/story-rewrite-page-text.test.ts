// Task 8: the editor's "Rewrite story" on one page text (src/lib/ai/story/rewrite-page-text.ts).
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("@/lib/db/books", () => ({ getMyBook: vi.fn(async () => null) }));
vi.mock("@/lib/db/storybooks", () => ({ appendStorybookVersion: vi.fn(), getCurrentStorybook: vi.fn() }));
vi.mock("@/lib/ai/story/service", () => {
  class StoryError extends Error {
    constructor(
      public readonly code: string,
      public readonly detail?: string,
      public readonly retryable = false,
    ) {
      super(code);
    }
  }
  return { StoryError, rewriteNarrativeBlock: vi.fn() };
});

import { rewritePageText } from "@/lib/ai/story/rewrite-page-text";
import { StoryError } from "@/lib/ai/story/service";
import type { Storybook } from "@/lib/storybook/types";

const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prov = { source: "ai" as const, rev: 1, aiVersion: 1, editedAt: null };
const story = { version: 4, pages: [{ id: "p1", blocks: [{ id: "b3", kind: "paragraph", text: "The AI words.", lang: "en", provenance: prov, groundedIn: [] }] }] } as unknown as Storybook;
const result = (stored: boolean) => ({ proposal: { blockId: "b3", kind: "paragraph", text: "New words.", lang: "en", groundedIn: [], factRefs: [] }, stored, storybook: null });

describe("rewritePageText", () => {
  it("AI text → rewriteNarrativeBlock stores it (no proposal); nothing else is appended", async () => {
    const rewrite = vi.fn(async () => result(true));
    const append = vi.fn();
    const out = await rewritePageText({ bookId: BOOK, blockRef: "b3", text: "The AI words.", source: "ai", instruction: { kind: "shorter" } }, { ownerOf: async () => USER, rewrite: rewrite as never, appendVersion: append as never, getCurrent: async () => story });
    expect(out).toEqual({ text: "New words.", lang: "en", proposal: false });
    expect(rewrite).toHaveBeenCalledWith(`${BOOK}/b3`, { kind: "shorter" }, { bookId: BOOK, propose: false });
    expect(append).not.toHaveBeenCalled();
  });

  it("the user's own words → recorded as a user edit first (no model call), then ONLY a proposal", async () => {
    const rewrite = vi.fn(async () => result(false));
    const append = vi.fn(async () => "ok" as const);
    const out = await rewritePageText(
      { bookId: BOOK, blockRef: "b3", text: "Our own words.", source: "user", instruction: { kind: "simpler" } },
      { ownerOf: async () => USER, rewrite: rewrite as never, appendVersion: append as never, getCurrent: async () => story, now: () => Date.parse("2026-11-19T10:00:00Z") },
    );
    expect(out.proposal).toBe(true);
    expect(rewrite).toHaveBeenCalledWith(`${BOOK}/b3`, { kind: "simpler" }, { bookId: BOOK, propose: true });
    const appended = (append.mock.calls[0] as unknown as [Storybook, string])[0];
    expect(appended.version).toBe(5);
    expect(appended.origin).toBe("user");
    expect(appended.pages[0]!.blocks[0]).toMatchObject({ text: "Our own words.", provenance: { source: "user" } });
  });

  it("a protected block shown as AI text → asked again as a proposal; someone else's book → not_found before anything", async () => {
    const rewrite = vi.fn().mockRejectedValueOnce(new StoryError("protected")).mockResolvedValueOnce(result(false));
    const out = await rewritePageText({ bookId: BOOK, blockRef: "b3", text: "x", source: "ai", instruction: { kind: "longer" } }, { ownerOf: async () => USER, rewrite: rewrite as never });
    expect(out.proposal).toBe(true);
    expect(rewrite).toHaveBeenLastCalledWith(`${BOOK}/b3`, { kind: "longer" }, { bookId: BOOK, propose: true });
    const never = vi.fn();
    await expect(rewritePageText({ bookId: BOOK, blockRef: "b3", text: "x", source: "ai", instruction: { kind: "longer" } }, { ownerOf: async () => null, rewrite: never as never })).rejects.toMatchObject({ code: "not_found" });
    await expect(rewritePageText({ bookId: BOOK, blockRef: "zz", text: "x", source: "ai", instruction: { kind: "longer" } }, { ownerOf: async () => USER, rewrite: never as never })).rejects.toMatchObject({ code: "not_found" });
    expect(never).not.toHaveBeenCalled();
  });
});
