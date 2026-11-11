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
import { PDF_PAUSED_COPY, PDF_STEP_LABELS, pdfProgressSteps } from "@/lib/pdf/progress";
import type { PdfUiState } from "@/lib/pdf/ui";
import { DEV_PUBLISH_URL, devPublishState, type DevPublishStateName } from "@/lib/publish/dev-fixture";
import { publishCompare } from "@/lib/publish/compare";

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
    expect(html).toMatch(/class="[^"]*\bmin-h-1[12]\b[^"]*"[^>]*data-testid="pdf-download"/);
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

describe("PDF progress checklist (M11 T16: only real export states)", () => {
  const states = (s: PdfUiState) => pdfProgressSteps(s)?.map((x) => `${x.id}:${x.state}`) ?? null;
  it("maps starting / queued / rendering; nothing for idle, ready, timeout, error", () => {
    expect(states({ kind: "starting" })).toEqual(["request:current", "queue:todo", "render:todo", "ready:todo"]);
    expect(states({ kind: "preparing", exportId: "e", status: "queued", paused: false })).toEqual(["request:done", "queue:current", "render:todo", "ready:todo"]);
    expect(states({ kind: "preparing", exportId: "e", status: "rendering", paused: false })).toEqual(["request:done", "queue:done", "render:current", "ready:todo"]);
    expect(states({ kind: "idle" })).toBeNull();
    expect(states({ kind: "ready", exportId: "e", url: URL_, filename: "a.pdf", bytes: 1, pageCount: 1 })).toBeNull();
    expect(states({ kind: "timeout", exportId: "e" })).toBeNull();
    expect(states({ kind: "error", code: "failed" })).toBeNull();
  });

  it("renders the checklist with aria-current on the live step, and the paused note only when paused", () => {
    const html = view({ state: { kind: "preparing", exportId: "e1", status: "rendering", paused: false } });
    expect(has(html, "pdf-progress")).toBe(true);
    expect(html).toMatch(/data-step="render" data-state="current" aria-current="step"/);
    expect(html).toMatch(/data-step="queue" data-state="done"/);
    expect(html).toContain(PDF_STEP_LABELS.render);
    expect(has(html, "pdf-paused")).toBe(false);
    const paused = view({ state: { kind: "preparing", exportId: "e1", status: "queued", paused: true } });
    expect(paused).toContain(PDF_PAUSED_COPY);
    expect(paused).toMatch(/data-step="queue" data-state="current"/);
  });

  it("ready / error keep their exact text on pdf-status-text (Notice adds an sr-only prefix outside it)", () => {
    const ready = view({ state: { kind: "ready", exportId: "e1", url: URL_, filename: "s.pdf", bytes: 1_000_000, pageCount: 3 } });
    expect(ready).toContain('data-testid="pdf-status-text">Your PDF is ready</span>');
    expect(has(ready, "pdf-progress")).toBe(false);
    expect(ready).toContain('data-tone="success"');
    const err = view({ state: { kind: "error", code: "failed" } });
    expect(err).toContain('data-tone="error"');
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
      <PublishPanelView bookId={BOOK} title="T" state={devPublishState(name)} actions={actions} paymentsEnabled compare={publishCompare()} refresh={() => {}} />,
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

describe("one live region for PDF status (M11 review N7)", () => {
  const inner = (html: string) => {
    const at = html.indexOf('data-testid="pdf-status"');
    const end = html.indexOf('data-testid="pdf-download-again"') > at ? html.indexOf('data-testid="pdf-download-again"') : html.length;
    return html.slice(html.indexOf(">", at) + 1, end);
  };
  it.each<[string, PdfUiState]>([
    ["ready", { kind: "ready", url: "https://x/y.pdf", filename: "y.pdf", bytes: 1000, pages: 2 } as unknown as PdfUiState],
    ["failed", { kind: "error", code: "failed" }],
    ["timeout", { kind: "timeout", exportId: "e1" }],
  ])("%s: pdf-status is the only role/aria-live", (_, state) => {
    const html = view({ isPaid: true, state });
    expect(html).toMatch(/role="(status|alert)" aria-live="(polite|assertive)" data-testid="pdf-status"/);
    expect(inner(html)).not.toMatch(/role="(status|alert)"|aria-live=/);
  });
});
