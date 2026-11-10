// M7 T6: <UpgradeButton> + its pure logic (src/lib/upgrade/ui.ts). No DOM environment here, so
// the click path is tested through runUpgradeCheckout (what onClick calls) and the markup through
// renderToStaticMarkup.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ start: vi.fn(), refresh: vi.fn(), replace: vi.fn(), search: "" }));

vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: h.start }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh, replace: h.replace }),
  usePathname: () => "/books/b1/publish",
  useSearchParams: () => new URLSearchParams(h.search),
}));

import { UpgradeButton, UpgradeButtonView } from "@/components/upgrade/UpgradeButton";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import { START_UPGRADE_ERROR_CODES, type StartUpgradeCheckoutResult } from "@/lib/upgrade/types";
import {
  PAYMENTS_UNAVAILABLE_HINT,
  runUpgradeCheckout,
  stripUpgradeCancelled,
  UPGRADE_BUTTON_LABEL,
  UPGRADE_CANCELLED_COPY,
  upgradeErrorCopy,
} from "@/lib/upgrade/ui";

const BOOK = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  h.search = "";
});

function run(result: StartUpgradeCheckoutResult | Error) {
  const navigate = vi.fn();
  const refresh = vi.fn();
  const start = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { navigate, refresh, start, outcome: runUpgradeCheckout({ start, navigate, refresh }) };
}

describe("runUpgradeCheckout", () => {
  it("{url} → navigate(url) (location.assign in the component), no refresh, no message", async () => {
    const url = "https://checkout.stripe.com/c/pay/cs_test_123";
    const r = run({ url });
    expect(await r.outcome).toEqual({ kind: "navigating", url });
    expect(r.navigate).toHaveBeenCalledWith(url);
    expect(r.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["already_paid", "This book is already upgraded"],
    ["unavailable", "Payments aren't available right now"],
    ["unauthenticated", "Please sign in again"],
    [
      "needs_review",
      "Something went wrong with an earlier payment for this book. We'll sort it out — contact support and mention this book.",
    ],
    ["not_found", "Couldn't start payment — try again"],
    ["failed", "Couldn't start payment — try again"],
  ] as const)("%s → %s", async (code, text) => {
    const r = run({ error: code });
    expect(await r.outcome).toEqual({ kind: "error", code, text });
    expect(r.navigate).not.toHaveBeenCalled();
    expect(r.refresh).toHaveBeenCalledTimes(code === "already_paid" ? 1 : 0);
  });

  it("a thrown action (network) → failed copy", async () => {
    const r = run(new Error("network"));
    expect(await r.outcome).toEqual({ kind: "error", code: "failed", text: upgradeErrorCopy("failed") });
    expect(r.navigate).not.toHaveBeenCalled();
  });

  it("an empty url is treated as failed", async () => {
    const r = run({ url: "" });
    expect((await r.outcome).kind).toBe("error");
    expect(r.navigate).not.toHaveBeenCalled();
  });

  it("every error code has copy; none says coming soon", () => {
    for (const c of START_UPGRADE_ERROR_CODES) {
      expect(upgradeErrorCopy(c).length).toBeGreaterThan(0);
      expect(upgradeErrorCopy(c)).not.toMatch(/coming soon/i);
    }
  });
});

describe("<UpgradeButton>", () => {
  const view = (p: Partial<Parameters<typeof UpgradeButtonView>[0]> = {}) =>
    renderToStaticMarkup(
      <UpgradeButtonView bookId={BOOK} returnTo={`/books/${BOOK}/publish`} isPaid={false} paymentsEnabled refresh={() => {}} {...p} />,
    );

  it("label is 'Upgrade this book — AED 39' by default", () => {
    expect(UPGRADE_BUTTON_LABEL).toBe("Upgrade this book — AED 39");
    expect(view()).toContain(UPGRADE_BUTTON_LABEL);
    expect(view({ label: "Upgrade to bring it back" })).toContain("Upgrade to bring it back");
  });

  it("payments on: enabled button, no hint, ≥ 44 px tall (min-h-11)", () => {
    const html = view();
    expect(html).toMatch(/<button type="button" class="[^"]*min-h-11[^"]*" data-testid="upgrade-button"/);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain(PAYMENTS_UNAVAILABLE_HINT);
    expect(html).toContain('data-payments="on"');
  });

  it("payments off: disabled + 'Payments unavailable' hint linked by aria-describedby", () => {
    const html = view({ paymentsEnabled: false, testId: "publish-upgrade" });
    expect(html).toMatch(/<button type="button" disabled=""[^>]*aria-describedby="publish-upgrade-unavailable"[^>]*data-testid="publish-upgrade"/);
    expect(html).toContain('id="publish-upgrade-unavailable"');
    expect(html).toContain(PAYMENTS_UNAVAILABLE_HINT);
    expect(html).not.toMatch(/coming soon/i);
    expect(html).toContain('data-payments="off"');
  });

  it("hidden when the book is paid", () => {
    expect(view({ isPaid: true })).toBe("");
    expect(renderToStaticMarkup(<UpgradeButton bookId={BOOK} returnTo="/x" isPaid paymentsEnabled />)).toBe("");
  });

  it("the router-wired wrapper renders the same button", () => {
    const html = renderToStaticMarkup(<UpgradeButton bookId={BOOK} returnTo={`/books/${BOOK}/edit`} isPaid={false} paymentsEnabled />);
    expect(html).toContain('data-testid="upgrade-button"');
  });

  it("client code imports types only from @/lib/upgrade (no payments / stripe libs)", () => {
    for (const f of ["src/components/upgrade/UpgradeButton.tsx", "src/components/upgrade/UpgradeCancelledNotice.tsx", "src/lib/upgrade/ui.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/@\/lib\/(payments|stripe)\b|from\s+["']stripe["']/);
    }
  });
});

describe("Payment cancelled notice", () => {
  it("stripUpgradeCancelled keeps other params", () => {
    expect(stripUpgradeCancelled("/books/b1/publish", "upgrade=cancelled")).toBe("/books/b1/publish");
    expect(stripUpgradeCancelled("/dev-publish", "state=draft&upgrade=cancelled")).toBe("/dev-publish?state=draft");
    expect(stripUpgradeCancelled("/b/x", "")).toBe("/b/x");
  });

  it("renders only with ?upgrade=cancelled", () => {
    expect(renderToStaticMarkup(<UpgradeCancelledNotice />)).toBe("");
    h.search = "upgrade=other";
    expect(renderToStaticMarkup(<UpgradeCancelledNotice />)).toBe("");
    h.search = "upgrade=cancelled";
    const html = renderToStaticMarkup(<UpgradeCancelledNotice />);
    expect(html).toContain('data-testid="upgrade-cancelled"');
    expect(html).toContain(UPGRADE_CANCELLED_COPY.replace("'", "&#x27;"));
    expect(html).toContain('data-testid="upgrade-cancelled-dismiss"');
    expect(html).toContain("size-11"); // 44 px dismiss target
  });

  it("floating variant is fixed (editor)", () => {
    h.search = "upgrade=cancelled";
    expect(renderToStaticMarkup(<UpgradeCancelledNotice floating />)).toContain("fixed");
  });
});
