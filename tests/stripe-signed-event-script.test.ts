// M7 T8: scripts/stripe-signed-event.mjs builds events the real webhook route accepts and
// routes exactly like Stripe's — so the live e2e (which skips fulfilment until migration 1200 is in
// prod) and manual runs exercise the real code paths. Route RPCs mocked; signatures real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

const SECRET = "whsec_t8_script_test_secret";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

const script = await import("../scripts/stripe-signed-event.mjs");
const route = await import("@/app/api/stripe/webhook/route");
const { validatePaidSession } = await import("@/lib/payments/session");

const BOOK = "11111111-2222-4333-8444-555555555555";
const USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function post(payload: string, signature: string) {
  return route.POST(
    new Request("http://localhost:3000/api/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: payload,
    }),
  );
}

/** postEvent() against the route handler (fetch stubbed) — covers its tamper logic too. */
async function postViaScript(payload: string, opts: { tamper?: boolean; secret?: string } = {}) {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("http://localhost:3640/api/stripe/webhook");
    return route.POST(new Request(String(input), init as RequestInit));
  });
  try {
    return await script.postEvent({ baseURL: "http://localhost:3640", payload, secret: opts.secret ?? SECRET, tamper: opts.tamper });
  } finally {
    fetchSpy.mockRestore();
  }
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  mocks.rpc.mockReset();
  mocks.revalidatePath.mockReset();
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("buildEvent", () => {
  it("completed: a session the real validator accepts, with fresh test ids", () => {
    const ev = script.buildEvent({ type: "completed", bookId: BOOK, userId: USER });
    const parsed = JSON.parse(ev.payload);
    expect(parsed).toMatchObject({ id: ev.id, object: "event", type: "checkout.session.completed", livemode: false });
    expect(ev.id).toMatch(/^evt_test_[0-9a-f]{24}$/);
    expect(ev.sessionId).toMatch(/^cs_test_[0-9a-f]{24}$/);
    expect(ev.paymentIntentId).toMatch(/^pi_test_[0-9a-f]{24}$/);
    const r = validatePaidSession(parsed.data.object);
    expect(r).toMatchObject({ ok: true, bookId: BOOK, userId: USER, amount: 3900, currency: "aed", sessionId: ev.sessionId, paymentIntentId: ev.paymentIntentId });
    expect(script.buildEvent({ type: "completed", bookId: BOOK, userId: USER }).id).not.toBe(ev.id);
  });

  it("wrong amount / currency / unpaid are rejected by the validator", () => {
    const obj = (o: Record<string, unknown>) => JSON.parse(script.buildEvent({ type: "completed", bookId: BOOK, userId: USER, ...o }).payload).data.object;
    expect(validatePaidSession(obj({ amount: 3800 }))).toEqual({ ok: false, reason: "wrong_amount" });
    expect(validatePaidSession(obj({ currency: "USD" }))).toEqual({ ok: false, reason: "wrong_currency" });
    expect(validatePaidSession(obj({ paymentStatus: "unpaid" }))).toEqual({ ok: false, reason: "not_paid" });
  });

  it("maps every --type to the Stripe event type and object", () => {
    const t = (type: string) => JSON.parse(script.buildEvent({ type: type as never, bookId: BOOK, userId: USER, paymentIntentId: "pi_x" }).payload);
    expect(t("async_succeeded").type).toBe("checkout.session.async_payment_succeeded");
    expect(t("async_failed")).toMatchObject({ type: "checkout.session.async_payment_failed", data: { object: { payment_status: "unpaid" } } });
    expect(t("expired")).toMatchObject({ type: "checkout.session.expired", data: { object: { status: "expired", payment_intent: null } } });
    expect(t("refunded")).toMatchObject({ type: "charge.refunded", data: { object: { object: "charge", amount: 3900, amount_refunded: 3900, payment_intent: "pi_x" } } });
    expect(t("partial_refund").data.object.amount_refunded).toBe(3800);
    expect(t("disputed")).toMatchObject({ type: "charge.dispute.created", data: { object: { object: "dispute", payment_intent: "pi_x" } } });
    expect(() => script.buildEvent({ type: "nope" as never })).toThrow(/unknown --type/);
    expect(() => script.buildEvent({ type: "completed" })).toThrow(/--book and --user/);
  });

  it("signPayload refuses an empty secret", () => {
    expect(() => script.signPayload("{}", "")).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });
});

describe("script events through the real webhook route", () => {
  it("completed → 200 and fulfil RPC with the event's ids; replay of the same event sends the same event id", async () => {
    mocks.rpc.mockResolvedValue({ data: "fulfilled", error: null });
    const ev = script.buildEvent({ type: "completed", bookId: BOOK, userId: USER });
    expect(await postViaScript(ev.payload)).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("fulfill_book_checkout", {
      p_event_id: ev.id,
      p_event_type: "checkout.session.completed",
      p_session_id: ev.sessionId,
      p_payment_intent: ev.paymentIntentId,
      p_book_id: BOOK,
      p_user_id: USER,
      p_amount: 3900,
      p_currency: "aed",
      p_livemode: false,
    });
    mocks.rpc.mockResolvedValue({ data: "duplicate", error: null });
    expect(await postViaScript(ev.payload)).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith("fulfill_book_checkout", expect.objectContaining({ p_event_id: ev.id }));
  });

  it("tamper → 400 and wrong secret → 400 (no RPC)", async () => {
    const ev = script.buildEvent({ type: "completed", bookId: BOOK, userId: USER });
    expect(await postViaScript(ev.payload, { tamper: true })).toBe(400);
    expect(await postViaScript(ev.payload, { secret: "whsec_someone_else" })).toBe(400);
    const refund = script.buildEvent({ type: "refunded" });
    expect(await postViaScript(refund.payload, { tamper: true })).toBe(400); // no amount_total in a charge
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("wrong amount → 200 without any RPC (acknowledged, never fulfilled)", async () => {
    const ev = script.buildEvent({ type: "completed", bookId: BOOK, userId: USER, amount: 3800 });
    expect(await post(ev.payload, script.signPayload(ev.payload, SECRET))).toHaveProperty("status", 200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("missing RPC (migration 1200 not applied: PGRST202) → 500 so Stripe retries", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "x" } });
    const ev = script.buildEvent({ type: "completed", bookId: BOOK, userId: USER });
    expect(await postViaScript(ev.payload)).toBe(500);
  });

  it("refunded → record refunded by payment intent; partial → no RPC; disputed / expired / async_failed recorded", async () => {
    mocks.rpc.mockResolvedValue({ data: "updated", error: null });
    const full = script.buildEvent({ type: "refunded", paymentIntentId: "pi_test_abc" });
    expect(await postViaScript(full.payload)).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith("record_stripe_order_event", {
      p_event_id: full.id,
      p_event_type: "charge.refunded",
      p_session_id: null,
      p_payment_intent: "pi_test_abc",
      p_status: "refunded",
      p_livemode: false,
    });
    mocks.rpc.mockClear();
    expect(await postViaScript(script.buildEvent({ type: "partial_refund", paymentIntentId: "pi_test_abc" }).payload)).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();

    expect(await postViaScript(script.buildEvent({ type: "disputed", paymentIntentId: "pi_test_abc" }).payload)).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith("record_stripe_order_event", expect.objectContaining({ p_status: "disputed", p_payment_intent: "pi_test_abc" }));
    const exp = script.buildEvent({ type: "expired", bookId: BOOK, userId: USER });
    expect(await postViaScript(exp.payload)).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith("record_stripe_order_event", expect.objectContaining({ p_status: "expired", p_session_id: exp.sessionId, p_payment_intent: null }));
    const failed = script.buildEvent({ type: "async_failed", bookId: BOOK, userId: USER });
    expect(await postViaScript(failed.payload)).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith("record_stripe_order_event", expect.objectContaining({ p_status: "failed", p_session_id: failed.sessionId }));
  });
});
