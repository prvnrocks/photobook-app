// @vitest-environment jsdom
// M21 T4 / T5: share page secondary cards + phone sticky bar.
// - PlanCard: free compare + gold Upgrade (testids kept, #upgrade) vs the paid thank-you; only
//   state.isPaid decides.
// - PdfCard: paid → the download (publish-pdf, #pdf); free → locked card linking to #upgrade that
//   renders no download control and never calls the PDF API (transport + fetch spies).
// - Sticky bar per state: Publish / Update link / Send on WhatsApp; none when expired / blocked;
//   hidden until its card button leaves the screen (IntersectionObserver); taps run the same action.
// - DangerZone keeps the confirm step + testids.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
vi.mock("@/lib/analytics/client", () => ({ track: vi.fn(), trackEvent: vi.fn() }));

const { SharePanel } = await import("./helpers/share-panel");
const { PlanCard } = await import("@/components/publish/PlanCard");
const { PdfCard } = await import("@/components/publish/PdfCard");
const { DangerZone } = await import("@/components/publish/DangerZone");
const { shareBarAction, shareBarRootMargin } = await import("@/components/publish/PublishPanel");
const { publishCompare } = await import("@/lib/publish/compare");
const { devPublishState, DEV_PUBLISH_URL } = await import("@/lib/publish/dev-fixture");
type PublishState = import("@/app/books/[id]/publish/actions").PublishState;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-11-10T10:00:00.000Z");
const BOOK = "11111111-1111-4111-8111-111111111111";
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
const tag = (html: string, id: string) => html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";

function actions(publish = vi.fn(async () => ({ ok: true as const, slug: "s", url: DEV_PUBLISH_URL, expiresAt: null }))) {
  return { publish, unpublish: vi.fn(async () => ({ ok: true as const })), setPassword: vi.fn(async () => ({ ok: true as const, hasPassword: true })) };
}

function html(state: PublishState, extra: { paymentsEnabled?: boolean } = {}) {
  return renderToStaticMarkup(
    <SharePanel
      bookId={BOOK}
      title="Sara & Omar"
      state={state}
      actions={actions()}
      paymentsEnabled={extra.paymentsEnabled ?? true}
      compare={publishCompare()}
      refresh={() => {}}
      now={NOW}
    />,
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}
const q = (id: string) => host!.querySelector<HTMLElement>(`[data-testid="${id}"]`);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe("PlanCard", () => {
  it("free: compare (testids kept, #upgrade), Paid column with price, the gold Upgrade (live: Upgrade is the primary)", () => {
    const out = html(devPublishState("live"));
    const card = tag(out, "publish-free-notice");
    expect(card).toContain('id="upgrade"');
    expect(has(out, "publish-compare")).toBe(true);
    expect(out).toContain(`data-testid="publish-compare-summary">${publishCompare().summary}.`);
    expect(out).toContain(`data-testid="publish-compare-price">${publishCompare().price} · one-time<`);
    for (const r of publishCompare().rows) expect(out).toContain(`data-row="${r.key}"`);
    const upgrade = tag(out, "publish-upgrade");
    expect(upgrade).toContain("home-foil-fill");
    expect(upgrade).toMatch(/\bmin-h-12\b/);
    expect(upgrade).toContain("focus-visible:ring-2");
    expect(has(out, "publish-plan-paid")).toBe(false);
  });

  it.each(["draft", "unpublished", "changes"] as const)(
    "%s: Publish / Update link is the gold primary, so the plan card's Upgrade is the emerald secondary",
    (name) => {
      const out = html(devPublishState(name));
      const upgrade = tag(out, "publish-upgrade");
      expect(upgrade).not.toContain("home-foil-fill");
      expect(upgrade).toContain("border-[#0e3b2e]/30");
      expect(upgrade).toMatch(/\bmin-h-12\b/);
      expect(upgrade).toContain("focus-visible:ring-2");
      expect(tag(out, "publish-free-notice")).toContain('id="upgrade"');
      // One gold control in the cards (the sticky bar repeats the same action, hidden until needed).
      const gold = (out.match(/<(button|a)[^>]*home-foil-fill[^>]*>/g) ?? []).filter((t) => !t.includes("publish-bar-button"));
      expect(gold).toHaveLength(1);
    },
  );

  it("blocked draft (over the free page limit) / expiring free link: Upgrade stays gold", () => {
    for (const state of [{ ...devPublishState("draft"), canPublishReason: "page_limit" as const, pageCount: 24 }, devPublishState("expiring", NOW)]) {
      expect(tag(html(state), "publish-upgrade")).toContain("home-foil-fill");
    }
  });

  it("paid: 'Paid · permanent' thank-you with the paid rows; no compare, no upgrade", () => {
    for (const name of ["live-paid", "draft-paid", "paid"] as const) {
      const out = html(devPublishState(name));
      expect(has(out, "publish-plan-paid")).toBe(true);
      expect(out).toContain("Paid · permanent");
      expect(has(out, "publish-free-notice")).toBe(false);
      expect(has(out, "publish-upgrade")).toBe(false);
    }
  });

  it("only isPaid decides (a paid book with an expiry date or a free book without one)", () => {
    const paidWithExpiry = renderToStaticMarkup(<PlanCard compare={publishCompare()} isPaid upgrade={<button data-testid="x" />} />);
    expect(has(paidWithExpiry, "publish-plan-paid")).toBe(true);
    expect(has(paidWithExpiry, "x")).toBe(false);
    const free = renderToStaticMarkup(<PlanCard compare={publishCompare()} isPaid={false} upgrade={<button data-testid="x" />} />);
    expect(has(free, "publish-free-notice")).toBe(true);
    expect(has(free, "x")).toBe(true);
    // Through the panel: same live state, only isPaid flipped.
    expect(has(html({ ...devPublishState("live"), isPaid: true }), "publish-plan-paid")).toBe(true);
    expect(has(html({ ...devPublishState("live-paid"), isPaid: false }), "publish-free-notice")).toBe(true);
  });

  it("expired free: no plan card (the expired card carries the one upgrade)", () => {
    const out = html(devPublishState("expired"));
    expect(has(out, "publish-free-notice")).toBe(false);
    expect(out.match(/data-testid="publish-upgrade"/g)?.length).toBe(1);
    expect(tag(out, "publish-expired")).toContain('id="upgrade"');
  });
});

describe("PdfCard", () => {
  it("free: locked card (#pdf) → 'Upgrade for PDF' links to #upgrade; no download control", () => {
    for (const name of ["draft", "live", "expired", "changes"] as const) {
      const out = html(devPublishState(name));
      expect(tag(out, "publish-pdf-locked")).toContain('id="pdf"');
      expect(out).toMatch(/<a href="#upgrade"[^>]*data-testid="publish-pdf-upgrade-link">Upgrade for PDF<\/a>/);
      for (const id of ["publish-pdf", "pdf-download", "pdf-download-wrap", "pdf-status", "pdf-upgrade"]) expect(has(out, id)).toBe(false);
    }
  });

  it("free locked card never calls the PDF API (mounted with transport + fetch spies)", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const transport = vi.fn(async () => ({ status: 200, body: {} }));
    mount(
      <SharePanel
        bookId={BOOK}
        title="Sara"
        state={devPublishState("live")}
        actions={actions()}
        paymentsEnabled
        compare={publishCompare()}
        refresh={() => {}}
        now={NOW}
        pdfTransport={transport as never}
      />,
    );
    await act(async () => {
      q("publish-pdf-upgrade-link")!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q("publish-pdf-locked")).not.toBeNull();
    expect(transport).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("paid: publish-pdf (#pdf) with the share-look Download PDF (44 px emerald pill)", () => {
    const out = html(devPublishState("live-paid"));
    expect(tag(out, "publish-pdf")).toContain('id="pdf"');
    const btn = tag(out, "pdf-download");
    expect(btn).toContain("bg-[#0e3b2e]");
    expect(btn).toMatch(/\bmin-h-11\b/);
    expect(has(out, "publish-pdf-locked")).toBe(false);
  });

  it("PdfCard alone: isPaid without a download renders no control", () => {
    const out = renderToStaticMarkup(<PdfCard isPaid />);
    expect(has(out, "publish-pdf")).toBe(true);
    expect(has(out, "pdf-download")).toBe(false);
  });
});

describe("phone sticky bar", () => {
  it("shareBarAction per card variant", () => {
    expect(shareBarAction("draft", false, false)).toBe("publish");
    expect(shareBarAction("draft", true, false)).toBeNull();
    expect(shareBarAction("changes", false, true)).toBe("update");
    expect(shareBarAction("changes", true, true)).toBeNull();
    expect(shareBarAction("live", false, true)).toBe("whatsapp");
    expect(shareBarAction("live", false, false)).toBeNull();
    expect(shareBarAction("expired", false, true)).toBeNull();
    expect(shareBarAction("pending", false, false)).toBeNull();
  });

  it.each([
    ["draft", "publish", "publish-bar-button", "Publish"],
    ["unpublished", "publish", "publish-bar-button", "Publish"],
    ["changes", "update", "publish-bar-button", "Update link"],
    ["live", "whatsapp", "publish-bar-whatsapp", "Send on WhatsApp"],
    ["expiring", "whatsapp", "publish-bar-whatsapp", "Send on WhatsApp"],
    ["paid", "whatsapp", "publish-bar-whatsapp", "Send on WhatsApp"],
  ] as const)("%s → %s (%s), phone-only, hidden on first render, safe-area padded", (name, action, id, label) => {
    const out = html(devPublishState(name));
    const bar = tag(out, "publish-sticky-bar");
    expect(bar).toContain(`data-action="${action}"`);
    expect(bar).toContain('data-visible="false"');
    expect(bar).toContain("lg:hidden");
    expect(bar).toContain("fixed");
    expect(bar).toContain("env(safe-area-inset-bottom)");
    expect(out).toMatch(new RegExp(`data-testid="${id}"[^>]*>(<svg[\\s\\S]*?</svg>)?${label}<`));
    expect(has(out, "publish-bar-spacer")).toBe(true);
    // The card buttons keep their own testids (one each).
    for (const cardId of ["publish-button", "publish-changes-button", "share-whatsapp"]) {
      expect((out.match(new RegExp(`data-testid="${cardId}"`, "g")) ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it("live: the bar's WhatsApp link is the same wa.me link as the card", () => {
    const out = html(devPublishState("live"));
    const href = (id: string) => tag(out, id).match(/href="([^"]+)"/)?.[1];
    expect(href("publish-bar-whatsapp")).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(href("publish-bar-whatsapp")).toBe(href("share-whatsapp"));
  });

  it.each(["expired", "empty", "page_limit", "invalid_doc", "blocked"] as const)("%s: no bar, no spacer", (name) => {
    const out = html(devPublishState(name));
    expect(has(out, "publish-sticky-bar")).toBe(false);
    expect(has(out, "publish-bar-spacer")).toBe(false);
  });

  it("shows only while the card button is not visible above the bar; tapping Publish runs the same publish action", async () => {
    let cb: IntersectionObserverCallback = () => {};
    const observed: Element[] = [];
    const margins: (string | undefined)[] = [];
    class IO {
      constructor(c: IntersectionObserverCallback, o?: IntersectionObserverInit) {
        cb = c;
        margins.push(o?.rootMargin);
      }
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", IO);
    const publish = vi.fn(async () => ({ ok: true as const, slug: "s", url: DEV_PUBLISH_URL, expiresAt: null }));
    mount(
      <SharePanel
        bookId={BOOK}
        title="Sara"
        state={devPublishState("draft")}
        actions={actions(publish)}
        paymentsEnabled
        compare={publishCompare()}
        refresh={() => {}}
        now={NOW}
      />,
    );
    expect(observed[0]?.getAttribute("data-testid")).toBe("publish-button");
    expect(q("publish-sticky-bar")!.getAttribute("data-visible")).toBe("false");
    act(() => cb([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(q("publish-sticky-bar")!.getAttribute("data-visible")).toBe("true");
    act(() => cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(q("publish-sticky-bar")!.getAttribute("data-visible")).toBe("false");
    // jsdom has no layout: bar height 0 → the whole viewport counts.
    expect(margins.at(-1)).toBe("0px 0px -0px 0px");
    act(() => cb([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    await act(async () => q("publish-bar-button")!.click());
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["live", "share-whatsapp"],
    ["changes", "publish-changes-button"],
  ] as const)("%s: the observed region ends at the bar's real top edge (measured offsetHeight, not a fixed 96 px)", (name, target) => {
    const margins: (string | undefined)[] = [];
    const observed: Element[] = [];
    const cbs: IntersectionObserverCallback[] = [];
    class IO {
      constructor(c: IntersectionObserverCallback, o?: IntersectionObserverInit) {
        cbs.push(c);
        margins.push(o?.rootMargin);
      }
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", IO);
    // The bar is 73 px tall (12 + 48 + 12 + 1 px border) on a phone.
    const spy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-share-bar") ? 72.5 : 0;
    });
    try {
      mount(
        <SharePanel bookId={BOOK} title="Sara" state={devPublishState(name)} actions={actions()} paymentsEnabled compare={publishCompare()} refresh={() => {}} now={NOW} />,
      );
      expect(margins.at(-1)).toBe("0px 0px -73px 0px");
      expect(observed.at(-1)?.getAttribute("data-testid")).toBe(target);
      const bar = q("publish-sticky-bar")!;
      const fire = (isIntersecting: boolean) => act(() => cbs.at(-1)!([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
      // Any part of the card control above the bar's top edge → bar hidden (never two at once).
      fire(true);
      expect(bar.getAttribute("data-visible")).toBe("false");
      // Scrolled above the viewport top, or wholly behind the bar → bar shown.
      fire(false);
      expect(bar.getAttribute("data-visible")).toBe("true");
      fire(true);
      expect(bar.getAttribute("data-visible")).toBe("false");
    } finally {
      spy.mockRestore();
    }
  });

  it("shareBarRootMargin: bottom inset = the bar's height, rounded up, never negative", () => {
    expect(shareBarRootMargin(73)).toBe("0px 0px -73px 0px");
    expect(shareBarRootMargin(72.2)).toBe("0px 0px -73px 0px");
    expect(shareBarRootMargin(0)).toBe("0px 0px -0px 0px");
    expect(shareBarRootMargin(-5)).toBe("0px 0px -0px 0px");
  });
});

describe("DangerZone", () => {
  it("quiet Unpublish → confirm panel with solid Unpublish + Cancel (testids kept)", () => {
    const quiet = renderToStaticMarkup(<DangerZone isPaid={false} confirming={false} onConfirmChange={() => {}} onUnpublish={() => {}} busy={false} locked={false} />);
    expect(has(quiet, "unpublish-section")).toBe(true);
    expect(tag(quiet, "unpublish-button")).toContain("text-destructive");
    expect(tag(quiet, "unpublish-button")).toMatch(/\bmin-h-11\b/);
    const confirm = renderToStaticMarkup(<DangerZone isPaid={false} confirming onConfirmChange={() => {}} onUnpublish={() => {}} busy={false} locked={false} />);
    expect(confirm).toContain("The link stops working for everyone. Publishing again keeps the same link and expiry date.");
    expect(tag(confirm, "unpublish-confirm-button")).toContain("bg-destructive");
    const paid = renderToStaticMarkup(<DangerZone isPaid confirming onConfirmChange={() => {}} onUnpublish={() => {}} busy={false} locked={false} />);
    expect(paid).not.toContain("expiry date");
  });

  it("is last on a published page, after password", () => {
    const out = html(devPublishState("live"));
    expect(out.indexOf('data-testid="unpublish-section"')).toBeGreaterThan(out.indexOf('data-testid="password-section"'));
    expect(out.indexOf('data-testid="password-section"')).toBeGreaterThan(out.indexOf('data-testid="publish-pdf-locked"'));
  });
});
