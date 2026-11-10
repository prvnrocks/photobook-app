import { describe, expect, it } from "vitest";
import { autolayout, AUTOLAYOUT_VERSION } from "@/lib/autolayout";
import { parseBookDoc } from "@/lib/book/schema";
import { docOrigin, hasUserCaptions, isAiReplaceableDoc, isEmptyDoc, isReplaceableDoc, withMeta } from "@/lib/book/replaceable";
import type { BookDoc, DocMeta } from "@/lib/book/types";

const RUN_ID = "3f0c6a8e-2b1d-4c6e-9a7f-1e2d3c4b5a69";

/** A doc exactly as M2 finalize wrote it: no `meta`. */
const m2Doc = () => ({
  version: 1,
  format: "A5_PORTRAIT",
  occasion: "travel",
  cover: { layout: "cover", photoId: "a", title: "Our Travels", subtitle: "Abu Dhabi · Oct 2026" },
  chapters: [{ id: "c1", title: "Abu Dhabi", dateLabel: "12 Oct 2026", place: "Abu Dhabi" }],
  pages: [
    { id: "p1", chapterId: "c1", layout: "full-page", slots: [{ photoId: "a", crop: { x: 0.5, y: 0.5, zoom: 1 } }], caption: null },
  ],
  style: { background: "#FFFFFF", font: "Playfair" },
});

const aiMeta = (over: Partial<DocMeta> = {}): DocMeta => ({
  generator: "ai",
  generatorVersion: 1,
  runId: RUN_ID,
  userEdited: false,
  ...over,
});

function parsed(input: unknown): BookDoc {
  const r = parseBookDoc(input);
  if (!r.ok) throw new Error(r.issues.join("; "));
  return r.doc;
}

describe("BookDocSchema meta", () => {
  it("M2-shaped doc without meta still parses (meta stays absent)", () => {
    const doc = parsed(m2Doc());
    expect(doc.meta).toBeUndefined();
    // Stored as v1; parseBookDoc returns the upgraded v2 doc (M10a).
    expect(doc.version).toBe(2);
  });

  it("meta round-trips through parseBookDoc", () => {
    const meta = aiMeta({ userEdited: true, generatorVersion: 3 });
    const doc = parsed({ ...m2Doc(), meta });
    expect(doc.meta).toEqual(meta);
    expect(parsed(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(parsed({ ...m2Doc(), meta: { ...meta, generator: "rule", runId: null } }).meta?.runId).toBeNull();
  });

  it("rejects bad meta: unknown keys (strict), bad generator, version < 1 / non-int, non-uuid runId, missing userEdited", () => {
    const bad: unknown[] = [
      { ...aiMeta(), extra: 1 },
      { ...aiMeta(), generator: "human" },
      { ...aiMeta(), generatorVersion: 0 },
      { ...aiMeta(), generatorVersion: 1.5 },
      { ...aiMeta(), runId: "run-1" },
      { generator: "ai", generatorVersion: 1, runId: null },
      null,
      "ai",
    ];
    for (const meta of bad) expect(parseBookDoc({ ...m2Doc(), meta }).ok).toBe(false);
  });
});

describe("docOrigin / isReplaceableDoc", () => {
  it("{} → none, replaceable", () => {
    expect(isEmptyDoc({})).toBe(true);
    expect(docOrigin({})).toEqual({ generator: "none", userEdited: false });
    expect(isReplaceableDoc({})).toBe(true);
  });

  it("M2 doc without meta → rule, not edited, replaceable", () => {
    expect(docOrigin(m2Doc())).toEqual({ generator: "rule", userEdited: false });
    expect(isReplaceableDoc(m2Doc())).toBe(true);
  });

  it("AI draft not edited → replaceable; userEdited → not replaceable", () => {
    expect(isReplaceableDoc({ ...m2Doc(), meta: aiMeta() })).toBe(true);
    expect(docOrigin({ ...m2Doc(), meta: aiMeta({ userEdited: true }) })).toEqual({ generator: "ai", userEdited: true });
    expect(isReplaceableDoc({ ...m2Doc(), meta: aiMeta({ userEdited: true }) })).toBe(false);
    expect(isReplaceableDoc({ ...m2Doc(), meta: aiMeta({ generator: "rule", runId: null, userEdited: true }) })).toBe(false);
  });

  it("garbage / unparsable → treated as user-edited, never replaceable", () => {
    const garbage: unknown[] = [
      null,
      undefined,
      "doc",
      42,
      [],
      { version: 2 },
      { ...m2Doc(), pages: "nope" },
      { ...m2Doc(), meta: { ...aiMeta(), extra: true } },
      { ...m2Doc(), meta: { ...aiMeta(), userEdited: "false" } },
    ];
    for (const g of garbage) {
      expect(docOrigin(g).userEdited).toBe(true);
      expect(isReplaceableDoc(g)).toBe(false);
    }
    // generator is still reported when the raw meta names one
    expect(docOrigin({ ...m2Doc(), meta: { ...aiMeta(), extra: true } }).generator).toBe("ai");
    expect(docOrigin({ version: 2 }).generator).toBe("rule");
  });
});

describe("hasUserCaptions / isAiReplaceableDoc (D-031)", () => {
  const cap = (source: "ai" | "user" | "auto") => ({ text: "A day by the sea", font: "Playfair", align: "center", source });
  /** m2Doc with a second page (one-portrait has a caption area) carrying the given caption. */
  const withCaption = (caption: unknown, meta: DocMeta | undefined = aiMeta()) => ({
    ...m2Doc(),
    pages: [
      ...m2Doc().pages,
      { id: "p2", chapterId: "c1", layout: "one-portrait", slots: [{ photoId: "b", crop: { x: 0.5, y: 0.5, zoom: 1 } }], caption },
    ],
    ...(meta ? { meta } : {}),
  });

  it("fixture with a user caption is a valid doc", () => {
    expect(parseBookDoc(withCaption(cap("user"))).ok).toBe(true);
  });

  it("hasUserCaptions: true only for a caption with source 'user'", () => {
    expect(hasUserCaptions({})).toBe(false);
    expect(hasUserCaptions(m2Doc())).toBe(false);
    expect(hasUserCaptions(withCaption(null))).toBe(false);
    expect(hasUserCaptions(withCaption(cap("ai")))).toBe(false);
    expect(hasUserCaptions(withCaption(cap("auto")))).toBe(false);
    expect(hasUserCaptions(withCaption(cap("user")))).toBe(true);
    expect(hasUserCaptions(withCaption(cap("user"), undefined))).toBe(true);
  });

  it("hasUserCaptions reads raw values: unparsable docs with a user caption still count; garbage is false", () => {
    expect(hasUserCaptions({ pages: [{ caption: { source: "user" } }] })).toBe(true);
    expect(hasUserCaptions({ ...withCaption(cap("user")), version: 2 })).toBe(true);
    for (const g of [null, undefined, "doc", 42, [], { pages: "nope" }, { pages: [null, 1, "x", { caption: "user" }] }]) {
      expect(hasUserCaptions(g)).toBe(false);
    }
  });

  it("isAiReplaceableDoc = isReplaceableDoc && !hasUserCaptions", () => {
    expect(isAiReplaceableDoc({})).toBe(true);
    expect(isAiReplaceableDoc(m2Doc())).toBe(true);
    expect(isAiReplaceableDoc(withCaption(cap("ai")))).toBe(true);
    expect(isAiReplaceableDoc(withCaption(cap("auto"), undefined))).toBe(true);
    // user caption: blocks AI runs but not relayout (isReplaceableDoc unchanged)
    expect(isAiReplaceableDoc(withCaption(cap("user")))).toBe(false);
    expect(isReplaceableDoc(withCaption(cap("user")))).toBe(true);
    expect(isAiReplaceableDoc(withCaption(cap("user"), undefined))).toBe(false);
    expect(isReplaceableDoc(withCaption(cap("user"), undefined))).toBe(true);
    // user-edited / garbage stay refused by both
    expect(isAiReplaceableDoc({ ...m2Doc(), meta: aiMeta({ userEdited: true }) })).toBe(false);
    expect(isAiReplaceableDoc(null)).toBe(false);
    expect(isAiReplaceableDoc({ version: 2 })).toBe(false);
  });
});

describe("withMeta", () => {
  it("sets meta on a copy and the result parses", () => {
    const doc = parsed(m2Doc());
    const out = withMeta(doc, aiMeta());
    expect(out.meta).toEqual(aiMeta());
    expect(doc.meta).toBeUndefined();
    expect(parsed(out)).toEqual(out);
    expect(isReplaceableDoc(out)).toBe(true);
    expect(withMeta(out, aiMeta({ userEdited: true })).meta?.userEdited).toBe(true);
  });

  it("throws on invalid meta", () => {
    expect(() => withMeta(parsed(m2Doc()), { ...aiMeta(), runId: "x" })).toThrow();
  });
});

describe("autolayout meta", () => {
  const photo = (id: string) => ({
    id,
    width: 3000,
    height: 4000,
    takenAt: "2026-10-12T10:00:00+04:00",
    dateSource: "exif" as const,
    place: null,
    status: "kept" as const,
    dupGroup: null,
    blurScore: 100,
  });
  const OPTS = { occasion: "travel" as const, title: null, captionLang: "en" as const, isPaid: false };

  it("every rule doc carries meta.generator 'rule', version, runId null, not edited", () => {
    expect(AUTOLAYOUT_VERSION).toBe(1);
    for (const ps of [[], [photo("a")], ["a", "b", "c", "d", "e"].map(photo)]) {
      const doc = autolayout(ps, OPTS);
      expect(doc.meta).toEqual({ generator: "rule", generatorVersion: AUTOLAYOUT_VERSION, runId: null, userEdited: false });
      expect(parseBookDoc(doc).ok).toBe(true);
      expect(isReplaceableDoc(doc)).toBe(true);
      expect(docOrigin(doc).generator).toBe("rule");
    }
  });

  it("passes a runId through", () => {
    expect(autolayout([photo("a")], { ...OPTS, runId: RUN_ID }).meta?.runId).toBe(RUN_ID);
  });

  it("minimal fallback doc also carries meta (an invalid runId forces it; runId dropped)", () => {
    const doc = autolayout(["a", "b", "c"].map(photo), { ...OPTS, runId: "not-a-uuid" });
    expect(doc.chapters).toEqual([]); // the minimal album
    expect(doc.pages.map((p) => p.layout)).toEqual(["full-page", "full-page", "full-page"]);
    expect(doc.meta).toEqual({ generator: "rule", generatorVersion: 1, runId: null, userEdited: false });
    expect(parseBookDoc(doc).ok).toBe(true);
  });
});
