import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EditorShell } from "@/components/editor/EditorShell";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";

// The editor registry → UpgradeSheet → UpgradeButton imports the upgrade server action (server-only).
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

const button = (html: string) => html.match(/<button[^>]*data-testid="editor-done"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";

describe("editor header Share button (M13 T9; was Done, T12)", () => {
  it("renders without an app router (navigation is mounted only after Share)", () => {
    const html = renderToStaticMarkup(<EditorShell data={devEditorData("ok")} transport={devTransport("ok")} />);
    expect(html).toMatch(/<button type="button"[^>]*data-testid="editor-done"[^>]*>/);
    expect(html).not.toContain('data-testid="editor-done-error"');
  });

  it("says Share and shows the free 30-day notice before the tap", () => {
    const data = devEditorData("ok");
    const html = renderToStaticMarkup(<EditorShell data={{ ...data, book: { ...data.book, isPaid: false } }} transport={devTransport("ok")} />);
    const btn = button(html);
    expect(btn).toContain(">Share<");
    expect(btn).toContain("Free · 30 days");
    expect(btn).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain("Free links last 30 days.");
    expect(html).toContain("anyone with the link can see it");
  });

  it("paid → Permanent link", () => {
    const data = devEditorData("ok");
    const html = renderToStaticMarkup(<EditorShell data={{ ...data, book: { ...data.book, isPaid: true } }} transport={devTransport("ok")} />);
    expect(button(html)).toContain("Permanent link");
    expect(html).not.toContain("Free links last");
  });

  it("stays available in read-only mode", () => {
    const html = renderToStaticMarkup(<EditorShell data={devEditorData("readonly")} transport={devTransport("readonly")} />);
    const btn = html.match(/<button[^>]*data-testid="editor-done"[^>]*>/)?.[0] ?? "";
    expect(btn).not.toBe("");
    expect(btn).not.toContain('disabled=""');
  });
});
