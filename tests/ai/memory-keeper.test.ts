import { describe, expect, it } from "vitest";
import {
  captionLengthFromWordCounts,
  deriveMemoryUpdate,
  userCaptionWordCounts,
} from "@/lib/ai/agents/memory-keeper";
import { UserMemorySchema } from "@/lib/ai/schemas";

const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");

const cap = (text: string, source: "ai" | "user" | "auto" = "user") => ({
  text,
  font: "Inter",
  align: "center",
  source,
});

let pid = 0;
const page = (caption: unknown) => ({ id: `p${++pid}`, chapterId: null, layout: "full", slots: [], caption });
const docWith = (...captions: unknown[]) => ({ version: 1, pages: captions.map(page) });

const travelDefault = { occasion: "travel", tone: "fun", caption_lang: "en", title: "Trip" };

describe("deriveMemoryUpdate — tone", () => {
  it("does not store the occasion's default tone", () => {
    const r = deriveMemoryUpdate(null, travelDefault, {});
    expect(r.next.tonePreference).toBeUndefined();
    expect(r.next.sources?.tone).toBeUndefined();
  });

  it("keeps the previous tone when the book uses the default", () => {
    const prev = { v: 1, tonePreference: "romantic", sources: { tone: "explicit" } };
    const r = deriveMemoryUpdate(prev, travelDefault, {});
    expect(r.next.tonePreference).toBe("romantic");
    expect(r.next.sources?.tone).toBe("explicit");
  });

  it("stores an explicit (non-default) tone with source explicit", () => {
    const r = deriveMemoryUpdate(null, { ...travelDefault, tone: "minimal" }, {});
    expect(r.next.tonePreference).toBe("minimal");
    expect(r.next.sources?.tone).toBe("explicit");
    expect(r.reasons).toContain("tone_explicit");
    expect(r.changed).toBe(true);
  });

  it("ignores unknown tone / occasion values", () => {
    const r = deriveMemoryUpdate(null, { occasion: "party", tone: "angry", caption_lang: "en", title: "" }, {});
    expect(r.next.tonePreference).toBeUndefined();
  });
});

describe("deriveMemoryUpdate — language", () => {
  it("follows the book's caption language", () => {
    expect(deriveMemoryUpdate({ v: 1, language: "en" }, { ...travelDefault, caption_lang: "ar" }, {}).next.language).toBe(
      "ar",
    );
    expect(deriveMemoryUpdate({ v: 1, language: "ar" }, travelDefault, {}).next.language).toBe("en");
  });

  it("keeps the previous language when the book's is invalid", () => {
    expect(deriveMemoryUpdate({ v: 1, language: "ar" }, { ...travelDefault, caption_lang: "fr" }, {}).next.language).toBe(
      "ar",
    );
  });
});

describe("deriveMemoryUpdate — caption length", () => {
  it("leaves length unchanged with fewer than 3 user captions", () => {
    const prev = { v: 1, captionLength: "long", sources: { captionLength: "user_captions" } };
    const r = deriveMemoryUpdate(prev, travelDefault, docWith(cap(words(3)), cap(words(4))));
    expect(r.next.captionLength).toBe("long");
    expect(deriveMemoryUpdate(null, travelDefault, docWith(cap(words(3)))).next.captionLength).toBeUndefined();
  });

  it.each([
    [[3, 5, 10], "short"],
    [[2, 11, 20], "medium"],
    [[11, 16, 18], "medium"],
    [[17, 18, 2], "long"],
    [[10, 11, 1, 30], "medium"], // even count → mean of middles (10.5)
    [[4, 10, 10, 30], "short"],
  ] as const)("median of %j → %s", (counts, expected) => {
    const r = deriveMemoryUpdate(null, travelDefault, docWith(...counts.map((n) => cap(words(n)))));
    expect(r.next.captionLength).toBe(expected);
    expect(r.next.sources?.captionLength).toBe("user_captions");
    expect(r.reasons).toContain("caption_length");
  });

  it("ignores AI and auto captions", () => {
    const doc = docWith(cap(words(17)), cap(words(18)), cap(words(3), "ai"), cap(words(3), "ai"), cap(words(3), "auto"));
    expect(userCaptionWordCounts(doc)).toEqual([17, 18]);
    expect(deriveMemoryUpdate(null, travelDefault, doc).next.captionLength).toBeUndefined();

    const aiOnly = docWith(cap(words(30), "ai"), cap(words(30), "ai"), cap(words(30), "ai"));
    expect(deriveMemoryUpdate({ v: 1, captionLength: "short" }, travelDefault, aiOnly).next.captionLength).toBe("short");
  });

  it("works for Arabic user captions", () => {
    const doc = docWith(cap("رحلة جميلة إلى البحر"), cap("يوم مشمس"), cap("ذكريات لا تنسى معاً"));
    expect(deriveMemoryUpdate(null, travelDefault, doc).next.captionLength).toBe("short");
  });

  it("helper returns undefined below the threshold", () => {
    expect(captionLengthFromWordCounts([1, 2])).toBeUndefined();
  });
});

describe("deriveMemoryUpdate — names / avoid / safety", () => {
  it("preserves previous knownNames and avoid, and never adds names from the doc", () => {
    const prev = { v: 1, knownNames: ["Sara", "Omar"], avoid: ["no emojis"] };
    const doc = docWith(cap("Layla and Yusuf at the beach"), cap("Layla smiling"), cap("Yusuf with Layla"), cap("x", "ai"));
    (doc as Record<string, unknown>).cover = { title: "Layla's book", subtitle: "Ahmed", layout: "c", photoId: null };
    const r = deriveMemoryUpdate(prev, { ...travelDefault, title: "Layla & Yusuf" }, doc);
    expect(r.next.knownNames).toEqual(["Sara", "Omar"]);
    expect(r.next.avoid).toEqual(["no emojis"]);
    expect(JSON.stringify(r.next)).not.toMatch(/Layla|Yusuf|Ahmed/);
  });

  it("reasons are fixed codes and contain no user text", () => {
    const doc = docWith(cap("Secret Name Here one"), cap("Secret Name Here two"), cap("Secret Name Here three"));
    const r = deriveMemoryUpdate({ v: 1, junk: "Secret" }, { ...travelDefault, tone: "romantic", caption_lang: "ar" }, doc);
    expect(r.reasons.length).toBeGreaterThan(0);
    for (const code of r.reasons) {
      expect(["sanitized", "tone_explicit", "language", "caption_length"]).toContain(code);
    }
    expect(JSON.stringify(r.reasons)).not.toMatch(/Secret/);
  });
});

describe("deriveMemoryUpdate — idempotence and robustness", () => {
  const book = { occasion: "wedding", tone: "fun", caption_lang: "ar", title: "Us" };
  const doc = docWith(cap(words(5)), cap(words(6)), cap(words(7)));

  it("applying twice gives changed=false the second time", () => {
    const first = deriveMemoryUpdate({ v: 1, knownNames: ["Sara"] }, book, doc);
    expect(first.changed).toBe(true);
    const second = deriveMemoryUpdate(first.next, book, doc);
    expect(second.changed).toBe(false);
    expect(second.reasons).toEqual([]);
    expect(second.next).toEqual(first.next);
  });

  it("is unchanged when nothing new is learned", () => {
    const prev = { v: 1, language: "en" };
    const r = deriveMemoryUpdate(prev, travelDefault, {});
    expect(r.changed).toBe(false);
    expect(r.next).toEqual(prev);
  });

  it("key order of prev does not count as a change", () => {
    const prev = { language: "en", v: 1, tonePreference: "minimal", sources: { tone: "explicit" } };
    expect(deriveMemoryUpdate(prev, travelDefault, {}).changed).toBe(false);
  });

  it("garbage prev is sanitised and reported", () => {
    const r = deriveMemoryUpdate({ v: 9, tonePreference: "evil", email: "a@b.c" }, travelDefault, {});
    expect(r.next).toEqual({ v: 1, language: "en" });
    expect(r.changed).toBe(true);
    expect(r.reasons).toContain("sanitized");
  });

  it.each([null, undefined, 42, "doc", [], { pages: "nope" }, { pages: [null, 1, "x", { caption: 5 }, { caption: { text: 1 } }] }])(
    "garbage doc %j is handled",
    (badDoc) => {
      const r = deriveMemoryUpdate(null, travelDefault, badDoc);
      expect(UserMemorySchema.safeParse(r.next).success).toBe(true);
      expect(r.next.captionLength).toBeUndefined();
    },
  );

  it.each([null, undefined, "x", 3, [], { v: 1, knownNames: "Sara" }])("garbage prev %j is handled", (badPrev) => {
    const r = deriveMemoryUpdate(badPrev, book, doc);
    expect(UserMemorySchema.safeParse(r.next).success).toBe(true);
  });

  it("garbage book is handled", () => {
    // @ts-expect-error — runtime robustness against a malformed row
    const r = deriveMemoryUpdate({ v: 1 }, null, {});
    expect(r.next).toEqual({ v: 1 });
  });

  it("output is always schema-valid (strict)", () => {
    const r = deriveMemoryUpdate(
      { v: 1, knownNames: Array.from({ length: 50 }, (_, i) => `N${i}`), avoid: ["x‮y"] },
      book,
      doc,
    );
    expect(UserMemorySchema.strict().safeParse(r.next).success).toBe(true);
  });
});
