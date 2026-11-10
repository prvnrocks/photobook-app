// M9 T6: deleteBookAction (D-060) — auth, UUID check, delete_book_guarded result mapping, revalidate.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fake = vi.hoisted(() => ({
  user: null as { id: string } | null,
  deleteBookCompletely: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => fake.user }));
vi.mock("@/lib/cleanup/delete-book", () => ({ deleteBookCompletely: fake.deleteBookCompletely }));
vi.mock("next/cache", () => ({ revalidatePath: fake.revalidatePath }));

const { deleteBookAction } = await import("@/app/books/actions");
const { deleteBookErrorCopy } = await import("@/lib/dashboard/delete-book");

const U = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  fake.user = { id: U };
  fake.deleteBookCompletely.mockReset();
  fake.revalidatePath.mockReset();
});

describe("deleteBookAction", () => {
  it("signed out → unauthenticated, nothing deleted", async () => {
    fake.user = null;
    expect(await deleteBookAction(B)).toEqual({ ok: false, error: "unauthenticated" });
    expect(fake.deleteBookCompletely).not.toHaveBeenCalled();
  });

  it("malformed id → not_found without a DB call", async () => {
    expect(await deleteBookAction("../etc")).toEqual({ ok: false, error: "not_found" });
    expect(await deleteBookAction(undefined as unknown as string)).toEqual({ ok: false, error: "not_found" });
    expect(fake.deleteBookCompletely).not.toHaveBeenCalled();
  });

  it("deletes as the SESSION user and revalidates the dashboard", async () => {
    fake.deleteBookCompletely.mockResolvedValue({ ok: true, storageRemoved: 3, storageFailures: 0 });
    expect(await deleteBookAction(B)).toEqual({ ok: true });
    expect(fake.deleteBookCompletely).toHaveBeenCalledWith({ bookId: B, userId: U });
    expect(fake.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("storage failures still count as deleted (orphan sweep finishes)", async () => {
    fake.deleteBookCompletely.mockResolvedValue({ ok: true, storageRemoved: 0, storageFailures: 2 });
    expect(await deleteBookAction(B)).toEqual({ ok: true });
  });

  it("protected → error, no revalidate", async () => {
    fake.deleteBookCompletely.mockResolvedValue({ ok: false, error: "protected" });
    expect(await deleteBookAction(B)).toEqual({ ok: false, error: "protected" });
    expect(fake.revalidatePath).not.toHaveBeenCalled();
    expect(deleteBookErrorCopy("protected")).toBe("This book has a payment — contact support to delete it.");
  });

  it("not_found (foreign / already deleted) → error + revalidate so the card disappears", async () => {
    fake.deleteBookCompletely.mockResolvedValue({ ok: false, error: "not_found" });
    expect(await deleteBookAction(B)).toEqual({ ok: false, error: "not_found" });
    expect(fake.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("failed → failed, no revalidate", async () => {
    fake.deleteBookCompletely.mockResolvedValue({ ok: false, error: "failed" });
    expect(await deleteBookAction(B)).toEqual({ ok: false, error: "failed" });
    expect(fake.revalidatePath).not.toHaveBeenCalled();
  });

  it("error copy for every code", () => {
    expect(deleteBookErrorCopy("unauthenticated")).toMatch(/sign in/i);
    expect(deleteBookErrorCopy("not_found")).toMatch(/already deleted/);
    expect(deleteBookErrorCopy("failed")).toMatch(/try again/);
    expect(deleteBookErrorCopy(undefined)).toMatch(/try again/);
  });
});
