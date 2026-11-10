import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  getViewerBook: vi.fn(),
  getOgData: vi.fn(),
  isViewerOwner: vi.fn(),
  cookieGet: vi.fn(),
  refresh: vi.fn(),
}));

class NotFoundSignal extends Error {}

vi.mock("@/lib/db/public-books", () => ({
  getViewerBook: h.getViewerBook,
  getOgData: h.getOgData,
  isViewerOwner: h.isViewerOwner,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: h.cookieGet }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: h.refresh, replace: vi.fn() }),
  usePathname: () => "/b/x",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
vi.mock("@/app/b/[slug]/actions", () => ({ unlockBookAction: vi.fn() }));

import PublicBookPage, { dynamic, generateMetadata, viewport } from "@/app/b/[slug]/page";
import type { ViewerBook, ViewerBookResult } from "@/lib/db/public-books";
import { accessCookieName } from "@/lib/publish/access-cookie";
import { toPublicDoc } from "@/lib/publish/public-doc";
import { devViewerDoc, devViewerPhotos } from "@/lib/viewer/dev-fixture";

const SLUG = "our-trip-AbCdEfGhJk";
const BOOK_ID = "0b6f2a1e-9a3c-4c47-9d1a-5f3e2b7c8d90";

function book(state: ViewerBook["state"], extra: Partial<ViewerBook> = {}): ViewerBookResult {
  return {
    bookId: state === "not_found" ? null : BOOK_ID,
    book: {
      state,
      title: null,
      captionLang: "en",
      isPaid: false,
      pageCount: null,
      publishedRev: 1,
      expiresAt: null,
      hasPassword: false,
      doc: null,
      photos: {},
      ...extra,
    },
  };
}

function okBook(extra: Partial<ViewerBook> = {}): ViewerBookResult {
  const doc = toPublicDoc(devViewerDoc());
  return book("ok", { title: "Our trip", doc, pageCount: doc.pages.length, photos: devViewerPhotos() as ViewerBook["photos"], ...extra });
}

async function render(slug = SLUG): Promise<{ el: ReactElement; html: string }> {
  const el = (await PublicBookPage({ params: Promise.resolve({ slug }) })) as ReactElement;
  return { el, html: renderToStaticMarkup(el) };
}

/** Deep scan of an element's props (not rendered output) for a string. */
function propsContain(node: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof node === "string") return node.includes(needle);
  if (!node || typeof node !== "object" || seen.has(node)) return false;
  seen.add(node);
  if (isValidElement(node)) return propsContain(node.props, needle, seen);
  return Object.values(node as Record<string, unknown>).some((v) => propsContain(v, needle, seen));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cookieGet.mockReturnValue(undefined);
  h.isViewerOwner.mockResolvedValue(false);
});

describe("/b/[slug] route config", () => {
  it("is dynamic with viewport-fit=cover", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(viewport.viewportFit).toBe("cover");
  });

  it("metadata is noindex and uses buildBookMetadata on getOgData", async () => {
    h.getOgData.mockResolvedValue({ state: "locked", title: null, coverUrl: null, isPaid: false, publishedRev: 2, hasPassword: true, captionLang: "en" });
    const md = await generateMetadata({ params: Promise.resolve({ slug: SLUG }) });
    expect(h.getOgData).toHaveBeenCalledWith(SLUG);
    expect(md.robots).toEqual({ index: false, follow: false });
    expect(JSON.stringify(md)).not.toContain("Our trip");
  });

  it("metadata survives a DB failure (still noindex)", async () => {
    h.getOgData.mockRejectedValue(new Error("db down"));
    const md = await generateMetadata({ params: Promise.resolve({ slug: SLUG }) });
    expect(md.robots).toEqual({ index: false, follow: false });
  });
});

describe("/b/[slug] state mapping", () => {
  it("passes the per-book access cookie to getViewerBook", async () => {
    h.cookieGet.mockImplementation((name: string) => (name === accessCookieName(SLUG) ? { value: "tok" } : undefined));
    h.getViewerBook.mockResolvedValue(okBook());
    await render();
    expect(h.getViewerBook).toHaveBeenCalledWith(SLUG, { accessCookie: "tok" });
  });

  it("not_found → notFound()", async () => {
    h.getViewerBook.mockResolvedValue(book("not_found"));
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("malformed slug → notFound() without a lookup", async () => {
    await expect(render("x")).rejects.toBeInstanceOf(NotFoundSignal);
    expect(h.getViewerBook).not.toHaveBeenCalled();
  });

  it("expired, non-owner: create-your-own only, no editor link, no id", async () => {
    h.getViewerBook.mockResolvedValue(book("expired"));
    const { html, el } = await render();
    expect(h.isViewerOwner).toHaveBeenCalledWith(BOOK_ID);
    expect(html).toContain("This photobook has expired");
    expect(html).toContain('data-testid="expired-create"');
    expect(html).toContain("Create your own");
    expect(html).not.toContain("Upgrade to bring it back");
    expect(html).not.toContain("Open in editor");
    expect(html).not.toContain(BOOK_ID);
    expect(propsContain(el, BOOK_ID)).toBe(false);
  });

  it("expired, owner, payments off: disabled upgrade + 'Payments unavailable' + open in editor", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    h.getViewerBook.mockResolvedValue(book("expired"));
    h.isViewerOwner.mockResolvedValue(true);
    const { html } = await render();
    expect(html).toContain("This photobook has expired");
    expect(html).toContain("Upgrade to bring it back — AED 39");
    expect(html).toContain("Payments unavailable");
    expect(html).not.toMatch(/coming soon/i);
    expect(html).toMatch(/<button type="button" disabled=""[^>]*data-testid="expired-upgrade"/);
    expect(html).toContain(`href="/books/${BOOK_ID}/edit"`);
    expect(html).toContain("Open in editor");
  });

  it("expired, owner, payments on: enabled upgrade with the book id + /b/{slug} return", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";
    try {
      h.getViewerBook.mockResolvedValue(book("expired"));
      h.isViewerOwner.mockResolvedValue(true);
      const { html, el } = await render();
      expect(html).toMatch(/<button type="button" class="[^"]*" data-testid="expired-upgrade"/); // no disabled=""
      expect(html).not.toContain("Payments unavailable");
      expect(propsContain(el, BOOK_ID)).toBe(true);
      expect(propsContain(el, `/b/${SLUG}`)).toBe(true);
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });

  it("locked → password gate, no title, no id", async () => {
    h.getViewerBook.mockResolvedValue(book("locked", { hasPassword: true, title: null }));
    const { html, el } = await render();
    expect(html).toContain('data-testid="password-gate"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain("Our trip");
    expect(html).not.toContain('data-testid="viewer-shell"');
    expect(propsContain(el, BOOK_ID)).toBe(false);
  });

  it("unavailable → friendly message", async () => {
    h.getViewerBook.mockResolvedValue(book("unavailable"));
    const { html } = await render();
    expect(html).toContain('data-testid="book-unavailable"');
  });

  it("getViewerBook throwing → unavailable, not a crash", async () => {
    h.getViewerBook.mockRejectedValue(new Error("db down"));
    const { html } = await render();
    expect(html).toContain('data-testid="book-unavailable"');
  });

  it("ok → viewer shell with title, share URL; bookId nowhere in props or HTML", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://photobook.example";
    h.getViewerBook.mockResolvedValue(okBook());
    const { html, el } = await render();
    expect(html).toContain('data-testid="viewer-shell"');
    expect(html).toContain("Our trip");
    expect(html).toContain('data-paid="false"');
    const props = el.props as Record<string, unknown>;
    expect(props.shareUrl).toBe(`https://photobook.example/b/${SLUG}`);
    expect(props.shareTitle).toBe("Our trip");
    expect(props).not.toHaveProperty("bookId");
    expect(html).not.toContain(BOOK_ID);
    expect(propsContain(el, BOOK_ID)).toBe(false);
  });

  it("ok + paid → no footer", async () => {
    h.getViewerBook.mockResolvedValue(okBook({ isPaid: true }));
    const { html } = await render();
    expect(html).toContain('data-paid="true"');
    expect(html).not.toContain('data-testid="made-with-footer"');
  });

  it("ok + password book → share text has no title", async () => {
    h.getViewerBook.mockResolvedValue(okBook({ hasPassword: true, title: "Secret wedding" }));
    const { el } = await render();
    const props = el.props as Record<string, unknown>;
    expect(props.title).toBe("Secret wedding");
    expect(String(props.shareTitle)).not.toContain("Secret wedding");
  });
});
