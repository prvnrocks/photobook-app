// Task 7: page texts in the book doc — schema, v1/v2 serialization, render, publish, edit op.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage } from "@/components/book/BookPage";
import { serializeDoc, usesV2Features } from "@/lib/book/doc-version";
import { EditOpError, setPageText } from "@/lib/book/edit-ops";
import { pageRenderModel } from "@/lib/book/render";
import { hasUserPageTexts, isAiReplaceableDoc } from "@/lib/book/replaceable";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc, PageText } from "@/lib/book/types";
import { forcedMeta } from "@/lib/book/validate-editor-doc";
import { storyTemplateId } from "@/lib/layouts/story";
import { parsePublicDoc, publicDocToRenderDoc, toPublicDoc } from "@/lib/publish/public-doc";

const P1 = "00000000-0000-4000-8000-000000000001";
const tell1 = storyTemplateId("modern", "A5_PORTRAIT", "tell-1a");
const tell0q = storyTemplateId("modern", "A5_PORTRAIT", "tell-0q");

const text = (over: Partial<PageText> = {}): PageText => ({ id: "tx-b1", panel: 0, role: "paragraph", text: "The quiet lantern glows by the door.", source: "ai", blockRef: "b1", ...over });

function doc(over: Partial<BookDoc["pages"][number]> = {}): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "m-p-cover", photoId: null, title: "Trip", subtitle: "" },
    chapters: [{ id: "ch-c1", title: "Arrival", dateLabel: "Oct 2026", place: null }],
    pages: [{ id: "sp-pg1", chapterId: "ch-c1", layout: tell1, slots: [{ photoId: P1, crop: { x: 0.5, y: 0.5, zoom: 1 } }], caption: null, texts: [text()], ...over }],
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "modern", font: "Cormorant" },
    meta: { generator: "ai", generatorVersion: 1, runId: null, userEdited: false, story: { v: 1, version: 2, hashes: { "pg:sp-pg1": "0123456789ab" } } },
  };
}

describe("page texts: schema", () => {
  it("accepts a valid text and rejects bad ids, roles, blank text, > 900 units, two texts in one panel", () => {
    expect(parseBookDoc(doc()).ok).toBe(true);
    expect(parseBookDoc(doc({ texts: [text({ id: "TX 1" })] })).ok).toBe(false);
    expect(parseBookDoc(doc({ texts: [text({ role: "headline" as never })] })).ok).toBe(false);
    expect(parseBookDoc(doc({ texts: [text({ text: "   " })] })).ok).toBe(false);
    expect(parseBookDoc(doc({ texts: [text({ text: "a".repeat(901) })] })).ok).toBe(false);
    expect(parseBookDoc(doc({ texts: [text(), text({ id: "tx-b2" })] })).ok).toBe(false);
    expect(parseBookDoc(doc({ texts: [text({ panel: 4 })] })).ok).toBe(false);
    expect(parseBookDoc(doc({ texts: [{ ...text(), extra: 1 } as never] })).ok).toBe(false);
  });

  it("validateBookDoc: duplicate text ids across pages are an issue", () => {
    const d = doc();
    d.pages.push({ ...d.pages[0]!, id: "sp-pg2", slots: [{ photoId: null, crop: { x: 0.5, y: 0.5, zoom: 1 } }] });
    const issues = validateBookDoc(d, { photoIds: new Set([P1]), maxPages: 20 });
    expect(issues).toContain("pages[1]: duplicate text id");
  });
});

describe("page texts: serialization", () => {
  it("a page text makes the doc v2; stored with a fixed key order and meta.story kept", () => {
    const d = doc();
    expect(usesV2Features(d)).toBe(true);
    const out = serializeDoc(d) as BookDoc;
    expect(JSON.stringify(out.pages[0]!.texts)).toBe(JSON.stringify([{ id: "tx-b1", panel: 0, role: "paragraph", text: "The quiet lantern glows by the door.", source: "ai", blockRef: "b1" }]));
    expect(out.meta?.story).toEqual({ v: 1, version: 2, hashes: { "pg:sp-pg1": "0123456789ab" } });
    expect(JSON.stringify(serializeDoc(parsedOrThrow(JSON.parse(JSON.stringify(out)))))).toBe(JSON.stringify(out));
  });

  it("empty texts arrays are not stored", () => {
    const out = serializeDoc(doc({ texts: [] })) as BookDoc;
    expect("texts" in out.pages[0]!).toBe(false);
  });

  it("a doc without texts / meta.story serializes exactly as before (same keys, v1 when possible)", () => {
    const d = doc({ layout: "m-p-full", texts: undefined });
    delete d.meta!.story;
    const out = JSON.stringify(serializeDoc(d));
    expect(out).not.toContain("texts");
    expect(out).not.toContain("story");
    expect(out).toContain('"meta":{"generator":"ai","generatorVersion":1,"runId":null,"userEdited":false}');
  });
});

function parsedOrThrow(input: unknown): BookDoc {
  const r = parseBookDoc(input);
  if (!r.ok) throw new Error(r.issues.join("; "));
  return r.doc;
}

describe("page texts: render", () => {
  it("renders the text as a text node with dir=auto in its panel, with its element id", () => {
    const html = renderToStaticMarkup(<BookPage doc={doc({ texts: [text({ text: "<b>not html</b>" })] })} page={0} mode="view" photos={{}} />);
    expect(html).toContain('data-text-panel="pageText"');
    expect(html).toContain('data-text-id="tx-b1"');
    expect(html).toContain("&lt;b&gt;not html&lt;/b&gt;");
    expect(html).toMatch(/<p dir="auto"[^>]*data-testid="text-pageText"/);
  });

  it("Arabic text gets lang=ar; a text in a panel the layout lacks is not drawn", () => {
    const ar = renderToStaticMarkup(<BookPage doc={doc({ texts: [text({ text: "الفانوس الهادئ يلمع قرب الباب" })] })} page={0} mode="view" photos={{}} captionLang="ar" />);
    expect(ar).toContain('lang="ar"');
    const hidden = renderToStaticMarkup(<BookPage doc={doc({ texts: [text({ panel: 1 })] })} page={0} mode="view" photos={{}} />);
    expect(hidden).not.toContain('data-text-panel="pageText"');
  });

  it("edit targets: one area per pageText panel, empty ones included", () => {
    const d = doc({ layout: tell0q, slots: [], texts: [text()] });
    const m = pageRenderModel(d, 0, {}, "en", { editTargets: true });
    expect(m?.pageTextAreas?.map((a) => [a.panel, a.empty, a.textId])).toEqual([
      [1, true, null],
      [0, false, "tx-b1"],
    ]);
    expect(pageRenderModel(d, 0, {}, "en")?.pageTextAreas).toBeUndefined();
  });
});

describe("page texts: publish", () => {
  it("publishes shown texts only, without source / blockRef; round-trips to the renderer", () => {
    const d = doc({ texts: [text(), text({ id: "tx-b2", panel: 1, role: "pull_quote" })] });
    const pub = toPublicDoc(d);
    expect(pub.version).toBe(2);
    const page = (pub as Extract<typeof pub, { version: 2 }>).pages[0]!;
    expect(page.texts).toEqual([{ id: "tx-b1", panel: 0, role: "paragraph", text: "The quiet lantern glows by the door." }]);
    expect(JSON.stringify(pub)).not.toContain("blockRef");
    expect(parsePublicDoc(JSON.parse(JSON.stringify(pub))).ok).toBe(true);
    expect(publicDocToRenderDoc(pub).pages[0]!.texts?.[0]?.source).toBe("user");
  });

  it("a page whose layout has no pageText panel publishes no texts", () => {
    const d = doc({ layout: "m-p-full", texts: [text()] });
    const pub = toPublicDoc(d) as Extract<ReturnType<typeof toPublicDoc>, { version: 2 }>;
    expect(pub.pages[0]!.texts).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain("lantern");
  });
});

describe("page texts: edit op + ownership", () => {
  it("setPageText writes a user text (keeps id / role / blockRef), blank removes, missing panel throws", () => {
    const d = doc();
    const edited = setPageText(d, 0, 0, "Our own words.");
    expect(edited.pages[0]!.texts).toEqual([{ ...text(), text: "Our own words.", source: "user" }]);
    expect(setPageText(edited, 0, 0, "Our own words.")).toBe(edited);
    const removed = setPageText(edited, 0, 0, "   ");
    expect("texts" in removed.pages[0]!).toBe(false);
    expect(() => setPageText(d, 0, 1, "x")).toThrow(EditOpError);
    const added = setPageText(doc({ layout: tell0q, slots: [] }), 0, 1, "A short quote", "pull_quote");
    expect(added.pages[0]!.texts?.map((t) => [t.panel, t.role, t.source])).toEqual([
      [0, "paragraph", "ai"],
      [1, "pull_quote", "user"],
    ]);
    expect(added.pages[0]!.texts?.[1]?.id).toMatch(/^tx-sp-pg1-1$/);
  });

  it("user page texts block AI album overwrites; editor saves keep meta.story", () => {
    const d = setPageText(doc(), 0, 0, "Mine");
    expect(hasUserPageTexts(d)).toBe(true);
    expect(isAiReplaceableDoc(d)).toBe(false);
    expect(forcedMeta(doc()).story?.version).toBe(2);
    expect(forcedMeta({ meta: { generator: "rule", generatorVersion: 1, runId: null, userEdited: false } })).toEqual({ generator: "rule", generatorVersion: 1, runId: null, userEdited: true });
  });
});
