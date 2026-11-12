// M12 T2: server actions answer an Auth timeout with their existing generic error (never a throw
// to the client, never "signed out"). getCurrentUser throws SupabaseUnavailableError; the actions
// use getActionUser (src/lib/auth/action-user.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
const auth = vi.hoisted(() => ({ fail: true }));
vi.mock("@/lib/auth/current-user", async () => {
  const { SupabaseUnavailableError } = await import("@/lib/supabase/deadline");
  return {
    getCurrentUser: async () => {
      if (auth.fail) throw new SupabaseUnavailableError();
      return null;
    },
  };
});

const books = await import("@/app/books/actions");
const settings = await import("@/app/settings/actions");
const review = await import("@/app/books/[id]/review/actions");
const publish = await import("@/app/books/[id]/publish/actions");
const upgrade = await import("@/app/books/[id]/upgrade/actions");
const { SupabaseUnavailableError } = await import("@/lib/supabase/deadline");

const BOOK = "22222222-2222-4222-8222-222222222222";
const PHOTO = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  auth.fail = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("server actions on an Auth timeout → generic error", () => {
  it("books: create / delete photo / delete unfinished / delete book", async () => {
    const created = await books.createBookAction({ ok: true } as never, new FormData());
    expect(created).toMatchObject({ ok: false });
    expect((created as { error: string }).error).toMatch(/couldn|try again|wrong/i);
    const del = await books.deletePhotoAction(PHOTO, BOOK);
    expect(del.ok).toBe(false);
    expect((del as { error: string }).error).not.toMatch(/sign in/i);
    expect((await books.deleteUnfinishedAction(BOOK)).ok).toBe(false);
    expect(await books.deleteBookAction(BOOK)).toEqual({ ok: false, error: "failed" });
  });

  it("settings: clear memory / email reminders / delete account", async () => {
    expect(await settings.clearMemoryAction()).toEqual({ ok: false, error: "failed" });
    expect(await settings.setEmailRemindersAction(true)).toEqual({ ok: false, error: "failed" });
    expect(await settings.deleteAccountAction("DELETE")).toEqual({ ok: false, error: "failed" });
  });

  it("review / share / publish / upgrade", async () => {
    const toggled = await review.togglePhotoAction(BOOK, PHOTO, true);
    expect(toggled.ok).toBe(false);
    expect((toggled as { error: string }).error).not.toMatch(/sign in/i);
    expect(await review.updateAlbumAction(BOOK)).toEqual({ ok: false, error: "failed" });
    expect(await publish.shareBookAction(BOOK)).toEqual({ ok: false, error: "failed" });
    expect(await publish.getPublishState(BOOK)).toEqual({ ok: false, error: "failed" });
    expect(await upgrade.startUpgradeCheckout(BOOK)).toEqual({ error: "failed" });
    expect(await upgrade.getUpgradeStatus(BOOK)).toEqual({ error: "failed" });
  });

  it("confirmAlbumAction (form action, no result) throws to error.tsx — never a login redirect", async () => {
    const err = await review.confirmAlbumAction(BOOK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupabaseUnavailableError);
  });

  it("signed out (real auth answer) keeps the signed-out results", async () => {
    auth.fail = false;
    expect(await settings.clearMemoryAction()).toEqual({ ok: false, error: "signed_out" });
    expect(await books.deleteBookAction(BOOK)).toEqual({ ok: false, error: "unauthenticated" });
    expect(await publish.shareBookAction(BOOK)).toEqual({ ok: false, error: "signed_out" });
  });
});
