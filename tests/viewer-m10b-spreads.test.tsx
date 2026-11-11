// M10b A13 — spreads in the public flipbook viewer (pure parts): published v2 snapshots of the
// modern sample books (spreads, text panels, sliced covers) render exactly like the source doc,
// spread halves pair up in two-page mode and stand alone on phones, and fitBook never lets
// page-flip shrink a page to a fractional width (the cause of a 1 px seam at the fold).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage } from "@/components/book/BookPage";
import { devSampleDoc, devSamplePhotos, type DevSample } from "@/lib/book/dev-sample";
import { parseBookDoc } from "@/lib/book/schema";
import { getLayout } from "@/lib/layouts";
import { captionAlignOn } from "@/lib/book/render";
import type { BookDoc } from "@/lib/book/types";
import { autoDirection, parsePublicDoc, publicDocToRenderDoc, toPublicDoc } from "@/lib/publish/public-doc";
import { fitBook, pageHeightPx, pageRatio } from "@/lib/viewer/fit";
import { flipLayout, flipPageKind, pageCounterLabel } from "@/lib/viewer/pages";
import { visiblePages } from "@/lib/viewer/window";

const SAMPLES: DevSample[] = ["modern-portrait", "modern-landscape"];

function publishedRenderDoc(sample: DevSample) {
  const pub = toPublicDoc(devSampleDoc(sample), { captionLang: "en" });
  const parsed = parsePublicDoc(JSON.parse(JSON.stringify(pub)));
  if (!parsed.ok) throw new Error(`${sample}: snapshot did not parse`);
  return { pub: parsed.doc, render: publicDocToRenderDoc(parsed.doc) };
}

/**
 * Source markup with the page caption's logical text-align (start/end, from a design panel) turned
 * into the physical value dir="auto" gives it — what the published snapshot stores (same pixels).
 */
function physicalCaptionAlign(html: string, doc: BookDoc, pageIdx: number): string {
  const p = doc.pages[pageIdx];
  const layout = getLayout(p.layout);
  if (!p.caption || !layout) return html;
  const a = captionAlignOn(layout, p.caption);
  if (a !== "start" && a !== "end") return html;
  const rtl = autoDirection(p.caption.text) === "rtl";
  const phys = (a === "start") !== rtl ? "left" : "right";
  return html.replace(/(<p [^>]*?text-align:)(start|end)(;[^>]*data-testid="page-caption")/, `$1${phys}$3`);
}

describe("autoDirection (dir=auto)", () => {
  it("first strong letter decides; digits/punctuation are skipped; none → ltr", () => {
    expect(autoDirection("The longest table")).toBe("ltr");
    expect(autoDirection("أجمل ليلة")).toBe("rtl");
    expect(autoDirection("2026 — أجمل ليلة")).toBe("rtl");
    expect(autoDirection("١٣ أكتوبر")).toBe("rtl");
    expect(autoDirection("«Eid» ليلة")).toBe("ltr");
    expect(autoDirection("שלום")).toBe("rtl");
    expect(autoDirection("12:30 !")).toBe("ltr");
    expect(autoDirection("")).toBe("ltr");
  });
});

describe("published caption alignment", () => {
  const withCaption = (source: "ai" | "user", text: string, align: "left" | "center" | "right") => {
    const doc = devSampleDoc("modern-portrait");
    const i = doc.pages.findIndex((p) => p.layout === "m-p-two-panel");
    doc.pages[i] = { ...doc.pages[i], caption: { text, font: "Cormorant", align, source } };
    const pub = toPublicDoc(doc);
    return pub.pages[i].caption?.align;
  };
  it("AI caption on a start panel → physical by text direction; user alignment kept", () => {
    expect(captionAlignOn(getLayout("m-p-two-panel")!, { align: "center", source: "ai" })).toBe("start");
    expect(withCaption("ai", "Sand in our shoes", "center")).toBe("left");
    expect(withCaption("ai", "أجمل ليلة", "center")).toBe("right");
    expect(withCaption("user", "Sand in our shoes", "center")).toBe("center");
    expect(withCaption("user", "أجمل ليلة", "right")).toBe("right");
  });
  it("classic layouts keep the stored alignment (v1 path untouched)", () => {
    expect(captionAlignOn({ style: "classic", texts: undefined }, { align: "right", source: "ai" })).toBe("right");
  });
});

describe("published v2 snapshot of modern books", () => {
  for (const sample of SAMPLES) {
    it(`${sample}: v2, keeps spread sides, parses, renders identical markup (cover + every page)`, () => {
      const doc = devSampleDoc(sample);
      const { pub, render } = publishedRenderDoc(sample);
      expect(pub.version).toBe(2);
      if (pub.version !== 2) return;
      expect(pub.format).toBe(doc.format);
      expect(pub.style.designStyle).toBe("modern");
      expect(pub.pages.map((p) => p.side ?? null)).toEqual(doc.pages.map((p) => p.side ?? null));
      expect(parseBookDoc(render).ok).toBe(true);
      const photos = devSamplePhotos();
      let logical = 0;
      for (const page of ["cover" as const, ...doc.pages.map((_, i) => i)]) {
        const a = renderToStaticMarkup(<BookPage doc={doc} page={page} mode="view" photos={photos} captionLang="en" />);
        const b = renderToStaticMarkup(<BookPage doc={render} page={page} mode="view" photos={photos} captionLang="en" />);
        const want = page === "cover" ? a : physicalCaptionAlign(a, doc, page);
        if (want !== a) logical++;
        expect(b, String(page)).toBe(want);
      }
      // AI captions on design-style panels (logical start) exist in both samples.
      expect(logical).toBeGreaterThan(0);
    });

    it(`${sample}: right halves draw the left page's photos; sliced cover + text panels survive`, () => {
      const { render } = publishedRenderDoc(sample);
      const photos = devSamplePhotos();
      const cover = renderToStaticMarkup(<BookPage doc={render} page="cover" mode="view" photos={photos} />);
      // One cover photo shown in 3 slices.
      expect(getLayout(render.cover.layout)?.slices?.length).toBe(3);
      const url = (id: string) => (photos[id]?.url ?? "missing").replace(/&/g, "&amp;");
      expect(cover.split(url("d0")).length - 1).toBe(3);
      render.pages.forEach((p, i) => {
        if (p.side !== "right") return;
        const html = renderToStaticMarkup(<BookPage doc={render} page={i} mode="view" photos={photos} />);
        expect(html).toContain('data-spread-side="right"');
        const owner = render.pages[i - 1];
        const shown = owner.slots.filter((s) => s.photoId && html.includes(url(s.photoId)));
        expect(shown.length, `page ${i}`).toBeGreaterThan(0);
      });
      const textPage = render.pages.findIndex((p) => (getLayout(p.layout)?.texts?.length ?? 0) > 0);
      expect(textPage).toBeGreaterThanOrEqual(0);
    });
  }
});

describe("spread pairing in the viewer", () => {
  for (const sample of SAMPLES) {
    it(`${sample}: two-page mode shows both halves together; phones show each half alone`, () => {
      const doc = devSampleDoc(sample);
      const layout = flipLayout(doc.pages.length, { endCard: true, spread: true });
      doc.pages.forEach((p, i) => {
        if (p.side !== "left") return;
        expect(i % 2, `left half at even index ${i}`).toBe(0);
        const flip = i + 1;
        expect(flipPageKind(layout, flip)).toEqual({ kind: "page", pageIdx: i });
        // Either flip index of the pair shows [left, right] side by side.
        expect(visiblePages(flip, layout.count, true)).toEqual([flip, flip + 1]);
        expect(visiblePages(flip + 1, layout.count, true)).toEqual([flip, flip + 1]);
        expect(pageCounterLabel(layout, flip, true)).toBe(`${i + 1}–${i + 2} / ${doc.pages.length}`);
        const phone = flipLayout(doc.pages.length, { endCard: true, spread: false });
        expect(visiblePages(flip + 1, phone.count, false)).toEqual([flip + 1]);
        expect(pageCounterLabel(phone, flip + 1, false)).toBe(`${i + 2} / ${doc.pages.length}`);
      });
    });
  }
});

describe("fitBook keeps page-flip on whole-pixel pages", () => {
  // page-flip "stretch": pageWidth = blockWidth / cols; shrunk (fractional) only if pageWidth / ratio > block height.
  it("box height ≥ pageWidth / ratio and never exceeds the available box", () => {
    for (const format of ["A5_PORTRAIT", "A5_LANDSCAPE"] as const) {
      const ratio = pageRatio(format);
      for (let w = 200; w <= 2000; w += 13) {
        for (const h of [300, 480.5, 601, 673.98, 777, 900.25]) {
          for (const spread of [false, true]) {
            const b = fitBook({ width: w, height: h }, spread, ratio);
            if (!b) continue;
            expect(Number.isInteger(b.pageWidth)).toBe(true);
            expect(b.width).toBe(b.pageWidth * (spread ? 2 : 1));
            expect(b.height).toBeGreaterThanOrEqual(b.pageWidth / (ratio.w / ratio.h));
            expect(b.height).toBeLessThanOrEqual(Math.floor(h));
            expect(b.width).toBeLessThanOrEqual(w);
          }
        }
      }
    }
  });

  it("pageHeightPx rounds up, ignoring float noise on exact heights", () => {
    expect(pageHeightPx(483, pageRatio("A5_LANDSCAPE"))).toBe(341); // 340.4
    expect(pageHeightPx(210, pageRatio("A5_LANDSCAPE"))).toBe(148); // exact
    expect(pageHeightPx(148, pageRatio("A5_PORTRAIT"))).toBe(210); // exact
  });
});
