import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(html).toContain("Free links last 30 days from the first share.");
    expect(btn).toContain('data-link="unpublished"');
    expect(html).toContain("anyone with the link can see it");
  });

  it("live free link → N days left; expired → Link expired (wins over Publish changes) (D-039)", () => {
    const data = devEditorData("ok");
    const free = { ...data, book: { ...data.book, isPaid: false } };
    const live = renderToStaticMarkup(<EditorShell data={{ ...free, freeLink: { kind: "counting", daysLeft: 12 } }} transport={devTransport("ok")} />);
    expect(button(live)).toContain("Free · 12 days left");
    expect(button(live)).not.toContain("Free · 30 days");
    expect(live).toContain("Your free link has 12 days left.");
    const one = renderToStaticMarkup(<EditorShell data={{ ...free, freeLink: { kind: "counting", daysLeft: 1 } }} transport={devTransport("ok")} />);
    expect(button(one)).toContain("Free · 1 day left");
    const expired = renderToStaticMarkup(
      <EditorShell data={{ ...free, publishedRev: 0, freeLink: { kind: "expired" } }} transport={devTransport("ok")} />,
    );
    expect(button(expired)).toContain("Link expired");
    expect(button(expired)).toContain('data-testid="editor-share-note"');
    expect(button(expired)).toContain('data-link="expired"');
    expect(expired).toContain("Your free link has expired.");
    expect(expired).not.toContain("Free links last");
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

  it("sends 'published' with the beacon transport (survives the switch to WhatsApp), once, only when the tap published", () => {
    const code = readFileSync(join(process.cwd(), "src/components/editor/EditorShareButton.tsx"), "utf8");
    expect(code).toContain('if (r?.ok && r.published) track("published", r.published, { beacon: true });');
    expect(code.match(/track\("published"/g)).toHaveLength(1);
  });
});
