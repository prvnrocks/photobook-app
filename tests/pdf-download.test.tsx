// M8 T8: <PdfDownloadView> static render per state, the PublishPanel PDF section, and the editor
// "PDF" tool. No DOM environment: the click flow is covered by tests/pdf-ui.test.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/books/b/edit",
  useSearchParams: () => new URLSearchParams(),
}));

import type { EditorContextValue } from "@/components/editor/editor-context";
import { PdfPanel, pdfDownloadTool, PDF_TOOL_ID } from "@/components/editor/tools/pdf-download";
import { EDITOR_TOOLS, visibleTools } from "@/components/editor/tools/registry";
import { UPGRADE_TOOL_ID } from "@/components/editor/UpgradeSheet";
import { PdfDownloadView } from "@/components/publish/PdfDownload";
import { PublishPanelView, type PublishActions } from "@/components/publish/PublishPanel";
import { devEditorData } from "@/lib/editor/dev-fixture";
import { initEditorState, type EditorSelection } from "@/lib/editor/store";
import type { PdfUiState } from "@/lib/pdf/ui";
import { DEV_PUBLISH_URL, devPublishState, type DevPublishStateName } from "@/lib/publish/dev-fixture";

const BOOK = "11111111-1111-4111-8111-111111111111";
const URL_ = "https://x.supabase.co/storage/v1/object/sign/exports/e1.pdf?token=t";
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

function view(props: { isPaid?: boolean; paymentsEnabled?: boolean; state?: PdfUiState } = {}): string {
  return renderToStaticMarkup(
    <PdfDownloadView
      bookId={BOOK}
      isPaid={props.isPaid ?? true}
      paymentsEnabled={props.paymentsEnabled ?? true}
      returnTo={`/books/${BOOK}/publish`}
      initialState={props.state}
    />,
  );
}

describe("<PdfDownloadView>", () => {
  it("paid idle: enabled 'Download PDF' button, empty status", () => {
    const html = view();
    expect(has(html, "pdf-download")).toBe(true);
    expect(html).toContain("Download PDF");
    expect(html).toMatch(/data-testid="pdf-status" data-state="idle"/);
    expect(html).not.toMatch(/data-testid="pdf-download"[^>]*disabled/);
    expect(html).toMatch(/class="[^"]*min-h-11[^"]*"[^>]*data-testid="pdf-download"/);
    expect(has(html, "pdf-upgrade")).toBe(false);
    expect(has(html, "pdf-download-again")).toBe(false);
  });

  it.each([
    { kind: "starting" } as PdfUiState,
    { kind: "preparing", exportId: "e1", status: "rendering", paused: false } as PdfUiState,
  ])("busy ($kind): disabled button with spinner + preparing copy", (state) => {
    const html = view({ state });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="pdf-download"/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(`data-state="${state.kind}"`);
    expect(html).toContain("Preparing your PDF… this can take up to a minute");
    expect(html).toContain("animate-spin");
  });

  it("ready: copy + size/pages + 'Download again' link to the signed URL; no main button", () => {
    const html = view({ state: { kind: "ready", exportId: "e1", url: URL_, filename: "sara.pdf", bytes: 3_250_000, pageCount: 21 } });
    expect(html).toContain('data-state="ready"');
    expect(html).toContain("Your PDF is ready");
    expect(html).toContain("3.1 MB · 21 pages");
    expect(html).toMatch(new RegExp(`<a href="${URL_.replace(/[.?]/g, "\\$&")}"[^>]*data-testid="pdf-download-again"`));
    expect(html).toContain("Download again");
    expect(html).not.toContain('target="_blank"');
    expect(has(html, "pdf-download")).toBe(false);
  });

  it("failed: retry copy as an alert + 'Try again'", () => {
    const html = view({ state: { kind: "error", code: "failed", detail: "render_timeout" } });
    expect(html).toContain('data-code="failed"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("We couldn&#x27;t make your PDF — try again");
    expect(html).toContain("Try again");
    expect(html).not.toContain("render_timeout");
  });

  it("daily cap / timeout copy", () => {
    expect(view({ state: { kind: "error", code: "daily_cap" } })).toContain("You&#x27;ve made a lot of PDFs today — try again tomorrow");
    const t = view({ state: { kind: "timeout", exportId: "e1" } });
    expect(t).toContain("Still working — check back in a minute");
    expect(t).toContain("Check again");
  });

  it("unauthenticated: Sign in link back to the page", () => {
    const html = view({ state: { kind: "error", code: "unauthenticated" } });
    expect(html).toContain("Please sign in again");
    expect(html).toContain(`href="/login?next=${encodeURIComponent(`/books/${BOOK}/publish`)}"`);
  });

  it("server says not_paid: upgrade instead of the download button", () => {
    const html = view({ state: { kind: "error", code: "not_paid" } });
    expect(html).toContain("PDF download comes with the upgrade");
    expect(has(html, "pdf-upgrade")).toBe(true);
    expect(has(html, "pdf-download")).toBe(false);
  });

  it("free book: no download button — upgrade copy + UpgradeButton", () => {
    const html = view({ isPaid: false });
    expect(has(html, "pdf-download-free")).toBe(true);
    expect(has(html, "pdf-download")).toBe(false);
    expect(html).toContain("PDF download comes with the upgrade");
    expect(has(html, "pdf-upgrade")).toBe(true);
    expect(html).toContain("AED 39");
    expect(has(html, "pdf-upgrade-unavailable")).toBe(false);
  });

  it("free book, payments off: disabled upgrade + 'Payments unavailable'", () => {
    const html = view({ isPaid: false, paymentsEnabled: false });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="pdf-upgrade"/);
    expect(has(html, "pdf-upgrade-unavailable")).toBe(true);
  });
});

describe("PublishPanel PDF section", () => {
  const actions: PublishActions = {
    publish: async () => ({ ok: true, slug: "s", url: DEV_PUBLISH_URL, expiresAt: null }),
    unpublish: async () => ({ ok: true }),
    setPassword: async () => ({ ok: true, hasPassword: true }),
  };
  const panel = (name: DevPublishStateName) =>
    renderToStaticMarkup(
      <PublishPanelView bookId={BOOK} title="T" state={devPublishState(name)} actions={actions} paymentsEnabled refresh={() => {}} />,
    );

  it.each(["draft-paid", "live-paid"] as const)("%s: PDF section with Download PDF", (name) => {
    const html = panel(name);
    expect(has(html, "publish-pdf")).toBe(true);
    expect(has(html, "pdf-download")).toBe(true);
  });

  it.each(["draft", "live", "expired", "changes"] as const)("%s (free): no PDF section, single upgrade button", (name) => {
    const html = panel(name);
    expect(has(html, "publish-pdf")).toBe(false);
    expect(has(html, "pdf-download")).toBe(false);
    expect(has(html, "pdf-upgrade")).toBe(false);
  });
});

describe("editor PDF tool", () => {
  function ctxFor(opts: { isPaid: boolean; selection?: EditorSelection; activeTool?: string | null; readOnly?: boolean }) {
    const data = devEditorData("ok");
    return {
      book: { ...data.book, isPaid: opts.isPaid, maxPages: opts.isPaid ? 100 : 20 },
      state: { ...initEditorState(data.doc, { readOnly: opts.readOnly, page: 0 }), selection: opts.selection ?? null },
      readOnly: opts.readOnly === true,
      paymentsEnabled: true,
      photos: { web: {}, thumbs: {} },
      save: { status: { kind: "idle" }, flush: vi.fn(), settle: vi.fn(async () => ({ kind: "saved", savedAt: null })) },
      activeTool: opts.activeTool ?? null,
      openTool: vi.fn(),
      closeTool: vi.fn(),
    } as unknown as EditorContextValue;
  }
  const ids = (ctx: EditorContextValue) => visibleTools(EDITOR_TOOLS, ctx).map((t) => t.id);

  it("is registered", () => {
    expect(EDITOR_TOOLS.map((t) => t.id)).toContain(PDF_TOOL_ID);
    expect(pdfDownloadTool.editsDoc).toBe(false);
  });

  it("paid books with nothing selected get PDF where free books get Upgrade", () => {
    expect(ids(ctxFor({ isPaid: true }))).toContain(PDF_TOOL_ID);
    expect(ids(ctxFor({ isPaid: true }))).not.toContain(UPGRADE_TOOL_ID);
    expect(ids(ctxFor({ isPaid: false }))).not.toContain(PDF_TOOL_ID);
    expect(ids(ctxFor({ isPaid: false }))).toContain(UPGRADE_TOOL_ID);
    // Same toolbar size for both (fits 375 px).
    expect(ids(ctxFor({ isPaid: true })).length).toBe(ids(ctxFor({ isPaid: false })).length);
  });

  it("hidden while something is selected unless open; still offered read-only", () => {
    const slot: EditorSelection = { kind: "slot", pageIdx: 0, slotIdx: 0 };
    expect(ids(ctxFor({ isPaid: true, selection: slot }))).not.toContain(PDF_TOOL_ID);
    expect(ids(ctxFor({ isPaid: true, selection: slot, activeTool: PDF_TOOL_ID }))).toContain(PDF_TOOL_ID);
    expect(ids(ctxFor({ isPaid: true, readOnly: true }))).toContain(PDF_TOOL_ID);
  });

  it("panel renders the download button for paid books", () => {
    const html = renderToStaticMarkup(<PdfPanel ctx={ctxFor({ isPaid: true })} close={() => {}} />);
    expect(has(html, "pdf-panel")).toBe(true);
    expect(has(html, "pdf-download")).toBe(true);
    expect(html).toContain("latest saved edits");
  });
});
