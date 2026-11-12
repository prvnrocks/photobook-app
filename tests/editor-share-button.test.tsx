import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EditorShell } from "@/components/editor/EditorShell";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";

// The editor registry → UpgradeSheet → UpgradeButton imports the upgrade server action (server-only).
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

describe("editor header Done button (T12)", () => {
  it("renders without an app router (navigation is mounted only after Done)", () => {
    const html = renderToStaticMarkup(<EditorShell data={devEditorData("ok")} transport={devTransport("ok")} />);
    expect(html).toMatch(/<button type="button"[^>]*data-testid="editor-done"[^>]*>/);
    expect(html).not.toContain('data-testid="editor-done-error"');
  });

  it("stays available in read-only mode (it just leaves)", () => {
    const html = renderToStaticMarkup(<EditorShell data={devEditorData("readonly")} transport={devTransport("readonly")} />);
    const btn = html.match(/<button[^>]*data-testid="editor-done"[^>]*>/)?.[0] ?? "";
    expect(btn).not.toBe("");
    expect(btn).not.toContain('disabled=""');
  });
});
