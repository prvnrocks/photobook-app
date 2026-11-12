// M13 review fixes (UI): free-link state, the editor's AI path (Make it with AI / Redo with AI),
// AI-off copy (D-024), toolbar selection key, picks-while-starting message.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
vi.mock("@/app/books/actions", () => ({ updateBookSetupAction: vi.fn() }));

import { readFileSync } from "node:fs";
import { EditorShell } from "@/components/editor/EditorShell";
import { selectionKey } from "@/components/editor/EditorToolbar";
import { MAKE_WITH_AI_LABEL } from "@/components/editor/MakeWithAiChip";
import { buildNoteCopy } from "@/components/review/BuildProgress";
import { titleCopy } from "@/components/upload/SetupCard";
import { PICKS_WHILE_STARTING_COPY } from "@/components/upload/Uploader";
import { startingCopy } from "@/components/upload/UploadSummary";
import { editorAiPath, NO_AI_PATH, sessionAiPath } from "@/lib/editor/ai-path";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";
import { freeLinkState } from "@/lib/publish/free-link";
import { LOCK_COPY } from "@/lib/upload/setup-ui";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("freeLinkState (D-039)", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  it("unpublished / counting (ceil, ≥ 1) / expired (incl. unparsable)", () => {
    expect(freeLinkState(null, now)).toEqual({ kind: "unpublished" });
    expect(freeLinkState(undefined, now)).toEqual({ kind: "unpublished" });
    expect(freeLinkState("2026-12-12T12:00:00Z", now)).toEqual({ kind: "counting", daysLeft: 30 });
    expect(freeLinkState("2026-11-12T13:00:00Z", now)).toEqual({ kind: "counting", daysLeft: 1 });
    expect(freeLinkState("2026-11-14T11:00:00Z", now)).toEqual({ kind: "counting", daysLeft: 2 });
    expect(freeLinkState("2026-11-12T12:00:00Z", now)).toEqual({ kind: "expired" });
    expect(freeLinkState("2026-10-01T00:00:00Z", now)).toEqual({ kind: "expired" });
    expect(freeLinkState("garbage", now)).toEqual({ kind: "expired" });
  });
});

describe("editorAiPath", () => {
  const base = { aiMode: "live" as const, generator: "rule" as const, userEdited: false, hasBuildRun: false };
  it("rule album, no build run, AI on, unedited → Make it with AI", () => {
    expect(editorAiPath(base)).toEqual({ makeWithAi: true, redoWithAi: false });
    expect(editorAiPath({ ...base, aiMode: "replay" })).toEqual({ makeWithAi: true, redoWithAi: false });
  });
  it("a run happened or an AI album → Redo with AI (review decides)", () => {
    expect(editorAiPath({ ...base, hasBuildRun: true })).toEqual({ makeWithAi: false, redoWithAi: true });
    expect(editorAiPath({ ...base, generator: "ai" })).toEqual({ makeWithAi: false, redoWithAi: true });
  });
  it("AI off or user-edited → neither", () => {
    expect(editorAiPath({ ...base, aiMode: "off" })).toEqual(NO_AI_PATH);
    expect(editorAiPath({ ...base, userEdited: true })).toEqual(NO_AI_PATH);
    expect(editorAiPath({ ...base, generator: "ai", userEdited: true })).toEqual(NO_AI_PATH);
  });
  it("session: hidden after an edit or in read-only", () => {
    const p = { makeWithAi: true, redoWithAi: false };
    expect(sessionAiPath(p, { edited: false, readOnly: false })).toBe(p);
    expect(sessionAiPath(p, { edited: true, readOnly: false })).toEqual(NO_AI_PATH);
    expect(sessionAiPath(p, { edited: false, readOnly: true })).toEqual(NO_AI_PATH);
    expect(sessionAiPath(undefined, { edited: false, readOnly: false })).toEqual(NO_AI_PATH);
  });
});

describe("editor Make it with AI chip", () => {
  const data = devEditorData("ok");
  const summary = { label: "8 of 10 in your book", linkText: "See 2 left out", kept: 8, total: 10 };
  it("persistent (no dismiss), links to the build screen, replaces the summary chip", () => {
    const html = renderToStaticMarkup(
      <EditorShell data={{ ...data, aiPath: { makeWithAi: true, redoWithAi: false } }} transport={devTransport("ok")} aiSummary={summary} />,
    );
    expect(html).toContain('data-testid="ai-make-chip"');
    expect(html).toMatch(new RegExp(`<a[^>]*data-testid="ai-make-link"[^>]*href="/books/${data.book.id}/build"`));
    expect(html).toContain(MAKE_WITH_AI_LABEL);
    expect(html).not.toContain("ai-summary-dismiss");
    expect(html).not.toContain('data-testid="ai-summary-chip"');
  });
  it("absent without aiPath / in read-only; summary chip shows instead", () => {
    const html = renderToStaticMarkup(<EditorShell data={data} transport={devTransport("ok")} aiSummary={summary} />);
    expect(html).not.toContain("ai-make-chip");
    expect(html).toContain('data-testid="ai-summary-chip"');
    const ro = renderToStaticMarkup(
      <EditorShell data={{ ...devEditorData("readonly"), aiPath: { makeWithAi: true, redoWithAi: false } }} transport={devTransport("readonly")} />,
    );
    expect(ro).not.toContain("ai-make-chip");
  });
  it("page-data computes aiPath + freeLink on the server", () => {
    const s = src("src/lib/editor/page-data.ts");
    expect(s).toContain("aiPath: editorAiPath(");
    expect(s).toContain("freeLinkState(data.expiresAt, now)");
  });
});

describe("AI-off copy (D-024)", () => {
  it("build note, upload starting line, setup title", () => {
    expect(buildNoteCopy(false, true)).toContain("AI");
    expect(buildNoteCopy(false, false)).toBe("Laying out your book…");
    expect(buildNoteCopy(true, false)).toBe("Opening your book…");
    expect(startingCopy(true)).toContain("AI");
    expect(startingCopy(false)).not.toMatch(/AI/);
    expect(titleCopy(true).hint).toContain("suggest");
    expect(titleCopy(false).hint).not.toContain("suggest");
    expect(titleCopy(false).summary).not.toContain("suggest");
    // M13 polish: AI off names the cover title the book really gets (the occasion default).
    expect(titleCopy(false)).toEqual({ summary: "Title: Our Photobook", hint: "Leave empty for \u201cOur Photobook\u201d" });
    expect(titleCopy(false, "wedding").summary).toBe("Title: Our Wedding");
    expect(titleCopy(true, "wedding").summary).toBe("Title: we'll suggest one");
  });
  it("pages pass resolveAiMode() through", () => {
    expect(src("src/app/books/[id]/upload/page.tsx")).toContain('aiOn={resolveAiMode() !== "off"}');
    expect(src("src/app/books/[id]/build/page.tsx")).toContain('const aiOn = resolveAiMode() !== "off";');
  });
});

describe("small fixes", () => {
  it("selectionKey: same thing → same key", () => {
    expect(selectionKey(null)).toBe("none");
    expect(selectionKey({ kind: "slot", pageIdx: 1, slotIdx: 2 })).toBe(selectionKey({ kind: "slot", pageIdx: 1, slotIdx: 2 }));
    expect(selectionKey({ kind: "slot", pageIdx: 1, slotIdx: 2 })).not.toBe(selectionKey({ kind: "slot", pageIdx: 1, slotIdx: 3 }));
    expect(selectionKey({ kind: "cover", part: "text" })).not.toBe(selectionKey({ kind: "cover", part: "photo" }));
  });
  it("picks while the build starts are announced, not dropped silently", () => {
    expect(PICKS_WHILE_STARTING_COPY).toMatch(/add more photos from the editor/);
    expect(src("src/components/upload/Uploader.tsx")).toContain("setPicksIgnored(true)");
  });
  it("lock copy covers the details, not just shape/style", () => {
    expect(LOCK_COPY.user_edited).not.toMatch(/^Page shape and style/);
    expect(LOCK_COPY.user_edited).toContain("edited");
  });
});
