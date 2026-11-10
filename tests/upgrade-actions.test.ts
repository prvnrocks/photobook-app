import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M7 T5: upgrade server actions over src/lib/db/upgrade.ts with an in-memory admin client
// (books + orders, incl. orders_one_pending_per_book / stripe_session_id uniqueness) and a fake
// Stripe client (sessions.create / retrieve / expire with idempotency keys).

type Row = Record<string, unknown>;
type Filter = [string, unknown];

const fake = vi.hoisted(() => {
  const state = {
    user: null as { id: string; email?: string } | null,
    enabled: true,
    books: [] as Row[],
    orders: [] as Row[],
    dbError: null as { code: string } | null,
    sessions: new Map<string, Row>(),
    idem: new Map<string, string>(),
    createCalls: [] as { params: Row; opts: Row }[],
    expireCalls: [] as string[],
    retrieveCalls: [] as string[],
    createError: null as unknown,
    expireError: null as unknown,
    retrieveError: null as unknown,
    seq: 0,
    /** Called right before an insert, to simulate a parallel request winning the race. */
    beforeInsert: null as null | (() => void),
  };

  function query(table: string, op: "select" | "insert" | "update", payload?: Row) {
    const filters: Filter[] = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    let mode: "many" | "maybe" | "single" = "many";
    const rows = () => (table === "books" ? state.books : state.orders);
    const match = (r: Row) => filters.every(([c, v]) => r[c] === v);

    function run(): { data: unknown; error: unknown } {
      if (state.dbError) return { data: null, error: state.dbError };
      if (op === "insert") {
        state.beforeInsert?.();
        state.beforeInsert = null;
        const p = payload as Row;
        const dup = state.orders.some(
          (o) =>
            (o.stripe_session_id && o.stripe_session_id === p.stripe_session_id) ||
            (p.status === "pending" && o.status === "pending" && o.book_id === p.book_id),
        );
        if (dup) return { data: null, error: { code: "23505" } };
        const row = { id: `00000000-0000-4000-8000-${String(++state.seq).padStart(12, "0")}`, created_at: new Date(Date.now() + state.seq).toISOString(), ...p };
        state.orders.push(row);
        return { data: { id: row.id }, error: null };
      }
      let found = rows().filter(match);
      if (op === "update") {
        for (const r of found) Object.assign(r, payload);
        return { data: found.map((r) => ({ id: r.id })), error: null };
      }
      if (orderBy) {
        const { col, asc } = orderBy;
        found = [...found].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (limit !== null) found = found.slice(0, limit);
      if (mode === "maybe") return { data: found[0] ?? null, error: null };
      return { data: found, error: null };
    }

    const b: Record<string, unknown> = {
      eq: (c: string, v: unknown) => (filters.push([c, v]), b),
      order: (col: string, o: { ascending: boolean }) => ((orderBy = { col, asc: o.ascending }), b),
      limit: (n: number) => ((limit = n), b),
      select: () => b,
      maybeSingle: () => ((mode = "maybe"), b),
      single: () => ((mode = "single"), b),
      then: (res: (r: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }

  const admin = {
    from: (table: string) => ({
      select: () => query(table, "select"),
      insert: (p: Row) => query(table, "insert", p),
      update: (p: Row) => query(table, "update", p),
    }),
  };

  const stripe = {
    checkout: {
      sessions: {
        create: async (params: Row, opts: Row) => {
          state.createCalls.push({ params, opts });
          if (state.createError) throw state.createError;
          const key = opts.idempotencyKey as string;
          const existing = state.idem.get(key);
          if (existing) return state.sessions.get(existing);
          const id = `cs_test_${++state.seq}`;
          const s = {
            id,
            url: `https://checkout.stripe.com/c/pay/${id}`,
            status: "open",
            payment_status: "unpaid",
            mode: params.mode,
            currency: "aed",
            amount_total: 3900,
            metadata: params.metadata,
            client_reference_id: params.client_reference_id,
            payment_intent: null,
            livemode: false,
            expires_at: params.expires_at,
          };
          state.sessions.set(id, s);
          state.idem.set(key, id);
          return s;
        },
        retrieve: async (id: string) => {
          state.retrieveCalls.push(id);
          if (state.retrieveError) throw state.retrieveError;
          const s = state.sessions.get(id);
          if (!s) throw Object.assign(new Error("No such session"), { type: "StripeInvalidRequestError", code: "resource_missing" });
          return s;
        },
        expire: async (id: string) => {
          state.expireCalls.push(id);
          if (state.expireError) throw state.expireError;
          const s = state.sessions.get(id);
          if (s) s.status = "expired";
          return s;
        },
      },
    },
  };
  return { state, admin, stripe };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => fake.state.user }));
vi.mock("@/lib/stripe", () => ({
  isPaymentsEnabled: () => fake.state.enabled,
  getStripe: () => {
    if (!fake.state.enabled) throw new Error("Stripe is not configured");
    return fake.stripe;
  },
}));

const { startUpgradeCheckout, getUpgradeStatus } = await import("@/app/books/[id]/upgrade/actions");
const { buildCheckoutParams } = await import("@/lib/payments/session");

const USER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const BOOK = "11111111-1111-4111-8111-111111111111";
const EMAIL = "secret.person@example.com";
const TITLE = "SECRET_Title_Villa";
const ORIGIN = "https://app.example.com";
const NOW = new Date("2026-11-10T12:00:20.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const BUCKET = Math.ceil(NOW_SEC / 60) * 60;

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function storeSession(over: Row = {}): Row {
  const id = (over.id as string) ?? `cs_test_stored_${++fake.state.seq}`;
  const s = {
    id,
    url: `https://checkout.stripe.com/c/pay/${id}`,
    status: "open",
    payment_status: "unpaid",
    mode: "payment",
    currency: "aed",
    amount_total: 3900,
    metadata: { kind: "book_upgrade", book_id: BOOK, user_id: USER },
    client_reference_id: BOOK,
    payment_intent: null,
    livemode: false,
    expires_at: NOW_SEC + 20 * 60,
    ...over,
  };
  fake.state.sessions.set(id, s);
  return s;
}

function pendingOrder(sessionId: string | null, over: Row = {}): Row {
  const row = {
    id: `00000000-0000-4000-8000-${String(++fake.state.seq).padStart(12, "0")}`,
    book_id: BOOK,
    user_id: USER,
    type: "digital",
    status: "pending",
    stripe_session_id: sessionId,
    amount: 3900,
    currency: "aed",
    livemode: false,
    created_at: "2026-11-10T11:50:00.000Z",
    ...over,
  };
  fake.state.orders.push(row);
  return row;
}

function allLogs(): string {
  return [errSpy, warnSpy, logSpy].flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN);
  Object.assign(fake.state, {
    user: { id: USER, email: EMAIL },
    enabled: true,
    books: [{ id: BOOK, user_id: USER, is_paid: false, slug: "summer-aB3dEfGhJk", title: TITLE }],
    orders: [],
    dbError: null,
    sessions: new Map(),
    idem: new Map(),
    createCalls: [],
    expireCalls: [],
    retrieveCalls: [],
    createError: null,
    expireError: null,
    retrieveError: null,
    beforeInsert: null,
  });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("startUpgradeCheckout — guards", () => {
  it("unauthenticated", async () => {
    fake.state.user = null;
    expect(await startUpgradeCheckout(BOOK)).toEqual({ error: "unauthenticated" });
    expect(fake.state.createCalls).toHaveLength(0);
  });

  it("non-UUID → not_found", async () => {
    expect(await startUpgradeCheckout("not-a-uuid")).toEqual({ error: "not_found" });
    expect(await startUpgradeCheckout(`${BOOK}' or 1=1`)).toEqual({ error: "not_found" });
  });

  it("non-owner → not_found (no Stripe call)", async () => {
    fake.state.user = { id: OTHER, email: "x@example.com" };
    expect(await startUpgradeCheckout(BOOK)).toEqual({ error: "not_found" });
    expect(fake.state.createCalls).toHaveLength(0);
  });

  it("payments not configured → unavailable", async () => {
    fake.state.enabled = false;
    expect(await startUpgradeCheckout(BOOK)).toEqual({ error: "unavailable" });
  });

  it("already paid → already_paid", async () => {
    fake.state.books[0].is_paid = true;
    expect(await startUpgradeCheckout(BOOK)).toEqual({ error: "already_paid" });
    expect(fake.state.createCalls).toHaveLength(0);
  });
});

describe("startUpgradeCheckout — needs_review", () => {
  it("an order needing review blocks a new checkout → failed + error log, no Stripe call", async () => {
    pendingOrder("cs_test_review", { status: "needs_review" });
    expect(await startUpgradeCheckout(BOOK)).toEqual({ error: "failed" });
    expect(fake.state.createCalls).toHaveLength(0);
    expect(fake.state.retrieveCalls).toHaveLength(0);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(["[upgrade] blocked: book has an order needing review"]);
    expect(allLogs()).not.toContain(BOOK);
  });

  it("other terminal orders (expired / failed / refunded) do not block", async () => {
    pendingOrder("cs_test_e", { status: "expired" });
    pendingOrder("cs_test_f", { status: "failed" });
    pendingOrder("cs_test_r", { status: "refunded" });
    const res = await startUpgradeCheckout(BOOK);
    expect(res).toHaveProperty("url");
    expect(fake.state.createCalls).toHaveLength(1);
  });

  it("already paid wins over needs_review (already_paid)", async () => {
    fake.state.books[0].is_paid = true;
    pendingOrder("cs_test_review", { status: "needs_review" });
    expect(await startUpgradeCheckout(BOOK)).toEqual({ error: "already_paid" });
  });

  it("getUpgradeStatus reports needs_review as the latest order status", async () => {
    pendingOrder("cs_test_review", { status: "needs_review" });
    expect(await getUpgradeStatus(BOOK)).toEqual({ isPaid: false, orderStatus: "needs_review" });
  });
});

describe("startUpgradeCheckout — create", () => {
  it("creates a session with buildCheckoutParams (env origin, user email) and inserts a pending order", async () => {
    const res = await startUpgradeCheckout(BOOK);
    expect(fake.state.createCalls).toHaveLength(1);
    const { params, opts } = fake.state.createCalls[0];
    expect(params).toEqual(
      buildCheckoutParams({ bookId: BOOK, userId: USER, email: EMAIL, origin: ORIGIN, returnTo: null, nowSec: BUCKET }),
    );
    expect(params.customer_email).toBe(EMAIL);
    expect(String(params.success_url).startsWith(`${ORIGIN}/books/${BOOK}/upgrade/success`)).toBe(true);
    // expires_at 31–32 min ahead
    const ttl = (params.expires_at as number) - NOW_SEC;
    expect(ttl).toBeGreaterThanOrEqual(31 * 60);
    expect(ttl).toBeLessThanOrEqual(32 * 60);
    // idempotency key carries no email
    expect(String(opts.idempotencyKey)).toMatch(new RegExp(`^upgrade:${BOOK}:${USER}:${BUCKET}:[0-9a-f]{24}$`));
    expect(String(opts.idempotencyKey)).not.toContain("example.com");
    // title never sent to Stripe
    expect(JSON.stringify(params)).not.toContain(TITLE);

    const session = [...fake.state.sessions.values()][0];
    expect(res).toEqual({ url: session.url });
    expect(fake.state.orders).toHaveLength(1);
    expect(fake.state.orders[0]).toMatchObject({
      book_id: BOOK,
      user_id: USER,
      type: "digital",
      status: "pending",
      stripe_session_id: session.id,
      amount: 3900,
      currency: "aed",
      livemode: false,
    });
  });

  it("never uses request headers: origin comes from NEXT_PUBLIC_APP_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://other.example.org/");
    await startUpgradeCheckout(BOOK);
    expect(String(fake.state.createCalls[0].params.cancel_url).startsWith("https://other.example.org/books/")).toBe(true);
  });

  it("allow-listed returnTo passes through to cancel_url; others fall back to publish", async () => {
    await startUpgradeCheckout(BOOK, `/books/${BOOK}/edit`);
    expect(fake.state.createCalls[0].params.cancel_url).toBe(`${ORIGIN}/books/${BOOK}/edit?upgrade=cancelled`);

    fake.state.orders = [];
    await startUpgradeCheckout(BOOK, "/b/summer-aB3dEfGhJk");
    expect(fake.state.createCalls[1].params.cancel_url).toBe(`${ORIGIN}/b/summer-aB3dEfGhJk?upgrade=cancelled`);

    fake.state.orders = [];
    await startUpgradeCheckout(BOOK, "https://evil.example/phish");
    expect(fake.state.createCalls[2].params.cancel_url).toBe(`${ORIGIN}/books/${BOOK}/publish?upgrade=cancelled`);
  });

  it("/b/{slug} returnTo only for the book's own slug (another published book's slug → publish)", async () => {
    await startUpgradeCheckout(BOOK, "/b/someone-else-aB3dEfGhJk");
    expect(fake.state.createCalls[0].params.cancel_url).toBe(`${ORIGIN}/books/${BOOK}/publish?upgrade=cancelled`);

    fake.state.orders = [];
    fake.state.books[0].slug = null; // unpublished: no /b/ path at all
    await startUpgradeCheckout(BOOK, "/b/summer-aB3dEfGhJk");
    expect(fake.state.createCalls[1].params.cancel_url).toBe(`${ORIGIN}/books/${BOOK}/publish?upgrade=cancelled`);
  });

  it("upper-case book id in returnTo is accepted and normalised", async () => {
    await startUpgradeCheckout(BOOK.toUpperCase(), `/books/${BOOK.toUpperCase()}/edit`);
    expect(fake.state.createCalls[0].params.cancel_url).toBe(`${ORIGIN}/books/${BOOK}/edit?upgrade=cancelled`);
  });

  it("omits customer_email when the user has none", async () => {
    fake.state.user = { id: USER };
    await startUpgradeCheckout(BOOK);
    expect(fake.state.createCalls[0].params).not.toHaveProperty("customer_email");
  });

  it("double click: second call reuses the stored open session (one order, one session)", async () => {
    const a = await startUpgradeCheckout(BOOK);
    const b = await startUpgradeCheckout(BOOK);
    expect(b).toEqual(a);
    expect(fake.state.createCalls).toHaveLength(1);
    expect(fake.state.orders).toHaveLength(1);
  });

  it("Stripe error → failed, logs a code only (no email / title / ids)", async () => {
    fake.state.createError = Object.assign(new Error(`Invalid email ${EMAIL} for ${TITLE}`), {
      type: "StripeInvalidRequestError",
      code: "email_invalid",
    });
    expect(await startUpgradeCheckout(BOOK)).toEqual({ error: "failed" });
    expect(fake.state.orders).toHaveLength(0);
    const logs = allLogs();
    expect(logs).toContain("email_invalid");
    expect(logs).not.toContain(EMAIL);
    expect(logs).not.toContain(TITLE);
    expect(logs).not.toContain(BOOK);
    expect(logs).not.toContain(USER);
  });

  it("Stripe error without a code logs the error type", async () => {
    fake.state.createError = Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" });
    expect(await startUpgradeCheckout(BOOK)).toEqual({ error: "failed" });
    expect(allLogs()).toContain("StripeConnectionError");
  });

  it("DB error → failed", async () => {
    fake.state.dbError = { code: "57014" };
    expect(await startUpgradeCheckout(BOOK)).toEqual({ error: "failed" });
    expect(allLogs()).toContain("57014");
  });
});

describe("startUpgradeCheckout — reuse", () => {
  it("reuses an open stored session with > 5 min left", async () => {
    const s = storeSession();
    pendingOrder(s.id as string);
    expect(await startUpgradeCheckout(BOOK)).toEqual({ url: s.url });
    expect(fake.state.createCalls).toHaveLength(0);
    expect(fake.state.expireCalls).toHaveLength(0);
  });

  it("expired stored session → order marked expired, new session created", async () => {
    const s = storeSession({ status: "expired" });
    const old = pendingOrder(s.id as string);
    const res = await startUpgradeCheckout(BOOK);
    expect(old.status).toBe("expired");
    expect(fake.state.expireCalls).toHaveLength(0);
    expect(fake.state.createCalls).toHaveLength(1);
    const pend = fake.state.orders.filter((o) => o.status === "pending");
    expect(pend).toHaveLength(1);
    expect(res).toEqual({ url: fake.state.sessions.get(pend[0].stripe_session_id as string)!.url });
  });

  it("open but near expiry → expired at Stripe, order expired, new session created", async () => {
    const s = storeSession({ expires_at: NOW_SEC + 4 * 60 });
    const old = pendingOrder(s.id as string);
    const res = await startUpgradeCheckout(BOOK);
    expect(fake.state.expireCalls).toEqual([s.id]);
    expect(old.status).toBe("expired");
    expect(fake.state.createCalls).toHaveLength(1);
    expect(res).not.toEqual({ url: s.url });
  });

  it("near-expiry expire failure is ignored", async () => {
    const s = storeSession({ expires_at: NOW_SEC + 60 });
    pendingOrder(s.id as string);
    fake.state.expireError = Object.assign(new Error("x"), { code: "session_expired" });
    const res = await startUpgradeCheckout(BOOK);
    expect("url" in res).toBe(true);
    expect(fake.state.createCalls).toHaveLength(1);
  });

  it("open session that is not ours (other user in metadata) is not reused", async () => {
    const s = storeSession({ metadata: { kind: "book_upgrade", book_id: BOOK, user_id: OTHER } });
    pendingOrder(s.id as string);
    const res = await startUpgradeCheckout(BOOK);
    expect(res).not.toEqual({ url: s.url });
    expect(fake.state.expireCalls).toEqual([s.id]);
  });

  it("complete stored session → success page url (payment may be processing)", async () => {
    const s = storeSession({ status: "complete", payment_status: "unpaid" });
    const order = pendingOrder(s.id as string);
    expect(await startUpgradeCheckout(BOOK)).toEqual({
      url: `${ORIGIN}/books/${BOOK}/upgrade/success?session_id=${s.id}`,
    });
    expect(order.status).toBe("pending");
    expect(fake.state.createCalls).toHaveLength(0);
  });

  it("stored session missing at Stripe (resource_missing) → expired, new session", async () => {
    const old = pendingOrder("cs_test_gone");
    const res = await startUpgradeCheckout(BOOK);
    expect(old.status).toBe("expired");
    expect("url" in res).toBe(true);
  });

  it("other retrieve errors → failed (no new session)", async () => {
    const s = storeSession();
    pendingOrder(s.id as string);
    fake.state.retrieveError = Object.assign(new Error("down"), { type: "StripeAPIError" });
    expect(await startUpgradeCheckout(BOOK)).toEqual({ error: "failed" });
    expect(fake.state.createCalls).toHaveLength(0);
  });

  it("pending_exists race: parallel request won → ours expired, theirs reused", async () => {
    const theirs = storeSession();
    fake.state.beforeInsert = () => {
      pendingOrder(theirs.id as string);
    };
    const res = await startUpgradeCheckout(BOOK);
    const ours = [...fake.state.sessions.values()].find((s) => s.id !== theirs.id)!;
    expect(fake.state.expireCalls).toEqual([ours.id]);
    expect(res).toEqual({ url: theirs.url });
    expect(fake.state.orders.filter((o) => o.status === "pending")).toHaveLength(1);
  });

  it("pending_exists from an idempotent replay of the same session → returns it, nothing expired", async () => {
    // First click created the session but its order insert landed after our create.
    fake.state.beforeInsert = () => {
      const created = [...fake.state.sessions.values()][0];
      pendingOrder(created.id as string);
    };
    const res = await startUpgradeCheckout(BOOK);
    const created = [...fake.state.sessions.values()][0];
    expect(res).toEqual({ url: created.url });
    expect(fake.state.expireCalls).toHaveLength(0);
  });
});

describe("getUpgradeStatus", () => {
  it("unauthenticated / non-UUID / non-owner", async () => {
    fake.state.user = null;
    expect(await getUpgradeStatus(BOOK)).toEqual({ error: "unauthenticated" });
    fake.state.user = { id: USER };
    expect(await getUpgradeStatus("nope")).toEqual({ error: "not_found" });
    fake.state.user = { id: OTHER };
    expect(await getUpgradeStatus(BOOK)).toEqual({ error: "not_found" });
  });

  it("no order → none; reflects live is_paid and the newest order status", async () => {
    expect(await getUpgradeStatus(BOOK)).toEqual({ isPaid: false, orderStatus: "none" });

    pendingOrder("cs_old", { status: "expired", created_at: "2026-11-10T10:00:00.000Z" });
    pendingOrder("cs_new", { status: "pending", created_at: "2026-11-10T11:00:00.000Z" });
    expect(await getUpgradeStatus(BOOK)).toEqual({ isPaid: false, orderStatus: "pending" });

    fake.state.orders[1].status = "paid";
    fake.state.books[0].is_paid = true;
    expect(await getUpgradeStatus(BOOK)).toEqual({ isPaid: true, orderStatus: "paid" });
  });

  it("does not see another user's orders and never writes", async () => {
    pendingOrder("cs_x", { user_id: OTHER, status: "paid" });
    const before = JSON.stringify(fake.state);
    expect(await getUpgradeStatus(BOOK)).toEqual({ isPaid: false, orderStatus: "none" });
    expect(JSON.stringify(fake.state)).toBe(before);
    expect(fake.state.retrieveCalls).toHaveLength(0);
  });

  it("DB error → failed", async () => {
    fake.state.dbError = { code: "08006" };
    expect(await getUpgradeStatus(BOOK)).toEqual({ error: "failed" });
  });
});
