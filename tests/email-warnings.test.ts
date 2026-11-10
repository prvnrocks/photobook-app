// M9 T5 (D-057): warning-email hook for the cleanup cron — nothing claimed without config,
// failed sends released, deadline respected, claim semantics never double-email, count-only logs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Expiry = { bookId: string; userId: string; email: string | null; title: string | null; expiresAt: string; isLive: boolean };
type Draft = { bookId: string; userId: string; email: string | null; title: string | null; lastActivityAt: string; deleteAfter: string };

const mocks = vi.hoisted(() => ({
  claimExpiryWarnings: vi.fn(),
  claimDraftWarnings: vi.fn(),
  releaseWarning: vi.fn(),
  isEmailEnabled: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock("@/lib/db/cleanup", () => ({
  claimExpiryWarnings: mocks.claimExpiryWarnings,
  claimDraftWarnings: mocks.claimDraftWarnings,
  releaseWarning: mocks.releaseWarning,
}));
vi.mock("@/lib/email/client", () => ({ isEmailEnabled: mocks.isEmailEnabled, sendEmail: mocks.sendEmail }));

const { createWarningSender } = await import("@/lib/email/warnings");
const { verifyUnsubscribeToken, getUnsubscribeKey } = await import("@/lib/email/unsubscribe-token");
const { DRAFT_IDLE_DAYS, DRAFT_WARNING_DAYS, EXPIRY_WARNING_DAYS_BEFORE } = await import("@/lib/cleanup/rules");

const SECRET = "test_book_access_secret_0123456789_abcdef";
const APP = "https://photobook.example";
const NOW = Date.parse("2026-11-10T01:00:00Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const expiryRow = (n: number, extra: Partial<Expiry> = {}): Expiry => ({
  bookId: uuid(n),
  userId: uuid(1000 + n),
  email: `owner${n}@mail.example`,
  title: `Secret trip ${n}`,
  expiresAt: "2026-11-12T20:00:00Z",
  isLive: true,
  ...extra,
});
const draftRow = (n: number, extra: Partial<Draft> = {}): Draft => ({
  bookId: uuid(n),
  userId: uuid(1000 + n),
  email: `drafter${n}@mail.example`,
  title: `عيد ${n}`,
  lastActivityAt: "2026-10-01T00:00:00Z",
  deleteAfter: "2026-11-17T00:00:00Z",
  ...extra,
});

const fast = { sleep: async () => {}, minIntervalMs: 0, retryDelayMs: 0 };
const ctx = (overrides: Partial<{ now: () => number; deadline: number }> = {}) => ({
  now: () => NOW,
  deadline: NOW + 240_000,
  ...overrides,
});

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("BOOK_ACCESS_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.isEmailEnabled.mockReturnValue(true);
  mocks.sendEmail.mockResolvedValue({ ok: true });
  mocks.claimExpiryWarnings.mockResolvedValue([]);
  mocks.claimDraftWarnings.mockResolvedValue([]);
  mocks.releaseWarning.mockResolvedValue(true);
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const logs = () => [...info.mock.calls, ...error.mock.calls].flat().map(String).join("\n");

describe("warnings hook", () => {
  it("email not configured → nothing claimed, nothing sent, complete", async () => {
    mocks.isEmailEnabled.mockReturnValue(false);
    const r = await createWarningSender(fast)(ctx());
    expect(r).toEqual({ sent: 0, failed: 0, complete: true });
    expect(mocks.claimExpiryWarnings).not.toHaveBeenCalled();
    expect(mocks.claimDraftWarnings).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["BOOK_ACCESS_SECRET", "no_unsubscribe_secret"],
    ["NEXT_PUBLIC_APP_URL", "no_app_url"],
  ])("missing %s → nothing claimed (code %s), incomplete", async (envKey, code) => {
    vi.stubEnv(envKey, "");
    vi.stubEnv("NODE_ENV", "production");
    const r = await createWarningSender(fast)(ctx());
    expect(r).toEqual({ sent: 0, failed: 0, complete: false });
    expect(mocks.claimExpiryWarnings).not.toHaveBeenCalled();
    expect(mocks.claimDraftWarnings).not.toHaveBeenCalled();
    expect(logs()).toContain(`code=${code}`);
  });

  it("claims with the rules constants and sends each email with unsubscribe headers", async () => {
    mocks.claimExpiryWarnings.mockResolvedValueOnce([expiryRow(1), expiryRow(2)]);
    mocks.claimDraftWarnings.mockResolvedValueOnce([draftRow(3)]);
    const r = await createWarningSender({ ...fast, batch: 50 })(ctx());
    expect(r).toEqual({ sent: 3, failed: 0, complete: true });
    expect(mocks.claimExpiryWarnings).toHaveBeenCalledWith(50, EXPIRY_WARNING_DAYS_BEFORE);
    expect(mocks.claimDraftWarnings).toHaveBeenCalledWith(50, DRAFT_WARNING_DAYS, DRAFT_IDLE_DAYS);
    expect(mocks.releaseWarning).not.toHaveBeenCalled();

    const calls = mocks.sendEmail.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.to).sort()).toEqual(["drafter3@mail.example", "owner1@mail.example", "owner2@mail.example"]);
    const exp = calls.find((c) => c.to === "owner1@mail.example");
    expect(exp.subject).toBe("Your photobook link expires in 3 days");
    expect(exp.html).toContain(`${APP}/books/${uuid(1)}/publish`);
    expect(exp.idempotencyKey).toBe(`pb-expiry-${uuid(1)}-20261110`);
    expect(exp.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const m = /^<(https:\/\/photobook\.example\/api\/email\/unsubscribe\?t=([^>]+))>$/.exec(exp.headers["List-Unsubscribe"]);
    expect(m).not.toBeNull();
    const token = decodeURIComponent((m as RegExpExecArray)[2]);
    const key = getUnsubscribeKey({ BOOK_ACCESS_SECRET: SECRET });
    expect(verifyUnsubscribeToken(token, NOW, key)).toBe(uuid(1001));
    expect(exp.html).toContain((m as RegExpExecArray)[1].replace(/&/g, "&amp;"));

    const draft = calls.find((c) => c.to === "drafter3@mail.example");
    expect(draft.subject).toBe("Your draft photobook will be deleted on 17 November 2026");
    expect(draft.html).toContain(`${APP}/books/${uuid(3)}/edit`);
    expect(draft.html).toContain('<span dir="auto"');
  });

  it("failed send → releaseWarning(book, kind), counted as failed", async () => {
    mocks.claimExpiryWarnings.mockResolvedValueOnce([expiryRow(1), expiryRow(2)]);
    mocks.claimDraftWarnings.mockResolvedValueOnce([draftRow(3)]);
    mocks.sendEmail.mockImplementation(async (input: { to: string }) =>
      input.to === "owner2@mail.example" || input.to === "drafter3@mail.example"
        ? { ok: false, code: "rejected", retryable: false }
        : { ok: true },
    );
    const r = await createWarningSender(fast)(ctx());
    expect(r).toEqual({ sent: 1, failed: 2, complete: true });
    expect(mocks.releaseWarning).toHaveBeenCalledTimes(2);
    expect(mocks.releaseWarning).toHaveBeenCalledWith(uuid(2), "expiry");
    expect(mocks.releaseWarning).toHaveBeenCalledWith(uuid(3), "draft");
    expect(logs()).toContain("codes=rejected:2");
  });

  it("retryable failure is retried once with the same idempotency key", async () => {
    mocks.claimExpiryWarnings.mockResolvedValueOnce([expiryRow(1)]);
    mocks.sendEmail.mockResolvedValueOnce({ ok: false, code: "timeout", retryable: true }).mockResolvedValueOnce({ ok: true });
    const r = await createWarningSender(fast)(ctx());
    expect(r.sent).toBe(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    const [a, b] = mocks.sendEmail.mock.calls.map((c) => c[0]);
    expect(a).toEqual(b);
    expect(mocks.releaseWarning).not.toHaveBeenCalled();
  });

  it("row without an email is not sent and is released", async () => {
    mocks.claimExpiryWarnings.mockResolvedValueOnce([expiryRow(1, { email: null })]);
    const r = await createWarningSender(fast)(ctx());
    expect(r).toEqual({ sent: 0, failed: 1, complete: true });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.releaseWarning).toHaveBeenCalledWith(uuid(1), "expiry");
  });

  it("releases happen after the kind's batches, so a failing book is not re-claimed in the same run", async () => {
    const order: string[] = [];
    mocks.claimExpiryWarnings
      .mockImplementationOnce(async () => (order.push("claim1"), [expiryRow(1), expiryRow(2)]))
      .mockImplementationOnce(async () => (order.push("claim2"), []));
    mocks.releaseWarning.mockImplementation(async () => (order.push("release"), true));
    mocks.sendEmail.mockImplementation(async (i: { to: string }) =>
      i.to === "owner1@mail.example" ? { ok: false, code: "rejected", retryable: false } : { ok: true },
    );
    await createWarningSender({ ...fast, batch: 2 })(ctx());
    expect(order).toEqual(["claim1", "claim2", "release"]);
  });

  it("deadline already passed → nothing claimed, incomplete", async () => {
    const r = await createWarningSender(fast)(ctx({ deadline: NOW }));
    expect(r).toEqual({ sent: 0, failed: 0, complete: false });
    expect(mocks.claimExpiryWarnings).not.toHaveBeenCalled();
    expect(mocks.claimDraftWarnings).not.toHaveBeenCalled();
  });

  it("deadline between batches: no new claim once time is up", async () => {
    let t = NOW;
    mocks.claimExpiryWarnings.mockResolvedValue([expiryRow(1), expiryRow(2)]);
    mocks.sendEmail.mockImplementation(async () => {
      t += 100_000;
      return { ok: true };
    });
    const r = await createWarningSender({ ...fast, batch: 2 })(ctx({ now: () => t, deadline: NOW + 150_000 }));
    expect(mocks.claimExpiryWarnings).toHaveBeenCalledTimes(1);
    expect(mocks.claimDraftWarnings).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: 2, failed: 0, complete: false });
  });

  it("a whole failed batch stops the kind (provider outage) and releases it", async () => {
    mocks.claimExpiryWarnings.mockResolvedValue([expiryRow(1), expiryRow(2)]);
    mocks.sendEmail.mockResolvedValue({ ok: false, code: "quota", retryable: false });
    const r = await createWarningSender({ ...fast, batch: 2 })(ctx());
    expect(mocks.claimExpiryWarnings).toHaveBeenCalledTimes(1);
    expect(mocks.releaseWarning).toHaveBeenCalledTimes(2);
    expect(r.complete).toBe(false);
  });

  it("at most 3 sends in flight", async () => {
    mocks.claimExpiryWarnings.mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => expiryRow(i + 1)));
    let inFlight = 0;
    let peak = 0;
    mocks.sendEmail.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return { ok: true };
    });
    const r = await createWarningSender({ ...fast, batch: 50 })(ctx());
    expect(r.sent).toBe(10);
    expect(peak).toBe(3);
  });

  it("paces send starts (min interval) through the injected sleep", async () => {
    mocks.claimExpiryWarnings.mockResolvedValueOnce([expiryRow(1), expiryRow(2), expiryRow(3)]);
    const sleeps: number[] = [];
    await createWarningSender({ sleep: async (ms) => void sleeps.push(ms), minIntervalMs: 500, retryDelayMs: 0 })(ctx());
    expect(sleeps).toEqual([500, 1000]);
  });

  it("claim semantics: repeated and overlapping runs never email a book twice", async () => {
    // Emulates claim_expiry_warnings: rows are marked sent atomically; only unsent rows return.
    const db = new Map([1, 2, 3, 4, 5].map((n) => [uuid(n), { row: expiryRow(n), sent: false }]));
    mocks.claimExpiryWarnings.mockImplementation(async (limit: number) => {
      const picked = [...db.values()].filter((b) => !b.sent).slice(0, limit);
      for (const b of picked) b.sent = true;
      return picked.map((b) => b.row);
    });
    mocks.releaseWarning.mockImplementation(async (id: string) => {
      const b = db.get(id);
      if (b) b.sent = false;
      return true;
    });
    const hook = createWarningSender({ ...fast, batch: 2 });
    await Promise.all([hook(ctx()), hook(ctx())]);
    await hook(ctx());
    const tos = mocks.sendEmail.mock.calls.map((c) => c[0].to);
    expect(tos.sort()).toEqual([1, 2, 3, 4, 5].map((n) => `owner${n}@mail.example`).sort());
  });

  it("claim error propagates (sweep marked failed) after releasing earlier failures", async () => {
    mocks.claimExpiryWarnings
      .mockResolvedValueOnce([expiryRow(1), expiryRow(2)])
      .mockRejectedValueOnce(Object.assign(new Error("claim failed"), { code: "57014" }));
    mocks.sendEmail.mockResolvedValueOnce({ ok: false, code: "rejected", retryable: false }).mockResolvedValue({ ok: true });
    await expect(createWarningSender({ ...fast, batch: 2 })(ctx())).rejects.toThrow();
    expect(mocks.releaseWarning).toHaveBeenCalledTimes(1);
    expect(logs()).toContain("error=57014");
  });

  it("logs contain counts and codes only — no emails, titles, ids or tokens", async () => {
    mocks.claimExpiryWarnings.mockResolvedValueOnce([expiryRow(1), expiryRow(2)]);
    mocks.claimDraftWarnings.mockResolvedValueOnce([draftRow(3)]);
    mocks.sendEmail.mockResolvedValueOnce({ ok: false, code: "rejected", retryable: false }).mockResolvedValue({ ok: true });
    await createWarningSender(fast)(ctx());
    const text = logs();
    expect(text).toMatch(/\[email\] warnings expiry_sent=\d+ expiry_failed=\d+ draft_sent=1 draft_failed=0/);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/Secret trip|عيد/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(text).not.toContain("u1.");
  });
});
