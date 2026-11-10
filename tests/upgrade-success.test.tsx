import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpgradeStatusFlow, UpgradeStatusView } from "@/components/upgrade/UpgradeStatusPoller";
import {
  createUpgradePoller,
  phaseFromStatus,
  UPGRADE_POLL_INTERVAL_MS,
  UPGRADE_POLL_TIMEOUT_MS,
  type UpgradePollPhase,
} from "@/lib/upgrade/poller";
import type { UpgradeStatusResult } from "@/lib/upgrade/types";

const BOOK = "11111111-1111-4111-8111-111111111111";
const PENDING: UpgradeStatusResult = { isPaid: false, orderStatus: "pending" };
const PAID: UpgradeStatusResult = { isPaid: true, orderStatus: "paid" };

/** A check that answers from a script (last answer repeats). */
function scripted(answers: Array<UpgradeStatusResult | Error>) {
  let i = 0;
  return vi.fn(async (): Promise<UpgradeStatusResult> => {
    const a = answers[Math.min(i, answers.length - 1)];
    i += 1;
    if (a instanceof Error) throw a;
    return a;
  });
}

function setup(answers: Array<UpgradeStatusResult | Error>, hidden = false) {
  const check = scripted(answers);
  const phases: UpgradePollPhase[] = [];
  const poller = createUpgradePoller({ check, onPhase: (p) => phases.push(p), isHidden: () => hidden });
  return { check, phases, poller, last: () => phases[phases.length - 1] };
}

describe("upgrade poller (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a 2 s interval and a 60 s budget", () => {
    expect(UPGRADE_POLL_INTERVAL_MS).toBe(2000);
    expect(UPGRADE_POLL_TIMEOUT_MS).toBe(60000);
  });

  it("pending → paid: checks immediately, then every 2 s, stops after paid", async () => {
    const t = setup([PENDING, PENDING, PAID]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.check).toHaveBeenCalledTimes(1);
    expect(t.last()).toBe("processing");
    await vi.advanceTimersByTimeAsync(1999);
    expect(t.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.check).toHaveBeenCalledTimes(3);
    expect(t.last()).toBe("paid");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.check).toHaveBeenCalledTimes(3);
    expect(t.phases).toEqual(["polling", "processing", "paid"]);
  });

  it("stays 'polling' while there is no order yet, 'processing' once it is pending", async () => {
    const none: UpgradeStatusResult = { isPaid: false, orderStatus: "none" };
    const t = setup([none, { error: "failed" }, PENDING, { error: "failed" }, PAID]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.last()).toBe("polling");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.last()).toBe("polling");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.last()).toBe("processing");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.last()).toBe("processing"); // an error answer keeps the phase
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.phases).toEqual(["polling", "processing", "paid"]);
  });

  it("pending forever → timeout after 60 s (never paid)", async () => {
    const t = setup([PENDING]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(t.last()).toBe("processing");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.last()).toBe("timeout");
    expect(t.phases).not.toContain("paid");
    const calls = t.check.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(30);
    expect(calls).toBeLessThanOrEqual(31);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.check).toHaveBeenCalledTimes(calls);
  });

  it.each(["failed", "expired"] as const)("orderStatus %s → failed", async (orderStatus) => {
    const t = setup([PENDING, { isPaid: false, orderStatus }]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.phases).toEqual(["polling", "processing", "failed"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.check).toHaveBeenCalledTimes(2);
  });

  it.each(["refunded", "disputed", "needs_review"] as const)("orderStatus %s (not paid) → support, polling stops", async (orderStatus) => {
    const t = setup([PENDING, { isPaid: false, orderStatus }]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.phases).toEqual(["polling", "processing", "support"]);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(t.check).toHaveBeenCalledTimes(2);
    expect(t.phases).not.toContain("timeout");
  });

  it("isPaid wins over a failed latest order", () => {
    expect(phaseFromStatus({ isPaid: true, orderStatus: "failed" })).toBe("paid");
    expect(phaseFromStatus({ isPaid: false, orderStatus: "none" })).toBeNull();
    expect(phaseFromStatus({ isPaid: false, orderStatus: "pending" })).toBeNull();
    expect(phaseFromStatus({ isPaid: true, orderStatus: "refunded" })).toBe("paid");
    expect(phaseFromStatus({ isPaid: true, orderStatus: "needs_review" })).toBe("paid");
  });

  it("{error:'failed'} and thrown errors are retried", async () => {
    const t = setup([{ error: "failed" }, new Error("network"), { error: "failed" }, PAID]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(t.check).toHaveBeenCalledTimes(4);
    expect(t.phases).toEqual(["polling", "paid"]);
  });

  it("unauthenticated / not_found end polling", async () => {
    const a = setup([{ error: "unauthenticated" }]);
    a.poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.phases).toEqual(["polling", "unauthenticated"]);
    expect(a.check).toHaveBeenCalledTimes(1);
    const b = setup([PENDING, { error: "not_found" }]);
    b.poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.phases).toEqual(["polling", "processing", "not_found"]);
  });

  it("stop() (unmount) cancels the timer and ignores an in-flight answer", async () => {
    const t = setup([PENDING]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(4_000);
    const calls = t.check.mock.calls.length;
    t.poller.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.check).toHaveBeenCalledTimes(calls);
    expect(t.phases).toEqual(["polling", "processing"]);

    let resolve: (r: UpgradeStatusResult) => void = () => {};
    const slow = vi.fn(() => new Promise<UpgradeStatusResult>((r) => (resolve = r)));
    const phases: UpgradePollPhase[] = [];
    const p = createUpgradePoller({ check: slow, onPhase: (x) => phases.push(x) });
    p.start();
    p.stop();
    resolve(PAID);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(phases).toEqual(["polling"]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("pauses while hidden (budget clock stops) and checks right away on show", async () => {
    const t = setup([PENDING]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const before = t.check.mock.calls.length;
    t.poller.setHidden(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.check).toHaveBeenCalledTimes(before);
    expect(t.last()).toBe("processing");
    t.poller.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.check).toHaveBeenCalledTimes(before + 1);
    // ~50 s of visible budget left.
    await vi.advanceTimersByTimeAsync(48_000);
    expect(t.last()).toBe("processing");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.last()).toBe("timeout");
  });

  it("starting while hidden waits for the page to be shown", async () => {
    const t = setup([PAID], true);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.check).not.toHaveBeenCalled();
    t.poller.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.phases).toEqual(["polling", "paid"]);
  });

  it("never overlaps calls when a check is slower than the interval", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const check = vi.fn(async (): Promise<UpgradeStatusResult> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5_000));
      inFlight -= 1;
      return PENDING;
    });
    const p = createUpgradePoller({ check, onPhase: () => {} });
    p.start();
    p.setHidden(true);
    p.setHidden(false); // show while in flight must not start a second call
    await vi.advanceTimersByTimeAsync(30_000);
    expect(maxInFlight).toBe(1);
    p.stop();
  });
});

describe("upgrade status view", () => {
  const view = (phase: UpgradePollPhase, liveSlug: string | null = null) =>
    renderToStaticMarkup(<UpgradeStatusView bookId={BOOK} phase={phase} liveSlug={liveSlug} onRetry={() => {}} />);

  it("polling shows the spinner copy and no success", () => {
    const html = view("polling");
    expect(html).toContain("Confirming payment…");
    expect(html).toContain('data-testid="upgrade-polling"');
    expect(html).not.toContain("upgraded");
  });

  it("processing (pending order) says the payment is processing, still busy, no success", () => {
    const html = view("processing");
    expect(html).toContain("Your payment is processing…");
    expect(html).not.toContain("Confirming payment…");
    expect(html).toContain('data-testid="upgrade-polling"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("upgraded");
  });

  it("support stops with a contact-support message and the book reference", () => {
    const html = view("support");
    expect(html).toContain('data-testid="upgrade-support"');
    expect(html).toContain("Something went wrong with this payment. We&#x27;ll sort it out — contact support and mention this book.");
    expect(html).toContain(BOOK);
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain("upgraded");
    expect(html).not.toContain("@"); // no hardcoded support address
  });

  it("paid lists benefits and links (live link only when published)", () => {
    const html = view("paid");
    expect(html).toContain("Your book is upgraded");
    expect(html).toContain("No watermark");
    expect(html).toContain("Permanent link");
    expect(html).toContain("Up to 100 pages");
    expect(html).toContain(`href="/books/${BOOK}/edit"`);
    expect(html).toContain(`href="/books/${BOOK}/publish"`);
    expect(html).not.toContain("upgrade-open-live");
    const live = view("paid", "sara-7Hq2");
    expect(live).toContain('href="/b/sara-7Hq2"');
    expect(live).toContain("Open live link");
  });

  it("failed links back to the publish screen", () => {
    const html = view("failed");
    expect(html).toContain("Payment didn&#x27;t go through");
    expect(html).toContain(`href="/books/${BOOK}/publish"`);
    expect(html).not.toContain("upgraded");
  });

  it("timeout never claims success and offers Refresh", () => {
    const html = view("timeout");
    expect(html).toContain(
      "We haven&#x27;t had confirmation from Stripe yet. If you completed payment, this page will update shortly — you won&#x27;t be charged twice.",
    );
    expect(html).not.toMatch(/payment received/i);
    expect(html).toContain('data-testid="upgrade-refresh"');
    expect(html).not.toContain("upgraded");
  });

  it("signed out links to login with next = this page", () => {
    const html = view("unauthenticated");
    expect(html).toContain(`href="/login?next=${encodeURIComponent(`/books/${BOOK}/upgrade/success`)}"`);
  });

  it("flow renders paid immediately when the book is already paid, polling otherwise", () => {
    const check = vi.fn(async () => PAID);
    const paid = renderToStaticMarkup(
      <UpgradeStatusFlow bookId={BOOK} initialPaid liveSlug={null} check={check} refresh={() => {}} />,
    );
    expect(paid).toContain('data-testid="upgrade-paid"');
    const pending = renderToStaticMarkup(
      <UpgradeStatusFlow bookId={BOOK} initialPaid={false} liveSlug={null} check={check} refresh={() => {}} />,
    );
    expect(pending).toContain('data-testid="upgrade-polling"');
    expect(check).not.toHaveBeenCalled();
  });
});

describe("upgrade success page source", () => {
  const src = readFileSync("src/app/books/[id]/upgrade/success/page.tsx", "utf8");

  it("is noindex, titled Upgrade, and never reads session_id", () => {
    expect(src).toMatch(/title: "Upgrade"/);
    expect(src).toMatch(/robots: \{ index: false/);
    expect(src).not.toMatch(/searchParams/);
  });

  it("redirects signed-out users to login and 404s non-owners", () => {
    expect(src).toMatch(/redirect\(loginNext\)/);
    expect(src).toMatch(/notFound\(\)/);
  });

  it("dev fixture covers every view phase", () => {
    const fixture = readFileSync("src/app/dev-upgrade/fixture.ts", "utf8");
    for (const state of ["processing", "support"]) expect(fixture).toContain(`"${state}"`);
  });

  it("dev fixture route 404s in production", () => {
    expect(readFileSync("src/app/dev-upgrade/page.tsx", "utf8")).toMatch(/NODE_ENV === "production"\) notFound\(\)/);
  });
});
