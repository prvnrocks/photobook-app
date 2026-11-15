// @vitest-environment jsdom
// M21 T3: share page link card + primary card interactions — Copy feedback (data-copied ring,
// "Copied", polite status, clears after COPY_FEEDBACK_MS; failure message), native share only where
// navigator.share exists, and the publish celebration after a successful Publish (analytics payload
// unchanged). The viewer's ShareButtons keep their behaviour on the shared share-actions module.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics/client", () => ({ track: mocks.track, trackEvent: vi.fn() }));

const { ShareLinkCard } = await import("@/components/publish/ShareLinkCard");
const { ShareButtons } = await import("@/components/viewer/ShareButtons");
const { PublishPanelView } = await import("@/components/publish/PublishPanel");
const { COPY_FEEDBACK_MS } = await import("@/components/viewer/share-actions");
const { devPublishState, DEV_PUBLISH_URL } = await import("@/lib/publish/dev-fixture");
const { publishCompare } = await import("@/lib/publish/compare");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const URL_ = "https://photobook.example/b/sara-7Hq2xYp9Kd";
let root: Root;
let host: HTMLDivElement;

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(node));
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** useCanNativeShare detects in a requestAnimationFrame after mount. */
const flushFrame = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => r(null)))));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "clipboard");
  mocks.track.mockReset();
});

function stubClipboard(impl: (t: string) => Promise<void>) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

describe("ShareLinkCard copy feedback", () => {
  it("copies the URL, sets data-copied + 'Copied' + a polite status, then clears", async () => {
    const writeText = stubClipboard(async () => {});
    mount(<ShareLinkCard url={URL_} title="Sara" />);
    const btn = q("share-copy")!;
    expect(btn.hasAttribute("data-copied")).toBe(false);
    expect(btn.className).toContain("share-copy-pulse");
    await act(async () => btn.click());
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(btn.hasAttribute("data-copied")).toBe(true);
    expect(btn.textContent).toBe("Copied link");
    expect(q("share-copy-status")!.getAttribute("aria-live")).toBe("polite");
    expect(q("share-copy-status")!.textContent).toBe("Link copied");
    act(() => void vi.advanceTimersByTime(COPY_FEEDBACK_MS));
    expect(btn.hasAttribute("data-copied")).toBe(false);
    expect(btn.textContent).toBe("Copy link");
    expect(q("share-copy-status")!.textContent).toBe("");
  });

  it("failure: no copied ring, visible message", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    document.execCommand = vi.fn(() => false);
    mount(<ShareLinkCard url={URL_} title="Sara" />);
    await act(async () => q("share-copy")!.click());
    expect(q("share-copy")!.hasAttribute("data-copied")).toBe(false);
    expect(q("share-copy-status")!.textContent).toMatch(/Couldn't copy the link/);
  });

  it("WhatsApp link carries the title + URL; the URL field is ltr and read-only", () => {
    mount(<ShareLinkCard url={URL_} title="سارة" />);
    const wa = q("share-whatsapp") as HTMLAnchorElement;
    expect(wa.href).toBe(`https://wa.me/?text=${encodeURIComponent(`سارة ${URL_}`)}`);
    const field = q("publish-url") as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.dir).toBe("ltr");
    expect(field.value).toBe(URL_);
  });
});

describe("native share only where supported", () => {
  it("no navigator.share → no More options", async () => {
    mount(<ShareLinkCard url={URL_} title="Sara" />);
    await flushFrame();
    expect(q("share-native")).toBeNull();
  });

  it("navigator.share → More options opens the sheet with title + url; a cancel is ignored", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    mount(<ShareLinkCard url={URL_} title="Sara" />);
    expect(q("share-native")).toBeNull(); // first paint matches the server
    await flushFrame();
    await act(async () => q("share-native")!.click());
    expect(share).toHaveBeenCalledWith({ title: "Sara", url: URL_ });
  });

  it("viewer ShareButtons keep their behaviour (toast + native share) on the shared module", async () => {
    stubClipboard(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn(async () => {}) });
    mount(<ShareButtons url={URL_} title="Sara" />);
    await flushFrame();
    expect(q("share-native")).not.toBeNull();
    await act(async () => q("share-copy")!.click());
    expect(q("share-toast")!.textContent).toBe("Link copied");
    act(() => void vi.advanceTimersByTime(COPY_FEEDBACK_MS));
    expect(q("share-toast")).toBeNull();
  });
});

describe("publish success celebrates", () => {
  it("draft → Publish → pending → (refresh) live card with data-celebrate; published event payload unchanged", async () => {
    let state = devPublishState("draft");
    const publish = vi.fn(async () => ({ ok: true as const, slug: "s", url: DEV_PUBLISH_URL, expiresAt: null }));
    const props = {
      bookId: "11111111-1111-4111-8111-111111111111",
      title: "Sara & Omar",
      actions: { publish, unpublish: vi.fn(), setPassword: vi.fn() },
      paymentsEnabled: true,
      compare: publishCompare(),
      now: new Date("2026-11-10T10:00:00.000Z"),
    };
    const refresh = vi.fn();
    mount(<PublishPanelView {...props} state={state} refresh={refresh} />);
    expect(q("publish-panel")!.hasAttribute("data-celebrate")).toBe(false);
    await act(async () => q("publish-button")!.click());
    expect(mocks.track).toHaveBeenCalledWith("published", { is_paid: false, has_password: false, pages: 12, first: true });
    expect(refresh).toHaveBeenCalled();
    expect(q("publish-pending")).not.toBeNull();
    state = devPublishState("live");
    act(() => root.render(<PublishPanelView {...props} state={state} refresh={refresh} />));
    expect(q("publish-panel")!.getAttribute("data-celebrate")).toBe("on");
    expect(q("publish-live-card")!.getAttribute("data-celebrate")).toBe("on");
    expect(q("publish-live-heading")!.textContent).toBe("Share your link");
    expect(q("publish-message")!.textContent).toBe("Your book is live");
    expect(q("share-burst")).not.toBeNull();
  });

  it("a failed publish doesn't celebrate", async () => {
    const publish = vi.fn(async () => ({ ok: false as const, error: "failed" as const }));
    mount(
      <PublishPanelView
        bookId="11111111-1111-4111-8111-111111111111"
        title="Sara"
        state={devPublishState("changes")}
        actions={{ publish, unpublish: vi.fn(), setPassword: vi.fn() }}
        paymentsEnabled
        compare={publishCompare()}
        refresh={() => {}}
        now={new Date("2026-11-10T10:00:00.000Z")}
      />,
    );
    await act(async () => q("publish-changes-button")!.click());
    expect(q("publish-message")!.textContent).toMatch(/Couldn't publish/);
    expect(q("publish-panel")!.hasAttribute("data-celebrate")).toBe(false);
    expect(mocks.track).not.toHaveBeenCalled();
  });
});
