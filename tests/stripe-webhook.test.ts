import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

const SECRET = "whsec_test_dummy_secret_for_vitest";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

const route = await import("@/app/api/stripe/webhook/route");
const { getStripe } = await import("@/lib/stripe");
const { config: middlewareConfig } = await import("@/middleware");

const BOOK = "11111111-2222-4333-8444-555555555555";
const OTHER_BOOK = "99999999-2222-4333-8444-555555555555";
const USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EMAIL = "secret.person@example.com";

function session(over: Record<string, unknown> = {}) {
  return {
    id: "cs_test_123",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    status: "complete",
    currency: "aed",
    amount_total: 3900,
    amount_subtotal: 3900,
    metadata: { kind: "book_upgrade", book_id: BOOK, user_id: USER },
    client_reference_id: BOOK,
    payment_intent: "pi_test_123",
    customer_email: EMAIL,
    customer_details: { email: EMAIL, name: "Secret Person" },
    livemode: false,
    ...over,
  };
}

function eventJson(type: string, object: unknown, id = "evt_test_1") {
  return JSON.stringify({
    id,
    object: "event",
    api_version: "2026-10-28.endive",
    created: 1_800_000_000,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  });
}

function sign(payload: string, secret = SECRET) {
  return getStripe().webhooks.generateTestHeaderString({ payload, secret });
}

function req(body: string, signature: string | null = sign(body)) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["stripe-signature"] = signature;
  return new Request("http://localhost:3000/api/stripe/webhook", { method: "POST", headers, body });
}

const post = (type: string, object: unknown, id?: string) => route.POST(req(eventJson(type, object, id)));

let logs: string[];
beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  mocks.rpc.mockReset();
  mocks.revalidatePath.mockReset();
  logs = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => {
  // Logs never carry emails, metadata values, amounts or book/user ids.
  const all = logs.join("\n");
  for (const forbidden of [EMAIL, "Secret Person", BOOK, OTHER_BOOK, USER, "3900", "book_upgrade"]) {
    expect(all).not.toContain(forbidden);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const FULFIL_ARGS = {
  p_event_id: "evt_test_1",
  p_event_type: "checkout.session.completed",
  p_session_id: "cs_test_123",
  p_payment_intent: "pi_test_123",
  p_book_id: BOOK,
  p_user_id: USER,
  p_amount: 3900,
  p_currency: "aed",
  p_livemode: false,
};

describe("POST /api/stripe/webhook — exports", () => {
  it("is a nodejs, force-dynamic, POST-only route", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
  });
});

describe("POST /api/stripe/webhook — signature", () => {
  it("400 on a bad signature (wrong secret)", async () => {
    const body = eventJson("checkout.session.completed", session());
    const res = await route.POST(req(body, sign(body, "whsec_other_secret")));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_signature" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400 on a tampered body", async () => {
    const body = eventJson("checkout.session.completed", session());
    const sig = sign(body);
    const tampered = eventJson("checkout.session.completed", session({ amount_total: 1 }));
    const res = await route.POST(req(tampered, sig));
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400 on a missing header", async () => {
    const res = await route.POST(req(eventJson("checkout.session.completed", session()), null));
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400 on a garbage header without echoing detail", async () => {
    const res = await route.POST(req(eventJson("checkout.session.completed", session()), "t=1,v1=abc"));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "bad_signature" }));
  });

  it("503 when payments are disabled; warns once", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const body = eventJson("checkout.session.completed", session());
    const r1 = await route.POST(req(body, "t=1,v1=x"));
    const r2 = await route.POST(req(body, "t=1,v1=x"));
    expect(r1.status).toBe(503);
    expect(r2.status).toBe(503);
    expect(logs.filter((l) => l.includes("not configured"))).toHaveLength(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/webhook — checkout sessions", () => {
  it("valid completed → fulfil with exact args → 200 + revalidate", async () => {
    mocks.rpc.mockResolvedValue({ data: "fulfilled", error: null });
    const res = await post("checkout.session.completed", session());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("fulfill_book_checkout", FULFIL_ARGS);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/books/${BOOK}/publish`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/books/${BOOK}/edit`);
    expect(logs.join("\n")).toContain("fulfilled evt=evt_test_1 cs=cs_test_123");
  });

  it("expanded payment_intent object → its id", async () => {
    mocks.rpc.mockResolvedValue({ data: "fulfilled", error: null });
    await post("checkout.session.completed", session({ payment_intent: { id: "pi_obj", object: "payment_intent" } }));
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_payment_intent: "pi_obj" });
  });

  it("replay → 'duplicate' → 200, no revalidate", async () => {
    mocks.rpc.mockResolvedValue({ data: "duplicate", error: null });
    const res = await post("checkout.session.completed", session());
    expect(res.status).toBe(200);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("already_paid → 200, no revalidate", async () => {
    mocks.rpc.mockResolvedValue({ data: "already_paid", error: null });
    expect((await post("checkout.session.completed", session())).status).toBe(200);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("book_missing → 200 + warning", async () => {
    mocks.rpc.mockResolvedValue({ data: "book_missing", error: null });
    expect((await post("checkout.session.completed", session())).status).toBe(200);
    expect(logs.some((l) => l.includes("book_missing"))).toBe(true);
  });

  it.each([
    ["wrong amount", { amount_total: 100 }, "wrong_amount"],
    ["wrong currency", { currency: "usd" }, "wrong_currency"],
    ["reference mismatch", { client_reference_id: OTHER_BOOK }, "reference_mismatch"],
    ["bad user id", { metadata: { kind: "book_upgrade", book_id: BOOK, user_id: "nope" } }, "invalid_user_id"],
    ["subscription mode", { mode: "subscription" }, "not_payment_mode"],
  ])("%s → not fulfilled, 200, reason logged", async (_n, over, reason) => {
    const res = await post("checkout.session.completed", session(over));
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes(`invalid:${reason}`) && l.includes("evt=evt_test_1"))).toBe(true);
  });

  it("non-upgrade kind → ignored 200", async () => {
    const res = await post("checkout.session.completed", session({ metadata: { kind: "something_else" } }));
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("no metadata → ignored 200", async () => {
    const res = await post("checkout.session.completed", session({ metadata: null }));
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("completed + unpaid (async pending) → no fulfil, 200", async () => {
    const res = await post("checkout.session.completed", session({ payment_status: "unpaid", payment_intent: null }));
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("pending"))).toBe(true);
  });

  it("async_payment_succeeded → fulfil", async () => {
    mocks.rpc.mockResolvedValue({ data: "fulfilled", error: null });
    const res = await post("checkout.session.async_payment_succeeded", session(), "evt_async");
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("fulfill_book_checkout", {
      ...FULFIL_ARGS,
      p_event_id: "evt_async",
      p_event_type: "checkout.session.async_payment_succeeded",
    });
  });

  it("async_payment_succeeded but unpaid → invalid not_paid, no fulfil", async () => {
    const res = await post("checkout.session.async_payment_succeeded", session({ payment_status: "unpaid" }));
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("invalid:not_paid"))).toBe(true);
  });

  it("async_payment_failed → record 'failed' by session", async () => {
    mocks.rpc.mockResolvedValue({ data: "updated", error: null });
    const res = await post("checkout.session.async_payment_failed", session({ payment_status: "unpaid" }), "evt_f");
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("record_stripe_order_event", {
      p_event_id: "evt_f",
      p_event_type: "checkout.session.async_payment_failed",
      p_session_id: "cs_test_123",
      p_payment_intent: "pi_test_123",
      p_status: "failed",
      p_livemode: false,
    });
  });

  it("expired → record 'expired' by session", async () => {
    mocks.rpc.mockResolvedValue({ data: "updated", error: null });
    const res = await post(
      "checkout.session.expired",
      session({ status: "expired", payment_status: "unpaid", payment_intent: null }),
      "evt_e",
    );
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("record_stripe_order_event", {
      p_event_id: "evt_e",
      p_event_type: "checkout.session.expired",
      p_session_id: "cs_test_123",
      p_payment_intent: null,
      p_status: "expired",
      p_livemode: false,
    });
  });

  it("expired non-upgrade session → ignored", async () => {
    const res = await post("checkout.session.expired", session({ metadata: {} }));
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("order_missing → 200 + warning", async () => {
    mocks.rpc.mockResolvedValue({ data: "order_missing", error: null });
    expect((await post("checkout.session.expired", session())).status).toBe(200);
    expect(logs.some((l) => l.includes("order_missing"))).toBe(true);
  });
});

describe("POST /api/stripe/webhook — charges", () => {
  const charge = (over: Record<string, unknown> = {}) => ({
    id: "ch_test_1",
    object: "charge",
    amount: 3900,
    amount_refunded: 3900,
    currency: "aed",
    payment_intent: "pi_test_123",
    billing_details: { email: EMAIL },
    metadata: { kind: "book_upgrade", book_id: BOOK, user_id: USER },
    livemode: false,
    ...over,
  });

  it("full refund → record 'refunded' by payment intent", async () => {
    mocks.rpc.mockResolvedValue({ data: "updated", error: null });
    const res = await post("charge.refunded", charge(), "evt_r");
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("record_stripe_order_event", {
      p_event_id: "evt_r",
      p_event_type: "charge.refunded",
      p_session_id: null,
      p_payment_intent: "pi_test_123",
      p_status: "refunded",
      p_livemode: false,
    });
  });

  it("partial refund → no RPC, warning", async () => {
    const res = await post("charge.refunded", charge({ amount_refunded: 1000 }));
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("partial_refund"))).toBe(true);
  });

  it("refund without payment intent → no RPC, 200", async () => {
    const res = await post("charge.refunded", charge({ payment_intent: null }));
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("dispute → record 'disputed' by dispute.payment_intent", async () => {
    mocks.rpc.mockResolvedValue({ data: "updated", error: null });
    const dispute = {
      id: "dp_test_1",
      object: "dispute",
      amount: 3900,
      currency: "aed",
      charge: "ch_test_1",
      payment_intent: "pi_test_123",
      reason: "fraudulent",
      status: "needs_response",
      livemode: false,
    };
    const res = await post("charge.dispute.created", dispute, "evt_d");
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("record_stripe_order_event", {
      p_event_id: "evt_d",
      p_event_type: "charge.dispute.created",
      p_session_id: null,
      p_payment_intent: "pi_test_123",
      p_status: "disputed",
      p_livemode: false,
    });
  });
});

describe("POST /api/stripe/webhook — other", () => {
  it("unknown event → 200, no RPC", async () => {
    const res = await post("customer.created", { id: "cus_1", object: "customer", email: EMAIL });
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("RPC error → 500 (Stripe retries), code-only log", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "40001", message: `boom ${BOOK}` } });
    const res = await post("checkout.session.completed", session());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_error" });
    expect(logs.some((l) => l.includes("db_error:40001"))).toBe(true);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("record RPC error → 500", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "22023" } });
    expect((await post("checkout.session.expired", session())).status).toBe(500);
  });

  it("unexpected RPC result → 500", async () => {
    mocks.rpc.mockResolvedValue({ data: "weird", error: null });
    expect((await post("checkout.session.completed", session())).status).toBe(500);
  });

  it("revalidate failure after fulfil still → 200", async () => {
    mocks.rpc.mockResolvedValue({ data: "fulfilled", error: null });
    mocks.revalidatePath.mockImplementation(() => {
      throw new Error("no static generation store");
    });
    expect((await post("checkout.session.completed", session())).status).toBe(200);
  });
});

describe("middleware matcher", () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config: middlewareConfig, url });

  it("skips the Stripe webhook", () => {
    expect(matches("/api/stripe/webhook")).toBe(false);
  });

  it.each([
    "/",
    "/dashboard",
    `/books/${BOOK}/publish`,
    `/books/${BOOK}/upgrade/success`,
    "/api/stripe/checkout",
    "/api/books/x/doc",
    "/b/some-slug",
    "/auth/confirm",
  ])("still runs on %s", (url) => {
    expect(matches(url)).toBe(true);
  });

  it.each(["/_next/static/chunk.js", "/favicon.ico", "/logo.png"])("still skips %s", (url) => {
    expect(matches(url)).toBe(false);
  });
});
