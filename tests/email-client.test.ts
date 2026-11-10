// M9 T5 (D-057): Resend client wrapper — enabled only with both env vars, typed error codes,
// 10 s timeout, never logs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ send: vi.fn(), ctor: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
    constructor(key: string) {
      mocks.ctor(key);
    }
  },
}));

const { isEmailEnabled, sendEmail, EMAIL_SEND_TIMEOUT_MS } = await import("@/lib/email/client");

const ENV = { RESEND_API_KEY: "re_test_123", EMAIL_FROM: "Photobook <hello@photobook.example>" };
const INPUT = {
  to: "someone@mail.example",
  subject: "Your photobook link expires in 3 days",
  html: "<p>hi</p>",
  text: "hi",
  headers: { "List-Unsubscribe": "<https://x/api/email/unsubscribe?t=a>" },
  idempotencyKey: "pb-expiry-x-20261110",
};

let spies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ data: { id: "em_1" }, error: null, headers: null });
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isEmailEnabled", () => {
  it("needs both RESEND_API_KEY and EMAIL_FROM", () => {
    expect(isEmailEnabled({})).toBe(false);
    expect(isEmailEnabled({ RESEND_API_KEY: "re_x" })).toBe(false);
    expect(isEmailEnabled({ EMAIL_FROM: "a@b.c" })).toBe(false);
    expect(isEmailEnabled({ RESEND_API_KEY: " ", EMAIL_FROM: "a@b.c" })).toBe(false);
    expect(isEmailEnabled(ENV)).toBe(true);
  });
});

describe("sendEmail", () => {
  it("not configured → not_configured, no API call", async () => {
    expect(await sendEmail(INPUT, {})).toEqual({ ok: false, code: "not_configured", retryable: false });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("sends from EMAIL_FROM with headers, signal and idempotency key", async () => {
    expect(await sendEmail(INPUT, ENV)).toEqual({ ok: true });
    const [payload, opts] = mocks.send.mock.calls[0];
    expect(payload).toEqual({
      from: ENV.EMAIL_FROM,
      to: INPUT.to,
      subject: INPUT.subject,
      html: INPUT.html,
      text: INPUT.text,
      headers: INPUT.headers,
    });
    expect(opts.idempotencyKey).toBe(INPUT.idempotencyKey);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["bad address", { to: "not-an-email" }],
    ["header injection in to", { to: "a@b.c\nBcc: x@y.z" }],
    ["newline in subject", { subject: "a\r\nBcc: x@y.z" }],
    ["empty html", { html: "" }],
  ])("%s → invalid_input, no API call", async (_n, patch) => {
    expect(await sendEmail({ ...INPUT, ...patch }, ENV)).toEqual({ ok: false, code: "invalid_input", retryable: false });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    [{ statusCode: 429, name: "rate_limit_exceeded" }, "rate_limited", true],
    [{ statusCode: 429, name: "daily_quota_exceeded" }, "quota", false],
    [{ statusCode: 500, name: "internal_server_error" }, "server", true],
    [{ statusCode: 422, name: "validation_error" }, "rejected", false],
    [{ statusCode: 403, name: "invalid_from_address" }, "rejected", false],
    [{ statusCode: null, name: "application_error" }, "network", true],
  ])("API error %j → %s", async (err, code, retryable) => {
    mocks.send.mockResolvedValue({ data: null, error: { message: "secret detail someone@mail.example", ...err }, headers: null });
    expect(await sendEmail(INPUT, ENV)).toEqual({ ok: false, code, retryable });
  });

  it("thrown error → network", async () => {
    mocks.send.mockRejectedValue(new Error("socket"));
    expect(await sendEmail(INPUT, ENV)).toEqual({ ok: false, code: "network", retryable: true });
  });

  it(`aborts after ${EMAIL_SEND_TIMEOUT_MS} ms → timeout`, async () => {
    vi.useFakeTimers();
    mocks.send.mockImplementation(
      (_p: unknown, opts: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          opts.signal.addEventListener("abort", () =>
            resolve({ data: null, error: { name: "application_error", statusCode: null, message: "x" }, headers: null }),
          );
        }),
    );
    const p = sendEmail(INPUT, ENV);
    await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS);
    expect(await p).toEqual({ ok: false, code: "timeout", retryable: true });
  });

  it("never logs (addresses, subjects or provider messages)", async () => {
    mocks.send.mockResolvedValueOnce({ data: null, error: { name: "validation_error", statusCode: 422, message: "bad someone@mail.example" }, headers: null });
    await sendEmail(INPUT, ENV);
    await sendEmail(INPUT, ENV);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
