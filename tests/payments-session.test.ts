import { describe, expect, it } from "vitest";
import {
  buildCheckoutParams,
  CHECKOUT_SESSION_TTL_SEC,
  isPendingUpgradeSession,
  safeReturnPath,
  validatePaidSession,
  validateUpgradeSession,
  type CheckoutSessionLike,
} from "@/lib/payments/session";
import { UPGRADE } from "@/lib/pricing";
import { APP_NAME } from "@/lib/brand";

const BOOK = "11111111-2222-4333-8444-555555555555";
const OTHER_BOOK = "99999999-2222-4333-8444-555555555555";
const USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = 1_800_000_000;

function input(over: Partial<Parameters<typeof buildCheckoutParams>[0]> = {}) {
  return {
    bookId: BOOK,
    userId: USER,
    email: "me@example.com",
    bookTitle: "Eid with Teta",
    origin: "https://photobook.example",
    returnTo: `/books/${BOOK}/edit`,
    nowSec: NOW,
    ...over,
  };
}

function session(over: Partial<CheckoutSessionLike> = {}): CheckoutSessionLike {
  return {
    id: "cs_test_123",
    mode: "payment",
    payment_status: "paid",
    currency: "aed",
    amount_total: 3900,
    metadata: { kind: "book_upgrade", book_id: BOOK, user_id: USER },
    client_reference_id: BOOK,
    payment_intent: "pi_test_123",
    livemode: false,
    ...over,
  };
}

describe("pricing", () => {
  it("is AED 39 in fils with a generic product name", () => {
    expect(UPGRADE).toEqual({ amount: 3900, currency: "aed", label: "AED 39", productName: `${APP_NAME} book upgrade` });
  });
});

describe("buildCheckoutParams", () => {
  it("builds the exact payment session shape", () => {
    const meta = { kind: "book_upgrade", book_id: BOOK, user_id: USER };
    expect(buildCheckoutParams(input())).toEqual({
      mode: "payment",
      adaptive_pricing: { enabled: false },
      line_items: [
        {
          quantity: 1,
          price_data: { currency: "aed", unit_amount: 3900, product_data: { name: `${APP_NAME} book upgrade` } },
        },
      ],
      customer_email: "me@example.com",
      client_reference_id: BOOK,
      metadata: meta,
      payment_intent_data: { metadata: meta },
      expires_at: NOW + CHECKOUT_SESSION_TTL_SEC,
      success_url: `https://photobook.example/books/${BOOK}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://photobook.example/books/${BOOK}/edit?upgrade=cancelled`,
    });
  });

  it("expires at least 30 minutes out (Stripe minimum)", () => {
    expect(CHECKOUT_SESSION_TTL_SEC).toBeGreaterThanOrEqual(30 * 60);
    expect(CHECKOUT_SESSION_TTL_SEC).toBeLessThan(24 * 3600);
  });

  it("never sends the book title or payment_method_types", () => {
    const json = JSON.stringify(buildCheckoutParams(input()));
    expect(json).not.toContain("Eid with Teta");
    expect(json).not.toContain("payment_method_types");
  });

  it("omits customer_email when empty and normalizes the origin", () => {
    const p = buildCheckoutParams(input({ email: "  ", origin: "https://photobook.example/some/path" }));
    expect(p).not.toHaveProperty("customer_email");
    expect(p.success_url!.startsWith(`https://photobook.example/books/${BOOK}/`)).toBe(true);
  });

  it("disables Adaptive Pricing (always charged in AED)", () => {
    expect(buildCheckoutParams(input()).adaptive_pricing).toEqual({ enabled: false });
  });

  it("accepts /b/{slug} as cancel path only for the book's own slug", () => {
    const slug = "eid-with-teta-AbCdEfGhJk";
    expect(buildCheckoutParams(input({ returnTo: `/b/${slug}`, bookSlug: slug })).cancel_url).toBe(
      `https://photobook.example/b/${slug}?upgrade=cancelled`,
    );
    expect(buildCheckoutParams(input({ returnTo: "/b/someone-else-AbCdEfGhJk", bookSlug: slug })).cancel_url).toBe(
      `https://photobook.example/books/${BOOK}/publish?upgrade=cancelled`,
    );
    expect(buildCheckoutParams(input({ returnTo: `/b/${slug}` })).cancel_url).toBe(
      `https://photobook.example/books/${BOOK}/publish?upgrade=cancelled`,
    );
  });

  it("defaults cancel_url to publish", () => {
    expect(buildCheckoutParams(input({ returnTo: undefined })).cancel_url).toBe(
      `https://photobook.example/books/${BOOK}/publish?upgrade=cancelled`,
    );
  });

  it("throws on bad ids, origin or time", () => {
    expect(() => buildCheckoutParams(input({ bookId: "nope" }))).toThrow();
    expect(() => buildCheckoutParams(input({ userId: "nope" }))).toThrow();
    expect(() => buildCheckoutParams(input({ origin: "javascript:alert(1)" }))).toThrow();
    expect(() => buildCheckoutParams(input({ origin: "not a url" }))).toThrow();
    expect(() => buildCheckoutParams(input({ nowSec: 0 }))).toThrow();
  });
});

describe("safeReturnPath", () => {
  const fallback = `/books/${BOOK}/publish`;

  it.each([`/books/${BOOK}/publish`, `/books/${BOOK}/edit`])("allows %s", (p) =>
    expect(safeReturnPath(p, BOOK)).toBe(p),
  );

  it.each(["eid-with-teta-AbCdEfGhJk", "AbCdEfGhJk"])("allows /b/%s only when it is the book's own slug", (slug) => {
    expect(safeReturnPath(`/b/${slug}`, BOOK, slug)).toBe(`/b/${slug}`);
    expect(safeReturnPath(`/b/${slug}`, BOOK)).toBe(fallback);
    expect(safeReturnPath(`/b/${slug}`, BOOK, null)).toBe(fallback);
    expect(safeReturnPath(`/b/${slug}`, BOOK, "other-slug-ZyXwVuTsRq")).toBe(fallback);
  });

  it("does not accept a case-variant of the slug or an invalid stored slug", () => {
    expect(safeReturnPath("/b/abcdefghjk", BOOK, "AbCdEfGhJk")).toBe(fallback);
    expect(safeReturnPath("/b/not_valid!", BOOK, "not_valid!")).toBe(fallback);
  });

  it("compares the book id case-insensitively and returns the lower-cased path", () => {
    const upper = BOOK.toUpperCase();
    expect(safeReturnPath(`/books/${upper}/edit`, BOOK)).toBe(`/books/${BOOK}/edit`);
    expect(safeReturnPath(`/books/${BOOK}/publish`, upper)).toBe(`/books/${BOOK}/publish`);
    expect(safeReturnPath("https://evil.example", upper)).toBe(fallback);
  });

  it.each([
    undefined,
    null,
    "",
    "https://evil.example/books",
    "//evil.example",
    "//evil.example/books/x/publish",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    `/books/${OTHER_BOOK}/publish`,
    `/books/${BOOK}/publish?x=1`,
    `/books/${BOOK}/publish#frag`,
    `/books/${BOOK}/settings`,
    `/books/${BOOK}/edit/../../admin`,
    "/b/%2F%2Fevil",
    "/b/not_valid!",
    "/b/eid-with-teta-AbCdEfGhJk/extra",
    "/admin/runs",
    "books/x/publish",
  ])("rejects %s", (p) => expect(safeReturnPath(p, BOOK)).toBe(fallback));
});

describe("validatePaidSession", () => {
  it("accepts a good paid session", () => {
    expect(validatePaidSession(session())).toEqual({
      ok: true,
      bookId: BOOK,
      userId: USER,
      sessionId: "cs_test_123",
      paymentIntentId: "pi_test_123",
      amount: 3900,
      currency: "aed",
      livemode: false,
      paymentStatus: "paid",
    });
  });

  it("reads an expanded payment_intent id and tolerates a null one", () => {
    const expanded = session({ payment_intent: { id: "pi_exp" } as unknown as CheckoutSessionLike["payment_intent"] });
    expect(validatePaidSession(expanded)).toMatchObject({ ok: true, paymentIntentId: "pi_exp" });
    expect(validatePaidSession(session({ payment_intent: null }))).toMatchObject({ ok: true, paymentIntentId: null });
  });

  it.each<[string, Partial<CheckoutSessionLike>, string]>([
    ["subscription mode", { mode: "subscription" }, "not_payment_mode"],
    ["unpaid", { payment_status: "unpaid" }, "not_paid"],
    ["no payment required", { payment_status: "no_payment_required" }, "not_paid"],
    ["usd", { currency: "usd" }, "wrong_currency"],
    ["null currency", { currency: null }, "wrong_currency"],
    ["discounted", { amount_total: 100 }, "wrong_amount"],
    ["overcharged", { amount_total: 39000 }, "wrong_amount"],
    ["null amount", { amount_total: null }, "wrong_amount"],
    ["no metadata", { metadata: null }, "wrong_kind"],
    ["wrong kind", { metadata: { kind: "other", book_id: BOOK, user_id: USER } }, "wrong_kind"],
    ["non-uuid book", { metadata: { kind: "book_upgrade", book_id: "1", user_id: USER } }, "invalid_book_id"],
    ["non-uuid user", { metadata: { kind: "book_upgrade", book_id: BOOK, user_id: "x" } }, "invalid_user_id"],
    ["reference mismatch", { client_reference_id: OTHER_BOOK }, "reference_mismatch"],
    ["missing reference", { client_reference_id: null }, "reference_mismatch"],
  ])("rejects %s", (_name, over, reason) => {
    expect(validatePaidSession(session(over))).toEqual({ ok: false, reason });
  });
});

describe("Adaptive Pricing (currency_conversion)", () => {
  const converted = (cc: Partial<NonNullable<CheckoutSessionLike["currency_conversion"]>> | null, over: Partial<CheckoutSessionLike> = {}) =>
    session({
      currency: "usd",
      amount_total: 1062,
      currency_conversion:
        cc === null
          ? null
          : ({ amount_subtotal: 3900, amount_total: 3900, fx_rate: "0.2723", source_currency: "aed", ...cc } as NonNullable<
              CheckoutSessionLike["currency_conversion"]
            >),
      ...over,
    });

  it("accepts a session presented in another currency when the AED source is 3900 (records AED 3900)", () => {
    expect(validatePaidSession(converted({}))).toMatchObject({ ok: true, amount: 3900, currency: "aed" });
    expect(validatePaidSession(converted({ source_currency: "AED" }))).toMatchObject({ ok: true });
  });

  it.each<[string, Partial<NonNullable<CheckoutSessionLike["currency_conversion"]>> | null, string]>([
    ["no conversion info", null, "wrong_currency"],
    ["source not AED", { source_currency: "usd" }, "wrong_currency"],
    ["source amount discounted", { amount_total: 100 }, "wrong_amount"],
    ["source amount over", { amount_total: 39000 }, "wrong_amount"],
  ])("rejects a converted session with %s", (_name, cc, reason) => {
    expect(validatePaidSession(converted(cc))).toEqual({ ok: false, reason });
  });

  it("an AED session still needs amount_total 3900 even if currency_conversion is present", () => {
    expect(validatePaidSession(converted({}, { currency: "aed", amount_total: 100 }))).toEqual({ ok: false, reason: "wrong_amount" });
  });

  it("missing currency_conversion field (undefined) on a non-AED session is wrong_currency", () => {
    expect(validatePaidSession(session({ currency: "eur" }))).toEqual({ ok: false, reason: "wrong_currency" });
  });
});

describe("pending detection", () => {
  it("validateUpgradeSession accepts unpaid with paymentStatus", () => {
    expect(validateUpgradeSession(session({ payment_status: "unpaid" }))).toMatchObject({
      ok: true,
      paymentStatus: "unpaid",
    });
  });

  it("isPendingUpgradeSession only for a valid unpaid upgrade", () => {
    expect(isPendingUpgradeSession(session({ payment_status: "unpaid" }))).toBe(true);
    expect(isPendingUpgradeSession(session())).toBe(false);
    expect(isPendingUpgradeSession(session({ payment_status: "unpaid", currency: "usd" }))).toBe(false);
  });
});
