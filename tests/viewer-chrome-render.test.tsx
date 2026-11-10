import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Watermark } from "@/components/book/Watermark";
import { ChapterLabel } from "@/components/viewer/ChapterLabel";
import { EndCard } from "@/components/viewer/EndCard";
import { MadeWithFooter } from "@/components/viewer/MadeWithFooter";
import { PageCounter } from "@/components/viewer/PageCounter";
import { ShareButtons } from "@/components/viewer/ShareButtons";
import { ViewerShell } from "@/components/viewer/ViewerShell";
import { APP_NAME } from "@/lib/brand";
import { devViewerDoc, devViewerPhotos } from "@/lib/viewer/dev-fixture";
import { flipLayout } from "@/lib/viewer/pages";

function shell(isPaid: boolean) {
  const doc = devViewerDoc();
  return renderToStaticMarkup(
    <ViewerShell
      doc={doc}
      photos={devViewerPhotos()}
      title={doc.cover.title}
      isPaid={isPaid}
      shareUrl="https://example.com/b/abc"
      shareTitle="Our trip"
    />,
  );
}

describe("viewer chrome markup", () => {
  it("footer only when unpaid", () => {
    expect(shell(false)).toContain('data-testid="made-with-footer"');
    expect(shell(true)).not.toContain('data-testid="made-with-footer"');
  });
  it("shell has title with dir=auto, controls, safe-area insets", () => {
    const html = shell(false);
    expect(html).toMatch(/<h1 dir="auto"[^>]*data-testid="viewer-title"/);
    expect(html).toContain('data-testid="page-counter"');
    expect(html).toContain("Cover");
    expect(html).toContain("safe-area-inset-top");
    expect(html).toContain("safe-area-inset-bottom");
  });
  it("watermark: aria-hidden, no pointer events, repeats APP_NAME, class-only styles", () => {
    const html = renderToStaticMarkup(<Watermark />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("pointer-events-none");
    expect(html.split(APP_NAME).length - 1).toBeGreaterThan(10);
    expect(html).not.toContain("style=");
  });
  it("end card: CTA when unpaid, small link when paid", () => {
    const free = renderToStaticMarkup(<EndCard isPaid={false} />);
    const paid = renderToStaticMarkup(<EndCard isPaid />);
    expect(free).toContain("Make your own photobook");
    expect(free).toContain('href="/?ref=book"');
    expect(paid).not.toContain("Make your own photobook");
    expect(paid).toContain(`Made with ${APP_NAME}`);
    // page-flip forwards taps only when the target IS the <a>: links must hold text only.
    for (const html of [free, paid]) {
      for (const m of html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)) expect(m[1]).not.toContain("<");
    }
  });
  it("footer links to /?ref=book", () => {
    expect(renderToStaticMarkup(<MadeWithFooter />)).toContain('href="/?ref=book"');
  });
  it("share buttons: encoded WhatsApp link, no native button on the server", () => {
    const html = renderToStaticMarkup(<ShareButtons url="https://x.ae/b/a b" title="Eid & us" />);
    expect(html).toContain(`href="https://wa.me/?text=${encodeURIComponent("Eid & us https://x.ae/b/a b").replace(/&/g, "&amp;")}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('data-testid="share-native"');
  });
  it("chapter label is dir=auto and Cairo for Arabic", () => {
    const html = renderToStaticMarkup(<ChapterLabel chapter={{ id: "b", title: "عشاء العائلة", dateLabel: "12 Feb" }} />);
    expect(html).toContain('dir="auto"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain("--font-cairo");
    expect(html).toContain("عشاء العائلة · <bdi>12 Feb</bdi>");
  });
  it("page counter", () => {
    const l = flipLayout(20, { endCard: true, spread: true });
    expect(renderToStaticMarkup(<PageCounter layout={l} current={4} spread />)).toContain("3–4 / 20");
  });
});
