// M9 T5 (D-057): setEmailReminders — admin upsert of profiles.email_reminders.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), select: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn() }));

const { setEmailReminders, ProfilesQueryError } = await import("@/lib/db/profiles");
const USER = "4F1C2B3A-5D6E-4F70-8A9B-0C1D2E3F4A5B";

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.from.mockReturnValue({ upsert: mocks.upsert });
  mocks.upsert.mockReturnValue({ select: mocks.select });
  mocks.select.mockResolvedValue({ data: [{ id: USER.toLowerCase() }], error: null });
});

describe("setEmailReminders", () => {
  it("upserts the lowercased id with the flag", async () => {
    expect(await setEmailReminders(USER, false)).toBe(true);
    expect(mocks.from).toHaveBeenCalledWith("profiles");
    expect(mocks.upsert).toHaveBeenCalledWith({ id: USER.toLowerCase(), email_reminders: false }, { onConflict: "id" });
  });

  it("refuses bad input without a query", async () => {
    expect(await setEmailReminders("nope", false)).toBe(false);
    expect(await setEmailReminders(USER, "no" as unknown as boolean)).toBe(false);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("deleted user (FK 23503) → false", async () => {
    mocks.select.mockResolvedValue({ data: null, error: { code: "23503" } });
    expect(await setEmailReminders(USER, true)).toBe(false);
  });

  it("other errors throw ProfilesQueryError with the code only", async () => {
    mocks.select.mockResolvedValue({ data: null, error: { code: "42501", message: "detail" } });
    await expect(setEmailReminders(USER, false)).rejects.toBeInstanceOf(ProfilesQueryError);
    await expect(setEmailReminders(USER, false)).rejects.toMatchObject({ code: "42501" });
  });
});
