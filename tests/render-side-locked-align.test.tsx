// M10c G1 fix: geometric / scrapbook text panels keep the layout's side whatever the script (an
// Arabic chapter title stays next to its accent and date plate); classic / modern keep the logical
// start/end (their markup is frozen by the goldens). dir="auto" stays on every text node.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BookPage } from "@/components/book/BookPage";
import { devSampleDoc, devSamplePhotos, DEV_SAMPLES } from "@/lib/book/dev-sample";
import { captionAlignOn, pageRenderModel, panelAlign } from "@/lib/book/render";
import { getLayout } from "@/lib/layouts";

describe("panelAlign", () => {
  it("geometric / scrapbook: start → left, end → right, centre kept", () => {
    for (const s of ["geometric", "scrapbook"]) {
      expect(panelAlign(s, "start")).toBe("left");
      expect(panelAlign(s, "end")).toBe("right");
      expect(panelAlign(s, "center")).toBe("center");
    }
  });
  it("classic / modern / unknown: unchanged", () => {
    for (const s of ["classic", "modern", undefined]) {
      expect(panelAlign(s, "start")).toBe("start");
      expect(panelAlign(s, "end")).toBe("end");
    }
  });
});

describe("render model", () => {
  const photos = devSamplePhotos();
  for (const sample of DEV_SAMPLES) {
    it(`${sample}: panels + AI captions align by style`, () => {
      const doc = devSampleDoc(sample);
      const locked = doc.style.designStyle === "geometric" || doc.style.designStyle === "scrapbook";
      let seen = 0;
      doc.pages.forEach((_, i) => {
        const m = pageRenderModel(doc, i, photos, sample.endsWith("-ar") ? "ar" : "en");
        for (const t of m?.texts ?? []) {
          seen++;
          if (locked) expect(["left", "right", "center"]).toContain(t.align);
          else expect(["left", "right"]).not.toContain(t.align);
        }
      });
      expect(seen).toBeGreaterThan(0);
    });
  }

  it("geometric AR: the chapter title on g-p-one-band renders text-align:left with dir=auto", () => {
    const doc = devSampleDoc("geometric-portrait-ar");
    const i = doc.pages.findIndex((p) => p.layout === "g-p-one-band");
    expect(i).toBeGreaterThanOrEqual(0);
    const html = renderToStaticMarkup(<BookPage doc={doc} page={i} photos={devSamplePhotos()} captionLang="ar" mode="view" />);
    const title = html.match(/<p[^>]*data-testid="text-chapterTitle"[^>]*>/)?.[0] ?? "";
    expect(title).toContain('dir="auto"');
    expect(title).toContain("text-align:left");
  });

  it("captions: user alignment wins; otherwise the panel side (geometric) or logical (modern)", () => {
    const g = getLayout("g-p-one-band")!;
    expect(captionAlignOn(g, { align: "center", source: "ai" })).toBe("left");
    expect(captionAlignOn(g, { align: "right", source: "user" })).toBe("right");
    expect(captionAlignOn(getLayout("m-p-two-panel")!, { align: "center", source: "ai" })).toBe("start");
  });
});
