// M22 review S3: pure helpers behind the emerald editor — the band's page-count chip, the save chip
// tone, PageCarousel's jump-only page-in fade, and the /dev-editor named states.
// Plus N4: EditorShell renders the stage boxes `bare` (the host paints the cream stage).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { devEditorFixture, devStateSaveMode, parseDevEditorState, withDevEditorState } from "@/app/dev-editor/dev-states";
import { ED_STAGE, ED_STAGE_BARE } from "@/components/editor/editor-classes";
import { bandPageCountLabel, EditorBand } from "@/components/editor/EditorBand";
import { EditorShell } from "@/components/editor/EditorShell";
import { pageInAttr, pageInFadeItem } from "@/components/editor/PageCarousel";
import { saveChipTone } from "@/components/editor/SaveStatus";
import type { SaveState } from "@/components/editor/useAutosave";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";

// The editor registry → UpgradeSheet → UpgradeButton imports the upgrade server action (server-only).
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

describe("bandPageCountLabel (EditorBand chip)", () => {
  it("formats N / M pages", () => {
    expect(bandPageCountLabel(12, 20)).toBe("12 / 20 pages");
    expect(bandPageCountLabel(0, 100)).toBe("0 / 100 pages");
    expect(bandPageCountLabel(22, 20)).toBe("22 / 20 pages");
  });

  it("hides (null) when the limit is unknown or not a positive number", () => {
    expect(bandPageCountLabel(3, null)).toBeNull();
    expect(bandPageCountLabel(3, undefined)).toBeNull();
    expect(bandPageCountLabel(3, 0)).toBeNull();
    expect(bandPageCountLabel(3, -5)).toBeNull();
    expect(bandPageCountLabel(3, Number.NaN)).toBeNull();
    expect(bandPageCountLabel(3, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("saveChipTone (SaveStatus chip)", () => {
  it.each<[SaveState, string]>([
    [{ kind: "idle" }, "saved"],
    [{ kind: "saved", savedAt: null }, "saved"],
    [{ kind: "saved", savedAt: "2026-11-15T10:00:00Z" }, "saved"],
    [{ kind: "pending" }, "saving"],
    [{ kind: "saving" }, "saving"],
    [{ kind: "retrying", attempt: 1 }, "warn"],
    [{ kind: "invalid", code: "x" }, "warn"],
    [{ kind: "conflict" }, "warn"],
    [{ kind: "unavailable" }, "warn"],
    [{ kind: "signedOut" }, "warn"],
    [{ kind: "failed" }, "warn"],
    [{ kind: "readOnly" }, "warn"],
  ])("%j → %s", (s, tone) => {
    expect(saveChipTone(s)).toBe(tone);
  });
});

describe("PageCarousel page-in rule (fade only on jumps > 1)", () => {
  it("fades the landing item only when the jump is more than one item", () => {
    expect(pageInFadeItem(0, 5)).toBe(5);
    expect(pageInFadeItem(7, 2)).toBe(2);
    expect(pageInFadeItem(3, 5)).toBe(5);
    expect(pageInFadeItem(3, 4)).toBeNull();
    expect(pageInFadeItem(4, 3)).toBeNull();
    expect(pageInFadeItem(4, 4)).toBeNull();
  });

  it("data-page-in is 'true' only on the current item when it is the fade target", () => {
    expect(pageInAttr(5, 5, 5)).toBe("true");
    expect(pageInAttr(4, 5, 5)).toBeUndefined();
    expect(pageInAttr(5, 5, null)).toBeUndefined();
    // The fade target is stale once the current item moved on.
    expect(pageInAttr(5, 6, 5)).toBeUndefined();
  });
});

describe("dev-editor named states", () => {
  it("parseDevEditorState accepts the named states only", () => {
    for (const s of ["readOnly", "conflict", "makeWithAi", "aiSummary", "linkExpired", "paid"]) {
      expect(parseDevEditorState(s)).toBe(s);
    }
    for (const v of [undefined, null, "", "readonly", "PAID", "nope", 1, ["paid"]]) {
      expect(parseDevEditorState(v)).toBeNull();
    }
  });

  it("devStateSaveMode: readOnly → readonly, conflict → conflict, otherwise the given mode", () => {
    expect(devStateSaveMode("readOnly", "ok")).toBe("readonly");
    expect(devStateSaveMode("conflict", "offline")).toBe("conflict");
    expect(devStateSaveMode("paid", "offline")).toBe("offline");
    expect(devStateSaveMode(null, "unavailable")).toBe("unavailable");
  });

  it("withDevEditorState applies each fixture state without mutating the input", () => {
    const base = devEditorData("ok");
    const snapshot = JSON.stringify(base);

    expect(withDevEditorState(base, null)).toEqual({ data: base, summary: null });
    expect(withDevEditorState(base, "readOnly")).toEqual({ data: base, summary: null });
    expect(withDevEditorState(base, "conflict")).toEqual({ data: base, summary: null });

    const ai = withDevEditorState(base, "makeWithAi");
    expect(ai.data.aiMode).toBe("replay");
    expect(ai.data.aiPath).toEqual({ makeWithAi: true, redoWithAi: false });
    expect(ai.summary).toBeNull();

    const summary = withDevEditorState(base, "aiSummary");
    expect(summary.data).toBe(base);
    expect(summary.summary).not.toBeNull();

    const expired = withDevEditorState(base, "linkExpired");
    expect(expired.data.publishedRev).toBe(base.docRev);
    expect(expired.data.freeLink).toEqual({ kind: "expired" });

    const paid = withDevEditorState(base, "paid");
    expect(paid.data.book.isPaid).toBe(true);
    expect(paid.data.book.maxPages).toBe(100);

    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe("EditorShell stage boxes render bare (N4)", () => {
  it("the carousel section and spread placeholder carry ED_STAGE_BARE, not the ED_STAGE background", () => {
    const html = renderToStaticMarkup(<EditorShell data={devEditorData("ok")} transport={devTransport("ok")} />);
    const section = html.match(/<section[^>]*aria-roledescription="carousel"[^>]*>/)?.[0] ?? "";
    const placeholder = html.match(/<div[^>]*data-testid="spread-placeholder"[^>]*>/)?.[0] ?? "";
    expect(section).not.toBe("");
    expect(placeholder).not.toBe("");
    for (const tag of [section, placeholder]) {
      for (const c of ED_STAGE_BARE.split(" ")) expect(tag).toContain(c);
      expect(tag).not.toContain("bg-[radial-gradient");
    }
    expect(ED_STAGE).toContain("bg-[radial-gradient");
  });
});

describe("EditorBand Preview button", () => {
  const band = (onPreview?: () => void) =>
    renderToStaticMarkup(
      <EditorBand back={null} title="T" saveStatus={null} undo={{ onClick() {}, disabled: true }} redo={{ onClick() {}, disabled: true }} share={<i data-testid="share" />} onPreview={onPreview} />,
    );
  it("sits just before Share, labelled, 44 px; absent without onPreview", () => {
    const html = band(() => {});
    expect(html).toContain('data-testid="editor-preview-open"');
    expect(html).toMatch(/aria-label="Preview the book"[^>]*class="[^"]*size-11/);
    expect(html.indexOf("editor-preview-open")).toBeGreaterThan(html.indexOf("editor-redo"));
    expect(html.indexOf("editor-preview-open")).toBeLessThan(html.indexOf('data-testid="share"'));
    expect(band()).not.toContain("editor-preview-open");
  });
});

describe("EditorBand eyebrow (≥ lg) follows read-only", () => {
  const band = (readOnly?: boolean) =>
    renderToStaticMarkup(
      <EditorBand back={null} title="T" saveStatus={null} undo={{ onClick() {}, disabled: true }} redo={{ onClick() {}, disabled: true }} share={null} readOnly={readOnly} />,
    ).match(/data-testid="editor-band-eyebrow">([^<]*)</)?.[1];
  it("says Editing normally and Viewing when editing is paused", () => {
    expect(band()).toBe("Editing");
    expect(band(false)).toBe("Editing");
    expect(band(true)).toBe("Viewing");
  });
  it("EditorShell passes read-only through (readonly save mode → Viewing)", () => {
    const html = renderToStaticMarkup(<EditorShell data={devEditorData("readonly")} transport={devTransport("readonly")} />);
    expect(html).toMatch(/data-testid="editor-band-eyebrow">Viewing</);
  });
});

describe("devEditorFixture (built on the dev page, M22 size trim)", () => {
  const base = { mode: "ok", ai: "off", pages: null, published: false, paid: false, format: "A5_PORTRAIT", bg: false, lightVeil: false, sample: null, state: null } as const;
  it("matches the plain fixture, and applies paid / published / state", () => {
    expect(devEditorFixture(base).data).toEqual(devEditorData("ok", "off"));
    expect(devEditorFixture(base).summary).toBeNull();
    const paid = devEditorFixture({ ...base, paid: true }).data.book;
    expect(paid.isPaid).toBe(true);
    expect(paid.maxPages).toBe(100);
    const pub = devEditorFixture({ ...base, published: true }).data;
    expect(pub.publishedRev).toBe(pub.docRev);
    expect(devEditorFixture({ ...base, state: "aiSummary" }).summary).not.toBeNull();
  });
});
