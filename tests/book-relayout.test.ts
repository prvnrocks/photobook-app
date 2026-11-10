import { describe, expect, it } from "vitest";
import { relayoutDoc, MORE_MOMENTS_TITLE, type RelayoutPhoto } from "@/lib/book/relayout";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc, BookPage } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";

const RUN = "22222222-2222-4222-8222-222222222222";
const OPTS = { isPaid: false, maxPages: 20, captionLang: "en" as const };

const P = { width: 3000, height: 4000 }; // portrait
const L = { width: 4000, height: 3000 }; // landscape

function ph(id: string, size: { width: number; height: number }, takenAt: string | null, extra: Partial<RelayoutPhoto> = {}): RelayoutPhoto {
  return { id, ...size, takenAt, status: "kept", place: null, dupGroup: null, blurScore: 50, ...extra };
}

const BASE: RelayoutPhoto[] = [
  ph("a1", P, "2026-10-12T10:00:00", { blurScore: 90, place: "Saadiyat Beach" }),
  ph("a2", P, "2026-10-12T11:00:00"),
  ph("a3", P, "2026-10-12T12:00:00"),
  ph("a4", L, "2026-10-12T13:00:00"),
  ph("a5", L, "2026-10-12T14:00:00"),
  ph("b1", L, "2026-10-14T10:00:00", { place: "Liwa" }),
  ph("b2", P, "2026-10-14T11:00:00", { place: "Liwa" }),
  ph("b3", P, "2026-10-14T12:00:00", { blurScore: 80 }),
];

const page = (id: string, chapterId: string | null, layout: string, photoIds: string[]): BookPage => ({
  id,
  chapterId,
  layout,
  slots: photoIds.map((photoId) => ({ photoId, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
  caption: null,
});

function aiDoc(): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "cover", photoId: "a1", title: "Our UAE Weekend", subtitle: "Sun, sand and family" },
    chapters: [
      { id: "c1", title: "Beach mornings", dateLabel: "12 Oct 2026", place: "Saadiyat Beach" },
      { id: "c2", title: "Into the dunes", dateLabel: "14 Oct 2026", place: "Liwa" },
    ],
    pages: [
      page("p1", "c1", "one-portrait", ["a1"]),
      page("p2", "c1", "two-vertical", ["a2", "a3"]),
      page("p3", "c1", "two-horizontal", ["a4", "a5"]),
      page("p4", "c2", "three-mixed", ["b1", "b2", "b3"]),
    ],
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "classic", font: "Playfair" },
    meta: { generator: "ai", generatorVersion: 2, runId: RUN, userEdited: false },
  };
}

const drop = (photos: RelayoutPhoto[], ...ids: string[]) =>
  photos.map((p) => (ids.includes(p.id) ? { ...p, status: "dropped" as const } : p));

function expectValid(doc: BookDoc, photos: RelayoutPhoto[], maxPages = 20) {
  const parsed = parseBookDoc(doc);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const kept = new Set(photos.filter((p) => p.status === "kept").map((p) => p.id));
  expect(validateBookDoc(parsed.doc, { photoIds: kept, maxPages })).toEqual([]);
}
const photoIdsOf = (doc: BookDoc) => doc.pages.flatMap((p) => p.slots.map((s) => s.photoId));

describe("relayoutDoc — no-op", () => {
  it("returns the same doc object with changed:false when nothing changed", () => {
    const doc = aiDoc();
    const r = relayoutDoc(doc, BASE, OPTS);
    expect(r.changed).toBe(false);
    expect(r.doc).toBe(doc);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it("is a no-op for a doc without meta (M2 rule album) too", () => {
    const doc: BookDoc = aiDoc();
    delete doc.meta;
    const r = relayoutDoc(doc, BASE, OPTS);
    expect(r.changed).toBe(false);
    expect(r.doc.meta).toBeUndefined();
  });
});

describe("relayoutDoc — removals", () => {
  it("drop 1 photo → only that page is re-fitted (id kept), other pages untouched", () => {
    const doc = aiDoc();
    const photos = drop(BASE, "a2");
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.changed).toBe(true);
    expect(r.removed).toBe(1);
    expect(r.added).toBe(0);
    const p2 = r.doc.pages.find((p) => p.id === "p2")!;
    expect(p2.slots.map((s) => s.photoId)).toEqual(["a3"]);
    expect(getLayout(p2.layout)?.photoCount).toBe(1);
    expect(getLayout(p2.layout)?.role).toBe("page");
    expect(r.doc.pages.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(r.doc.pages[0]).toEqual(doc.pages[0]);
    expect(r.doc.pages[2]).toEqual(doc.pages[2]);
    expect(r.doc.pages[3]).toEqual(doc.pages[3]);
    expectValid(r.doc, photos);
  });

  it("a three-mixed page losing its landscape becomes two-vertical", () => {
    const photos = drop(BASE, "b1");
    const r = relayoutDoc(aiDoc(), photos, OPTS);
    const p4 = r.doc.pages.find((p) => p.id === "p4")!;
    expect(p4.layout).toBe("two-vertical");
    expect(p4.slots.map((s) => s.photoId)).toEqual(["b2", "b3"]);
    expectValid(r.doc, photos);
  });

  it("drop every photo of a page → the page is removed", () => {
    const photos = drop(BASE, "a4", "a5");
    const r = relayoutDoc(aiDoc(), photos, OPTS);
    expect(r.removed).toBe(2);
    expect(r.doc.pages.map((p) => p.id)).toEqual(["p1", "p2", "p4"]);
    expect(r.doc.chapters.map((c) => c.id)).toEqual(["c1", "c2"]);
    expectValid(r.doc, photos);
  });

  it("drop every photo of a chapter → the chapter is removed", () => {
    const photos = drop(BASE, "b1", "b2", "b3");
    const r = relayoutDoc(aiDoc(), photos, OPTS);
    expect(r.doc.chapters.map((c) => c.id)).toEqual(["c1"]);
    expect(r.doc.pages.every((p) => p.chapterId === "c1")).toBe(true);
    expectValid(r.doc, photos);
  });

  it("photos that no longer exist are removed like dropped ones", () => {
    const photos = BASE.filter((p) => p.id !== "a3");
    const r = relayoutDoc(aiDoc(), photos, OPTS);
    expect(photoIdsOf(r.doc)).not.toContain("a3");
    expectValid(r.doc, photos);
  });

  it("chapter place is cleared when no remaining photo has it; dateLabel recomputed", () => {
    const photos = drop(BASE, "b1", "b2"); // the Liwa photos
    const r = relayoutDoc(aiDoc(), photos, OPTS);
    const c2 = r.doc.chapters.find((c) => c.id === "c2")!;
    expect(c2.place).toBeNull();
    expect(c2.title).toBe("Into the dunes");
    expect(c2.dateLabel).toBe("14 Oct 2026");
  });
});

describe("relayoutDoc — cover", () => {
  it("a dropped cover photo is replaced by the best remaining (portrait, then sharpest)", () => {
    const photos = drop(BASE, "a1");
    const r = relayoutDoc(aiDoc(), photos, OPTS);
    expect(r.doc.cover.photoId).toBe("b3"); // portrait, blurScore 80
    expect(r.doc.cover.title).toBe("Our UAE Weekend");
    expect(r.doc.cover.subtitle).toBe("Sun, sand and family");
    expectValid(r.doc, photos);
  });

  it("every photo dropped → empty album with a null cover, still valid", () => {
    const photos = BASE.map((p) => ({ ...p, status: "dropped" as const }));
    const r = relayoutDoc(aiDoc(), photos, OPTS);
    expect(r.doc.pages).toEqual([]);
    expect(r.doc.chapters).toEqual([]);
    expect(r.doc.cover.photoId).toBeNull();
    expectValid(r.doc, photos);
  });
});

describe("relayoutDoc — additions", () => {
  it("adds 3 kept photos to the right chapters by time, after each chapter's last page", () => {
    const photos = [
      ...BASE,
      ph("n1", P, "2026-10-14T10:30:00"), // inside c2
      ph("n2", P, "2026-10-14T18:00:00"), // after c2 → nearest c2
      ph("n3", P, "2026-10-12T12:30:00"), // inside c1
    ];
    const doc = aiDoc();
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.changed).toBe(true);
    expect(r.added).toBe(3);
    expect(r.removed).toBe(0);
    // existing pages untouched and in place
    for (const old of doc.pages) expect(r.doc.pages.find((p) => p.id === old.id)).toEqual(old);
    const ids = r.doc.pages.map((p) => p.id);
    expect(ids.slice(0, 3)).toEqual(["p1", "p2", "p3"]);
    const c1New = r.doc.pages[3];
    expect(c1New.chapterId).toBe("c1");
    expect(c1New.slots.map((s) => s.photoId)).toEqual(["n3"]);
    expect(r.doc.pages[4].id).toBe("p4");
    const c2New = r.doc.pages.slice(5);
    expect(c2New.every((p) => p.chapterId === "c2")).toBe(true);
    expect(c2New.flatMap((p) => p.slots.map((s) => s.photoId))).toEqual(["n1", "n2"]);
    expect(c2New[0].layout).toBe("two-vertical");
    expect(new Set(ids).size).toBe(ids.length);
    expectValid(r.doc, photos);
  });

  it("a photo before every chapter goes to the nearest (first) chapter", () => {
    const photos = [...BASE, ph("n1", L, "2026-10-01T09:00:00")];
    const r = relayoutDoc(aiDoc(), photos, OPTS);
    const np = r.doc.pages.find((p) => p.slots.some((s) => s.photoId === "n1"))!;
    expect(np.chapterId).toBe("c1");
    expect(r.doc.chapters.find((c) => c.id === "c1")!.dateLabel).toBe("1–12 Oct 2026");
  });

  it("undated photos with no undated chapter → a new trailing chapter 'More moments'", () => {
    const photos = [...BASE, ph("u1", P, null), ph("u2", P, null)];
    const r = relayoutDoc(aiDoc(), photos, OPTS);
    const last = r.doc.chapters[r.doc.chapters.length - 1];
    expect(last.title).toBe(MORE_MOMENTS_TITLE);
    expect(last.id).toBe("c3");
    expect(last.dateLabel).toBe("");
    const tail = r.doc.pages.filter((p) => p.chapterId === last.id);
    expect(tail.flatMap((p) => p.slots.map((s) => s.photoId))).toEqual(["u1", "u2"]);
    expect(r.doc.pages[r.doc.pages.length - 1].chapterId).toBe(last.id);
    expectValid(r.doc, photos);
  });

  it("the cover photo is not added again when it is on no page", () => {
    const doc = aiDoc();
    doc.cover.photoId = "b2";
    doc.pages[3] = page("p4", "c2", "two-horizontal", ["b1", "b3"]);
    const r = relayoutDoc(doc, BASE, OPTS);
    expect(r.changed).toBe(false);
  });

  it("drop + add in one pass", () => {
    const photos = [...drop(BASE, "a2", "a3"), ph("n1", L, "2026-10-12T15:00:00")];
    const r = relayoutDoc(aiDoc(), photos, OPTS);
    expect(r.removed).toBe(2);
    expect(r.added).toBe(1);
    expect(r.doc.pages.map((p) => p.id)).toEqual(["p1", "p3", "p5", "p4"]);
    expectValid(r.doc, photos);
  });
});

describe("relayoutDoc — page cap", () => {
  it("respects books.max_pages: drops the blurriest new photos first", () => {
    const photos = [
      ...BASE,
      ph("n1", P, "2026-10-14T13:00:00", { blurScore: 5 }),
      ph("n2", L, "2026-10-14T14:00:00", { blurScore: 95 }),
      ph("n3", P, "2026-10-14T15:00:00", { blurScore: 1 }),
      ph("n4", L, "2026-10-14T16:00:00", { blurScore: 70 }),
      ph("n5", P, "2026-10-14T17:00:00", { blurScore: 2 }),
    ];
    const r = relayoutDoc(aiDoc(), photos, { ...OPTS, maxPages: 5 });
    expect(r.doc.pages.length).toBeLessThanOrEqual(5);
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.added + r.skipped).toBe(5);
    const placed = photoIdsOf(r.doc);
    // original photos all kept
    for (const p of BASE) expect(placed).toContain(p.id);
    // the sharpest new one survives, the blurriest goes first
    expect(placed).toContain("n2");
    expect(placed).not.toContain("n3");
    expectValid(r.doc, photos, 5);
  });

  it("free cap (20) applies even when books.max_pages is higher", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      ph(`m${String(i).padStart(2, "0")}`, L, `2026-10-14T${String(13 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00`),
    );
    const photos = [...BASE, ...many];
    const r = relayoutDoc(aiDoc(), photos, { ...OPTS, maxPages: 100 });
    expect(r.doc.pages.length).toBeLessThanOrEqual(20);
    expectValid(r.doc, photos, 20);
  });

  it("existing pages over a shrunk cap → trailing pages removed (unavoidable)", () => {
    const r = relayoutDoc(aiDoc(), BASE, { ...OPTS, maxPages: 2 });
    expect(r.changed).toBe(true);
    expect(r.doc.pages.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(r.doc.chapters.map((c) => c.id)).toEqual(["c1"]);
    expectValid(r.doc, BASE, 2);
  });
});

describe("relayoutDoc — invariants", () => {
  it("is deterministic regardless of photo input order", () => {
    const photos = [...drop(BASE, "a2", "a1"), ph("n1", P, "2026-10-14T10:30:00"), ph("n2", L, null), ph("n3", P, "2026-10-13T09:00:00")];
    const a = relayoutDoc(aiDoc(), photos, OPTS);
    const b = relayoutDoc(aiDoc(), [...photos].reverse(), OPTS);
    expect(JSON.stringify(b.doc)).toBe(JSON.stringify(a.doc));
    expect(b.added).toBe(a.added);
    expect(b.removed).toBe(a.removed);
  });

  it("keeps AI meta, title, subtitle, style, occasion and chapter titles", () => {
    const doc = aiDoc();
    const photos = [...drop(BASE, "a1", "b1"), ph("n1", P, "2026-10-14T10:30:00")];
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.doc.meta).toEqual({ generator: "ai", generatorVersion: 2, runId: RUN, userEdited: false });
    expect(r.doc.cover.title).toBe(doc.cover.title);
    expect(r.doc.cover.subtitle).toBe(doc.cover.subtitle);
    expect(r.doc.style).toEqual(doc.style);
    expect(r.doc.occasion).toBe("travel");
    expect(r.doc.chapters.map((c) => c.title)).toEqual(["Beach mornings", "Into the dunes"]);
    expectValid(r.doc, photos);
  });

  it("a second pass over its own output is a no-op", () => {
    const photos = [...drop(BASE, "a4"), ph("n1", P, "2026-10-14T10:30:00"), ph("u1", P, null)];
    const first = relayoutDoc(aiDoc(), photos, OPTS);
    const second = relayoutDoc(first.doc, photos, OPTS);
    expect(second.changed).toBe(false);
  });

  it("does not mutate the input doc", () => {
    const doc = aiDoc();
    const before = JSON.stringify(doc);
    relayoutDoc(doc, [...drop(BASE, "a2", "a1"), ph("n1", P, "2026-10-14T10:30:00")], OPTS);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("refit pages drop AI captions but keep a user caption when the layout has room", () => {
    const doc = aiDoc();
    doc.pages[1] = { ...doc.pages[1], caption: { text: "x", font: "Playfair", align: "center", source: "ai" } };
    doc.pages[3] = { ...doc.pages[3], caption: { text: "y", font: "Playfair", align: "center", source: "user" } };
    const photos = drop(BASE, "a2", "b1");
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.doc.pages.find((p) => p.id === "p2")!.caption).toBeNull();
    expect(r.doc.pages.find((p) => p.id === "p4")!.caption?.source).toBe("user");
    expectValid(r.doc, photos);
  });
});

describe("relayoutDoc — captions (D-031)", () => {
  const cap = (text: string, source: "ai" | "user" | "auto") => ({ text, font: "Playfair" as const, align: "center" as const, source });
  /** Every page captioned: p1 AI, p2 AI, p3 user, p4 user. */
  function captionedDoc(): BookDoc {
    const doc = aiDoc();
    doc.pages[0] = { ...doc.pages[0], caption: cap("Morning light on the water", "ai") };
    doc.pages[1] = { ...doc.pages[1], caption: cap("Shells and sandcastles", "ai") };
    doc.pages[2] = { ...doc.pages[2], caption: cap("Best day of the trip", "user") };
    doc.pages[3] = { ...doc.pages[3], caption: cap("Dunes forever", "user") };
    return doc;
  }

  it("AI and user captions on untouched pages are kept exactly", () => {
    const doc = captionedDoc();
    const photos = drop(BASE, "a2"); // only p2 is re-fitted
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.changed).toBe(true);
    const byId = (id: string) => r.doc.pages.find((p) => p.id === id)!;
    expect(byId("p1").caption).toEqual(cap("Morning light on the water", "ai"));
    expect(byId("p3").caption).toEqual(cap("Best day of the trip", "user"));
    expect(byId("p4").caption).toEqual(cap("Dunes forever", "user"));
    expect(byId("p2").caption).toBeNull(); // AI caption on a re-fitted page goes
    expectValid(r.doc, photos);
  });

  it("re-fitted page keeps a user caption when the new layout has a caption area; AI caption dropped", () => {
    const doc = captionedDoc();
    const photos = drop(BASE, "a5", "b1"); // p3 → 1 photo (user), p4 → 2 photos (user)
    const r = relayoutDoc(doc, photos, OPTS);
    const p3 = r.doc.pages.find((p) => p.id === "p3")!;
    const p4 = r.doc.pages.find((p) => p.id === "p4")!;
    expect(getLayout(p3.layout)?.caption).not.toBeNull();
    expect(p3.caption).toEqual(cap("Best day of the trip", "user"));
    expect(getLayout(p4.layout)?.caption).not.toBeNull();
    expect(p4.caption).toEqual(cap("Dunes forever", "user"));
    expectValid(r.doc, photos);
  });

  it("an 'auto' caption on a re-fitted page is dropped like an AI one", () => {
    const doc = captionedDoc();
    doc.pages[1] = { ...doc.pages[1], caption: cap("12 Oct 2026", "auto") };
    const r = relayoutDoc(doc, drop(BASE, "a3"), OPTS);
    expect(r.doc.pages.find((p) => p.id === "p2")!.caption).toBeNull();
  });

  it("new pages get caption null; existing captions and chapter titles kept", () => {
    const doc = captionedDoc();
    const photos = [...BASE, ph("n1", P, "2026-10-14T10:30:00"), ph("u1", P, null)];
    const r = relayoutDoc(doc, photos, OPTS);
    const oldIds = new Set(doc.pages.map((p) => p.id));
    const fresh = r.doc.pages.filter((p) => !oldIds.has(p.id));
    expect(fresh.length).toBeGreaterThan(0);
    for (const p of fresh) expect(p.caption).toBeNull();
    for (const old of doc.pages) expect(r.doc.pages.find((p) => p.id === old.id)).toEqual(old);
    expect(r.doc.chapters.slice(0, 2).map((c) => c.title)).toEqual(["Beach mornings", "Into the dunes"]);
    expectValid(r.doc, photos);
  });

  it("chapter titles kept when captioned pages are re-fitted or removed", () => {
    const doc = captionedDoc();
    const photos = drop(BASE, "a2", "a4", "a5", "b3");
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.doc.chapters.map((c) => c.title)).toEqual(["Beach mornings", "Into the dunes"]);
    expect(r.doc.pages.map((p) => p.id)).toEqual(["p1", "p2", "p4"]);
    expect(r.doc.pages[0].caption?.source).toBe("ai");
    expect(r.doc.pages[1].caption).toBeNull();
    expect(r.doc.pages[2].caption).toEqual(cap("Dunes forever", "user"));
    expectValid(r.doc, photos);
  });
});

describe("relayoutDoc — user caption on a page re-fitted to one photo (D-031)", () => {
  it("prefers a captioned layout (one-portrait over full-page) so the user's caption survives", () => {
    const doc = aiDoc();
    const mine = { text: "Our favourite corner", font: "Playfair" as const, align: "center" as const, source: "user" as const };
    doc.pages[1] = { ...doc.pages[1], caption: mine };
    doc.pages[2] = { ...doc.pages[2], caption: { ...mine, source: "ai" as const } };
    const photos = drop(BASE, "a2", "a5");
    const r = relayoutDoc(doc, photos, OPTS);
    const p2 = r.doc.pages.find((p) => p.id === "p2")!;
    expect(p2.layout).toBe("one-portrait");
    expect(p2.caption).toEqual(mine);
    // without a user caption the plain best fit (catalogue order) is unchanged
    const p3 = r.doc.pages.find((p) => p.id === "p3")!;
    expect(p3.layout).toBe("full-page");
    expect(p3.caption).toBeNull();
    expectValid(r.doc, photos);
    expect(relayoutDoc(r.doc, photos, OPTS).changed).toBe(false);
  });
});

describe("relayoutDoc — photo backgrounds (M10a review B1, D-062)", () => {
  const BG = "44444444-4444-4444-8444-444444444444";
  const BG2 = "55555555-5555-4555-8555-555555555555";
  const photoBg = (photoId: string) => ({ kind: "photo" as const, photoId, veil: 0.75, veilColor: "#FFFFFF" });
  const WITH_BG = [...BASE, ph(BG, L, "2026-10-12T15:00:00"), ph(BG2, P, "2026-10-14T13:00:00")];
  // BG and BG2 sit on a page; BG is also the book default, BG2 a page override on p1.
  function bgDoc(): BookDoc {
    const d = aiDoc();
    d.pages.push(page("p5", "c1", "one-landscape", [BG]), page("p6", "c2", "one-portrait", [BG2]));
    d.style = { ...d.style, background: photoBg(BG) };
    d.pages[0] = { ...d.pages[0], background: { ...photoBg(BG2), source: "user" } };
    return d;
  }
  const expectValidBg = (doc: BookDoc, photos: RelayoutPhoto[]) => {
    const parsed = parseBookDoc(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const kept = new Set(photos.filter((p) => p.status === "kept").map((p) => p.id));
    expect(validateBookDoc(parsed.doc, { photoIds: kept, backgroundPhotoIds: new Set(photos.map((p) => p.id)), maxPages: 20 })).toEqual([]);
  };

  it("a dropped photo used as book + page background survives Update album (slots removed, backgrounds kept)", () => {
    const photos = drop(WITH_BG, BG, BG2);
    const r = relayoutDoc(bgDoc(), photos, OPTS);
    expect(r.changed).toBe(true);
    expect(photoIdsOf(r.doc)).not.toContain(BG);
    expect(photoIdsOf(r.doc)).not.toContain(BG2);
    expect(r.doc.style.background).toEqual(photoBg(BG));
    expect(r.doc.pages.find((p) => p.id === "p1")?.background).toEqual({ ...photoBg(BG2), source: "user" });
    expectValidBg(r.doc, photos);
  });

  it("a background photo that was already dropped keeps working on later passes (no-op)", () => {
    const d = aiDoc();
    d.style = { ...d.style, background: photoBg(BG) };
    d.pages[1] = { ...d.pages[1], background: { ...photoBg(BG), source: "user" } };
    const photos = drop(WITH_BG, BG);
    // BG2 is kept but not on a page → it gets added; BG stays a background only.
    const r = relayoutDoc(d, photos, OPTS);
    expect(r.doc.style.background).toEqual(photoBg(BG));
    expect(r.doc.pages[1].background).toEqual({ ...photoBg(BG), source: "user" });
    expectValidBg(r.doc, photos);
    const again = relayoutDoc(r.doc, photos, OPTS);
    expect(again.changed).toBe(false);
    expect(again.doc).toBe(r.doc);
  });

  it("a deleted background photo → backgrounds removed (book default white, override gone), relayout succeeds", () => {
    const photos = WITH_BG.filter((p) => p.id !== BG && p.id !== BG2);
    const r = relayoutDoc(bgDoc(), photos, OPTS);
    expect(r.changed).toBe(true);
    expect(r.doc.style.background).toEqual({ kind: "color", hex: "#FFFFFF" });
    const p1 = r.doc.pages.find((p) => p.id === "p1");
    expect(p1 && "background" in p1).toBe(false);
    expectValidBg(r.doc, photos);
  });

  it("a deleted background-only photo (on no page) alone is a change", () => {
    const d = aiDoc();
    d.pages[2] = { ...d.pages[2], background: { ...photoBg(BG), source: "ai" } };
    const r = relayoutDoc(d, BASE, OPTS);
    expect(r.changed).toBe(true);
    expect(r.added + r.removed).toBe(0);
    expect(r.doc.pages[2].background).toBeUndefined();
    expect(r.doc.pages[2].slots).toEqual(d.pages[2].slots);
  });

  it("non-photo backgrounds are untouched", () => {
    const d = aiDoc();
    d.style = { ...d.style, background: { kind: "texture", textureId: "kraft" } };
    d.pages[0] = { ...d.pages[0], background: { kind: "color", hex: "#1E2A47", source: "user" } };
    const r = relayoutDoc(d, BASE, OPTS);
    expect(r.changed).toBe(false);
    expect(r.doc).toBe(d);
  });
});
