// M20 T9 (D-072): entry points into the continuous wizard. /books/[id]/upload and /books/[id]/build
// redirect fresh books into /books/new?book=<id>&step=3|6|7 (Task 5 order: 3 = Photos) and keep the classic screens for built,
// edited and rebuilding books (M20b: AI off goes through the wizard's steps 6–7 too); createBookAction's `next` and the dashboard's fresh-draft
// links point straight into the wizard. Pure decision helpers (src/lib/books/wizard-routes.ts) plus a
// small route simulator proving the build page and the /books/new gate never redirect in a loop.
import { describe, expect, it } from "vitest";
import { devPreviewDoc } from "@/lib/book/dev-preview";
import { docOrigin } from "@/lib/book/replaceable";
import { parseBookDoc } from "@/lib/book/schema";
import { detailsLockReason } from "@/lib/book/setup";
import {
  buildEntryRedirect,
  resolveWizardStep,
  uploadEntryRedirect,
  wizardStepHref,
  type BuildEntryInput,
  type WizardTarget,
} from "@/lib/books/wizard-routes";
import { bookCardHref } from "@/lib/dashboard/card-target";
import { editorRedirect } from "@/lib/editor/page-data";
import { albumEditedByUser } from "@/lib/review/ui";
import type { FirstRunState } from "@/lib/upload/auto-build-client";

const BOOK = "33333333-3333-4333-8333-333333333333";

const rule = { ...devPreviewDoc(), meta: { generator: "rule" as const, generatorVersion: 1, runId: null, userEdited: false } };
const ai = { ...rule, meta: { ...rule.meta, generator: "ai" as const } };
const edited = { ...rule, meta: { ...rule.meta, userEdited: true } };
const empty = {};
const DOCS = { empty, rule, ai, edited } as const;

// --- world model -----------------------------------------------------------------------------------

type World = {
  doc: unknown;
  aiOn: boolean;
  /** Active build run (null = none). */
  active: { trigger: "build" | "rebuild" } | null;
  /** Any agent_runs row exists (finished or active). */
  runExists: boolean;
  activeReadOk: boolean;
  runReadOk: boolean;
  /** books.album_confirmed_at is set (M20c: "Generate album" ran). */
  confirmed: boolean;
  /** Upload-finished photos (the editor's empty-album redirect). */
  photos: number;
};

const world = (w: Partial<World> = {}): World => ({
  doc: empty,
  aiOn: true,
  active: null,
  runExists: false,
  activeReadOk: true,
  runReadOk: true,
  confirmed: false,
  photos: 3,
  ...w,
});

/** What the build page passes to buildEntryRedirect for this world + query. */
function buildInput(w: World, q: { trigger?: "build" | "rebuild"; auto?: boolean } = {}): BuildEntryInput {
  const trigger = q.trigger ?? "build";
  const active = w.activeReadOk ? w.active : null;
  // The page reads hasAnyRunForBook for trigger=build, AI on or off (M20b; null otherwise / on error).
  const runExists = trigger === "build" && w.runReadOk ? w.runExists || w.active !== null : null;
  return {
    bookId: BOOK,
    trigger,
    auto: q.auto === true,
    aiOn: w.aiOn,
    doc: w.doc,
    detailsLock: detailsLockReason({ hasRun: runExists === true || active !== null, doc: w.doc }),
    userEdited: albumEditedByUser(w.doc),
    activeReadOk: w.activeReadOk,
    active,
    runExists,
    albumConfirmed: w.confirmed,
  };
}

/** The upload page's inputs (read errors count as "no run" there). */
function uploadTarget(w: World): string | null {
  const hasRun = w.runReadOk ? w.runExists || w.active !== null : false;
  const active = w.activeReadOk ? w.active : null;
  const firstRun: FirstRunState = active ? "active" : hasRun ? "done" : "none";
  return uploadEntryRedirect({
    bookId: BOOK,
    firstRun,
    detailsLock: detailsLockReason({ hasRun, doc: w.doc }),
    albumConfirmed: w.confirmed,
  });
}

/**
 * /books/new?book=&step=1…7 hard load: the gate as loadWizardStep computes it (wizard-data.ts) —
 * steps 1–5 from the Photos step's reads (with the book's photo count), 6 / 7 from their own.
 */
function wizardGate(w: World, step: 1 | 2 | 3 | 4 | 5 | 6 | 7): WizardTarget {
  const active = w.activeReadOk ? w.active : null;
  const hasRunRead = w.runReadOk ? w.runExists || w.active !== null : step === 7 ? true : false;
  const hasRun = hasRunRead || active !== null;
  return resolveWizardStep({
    requested: step,
    hasRun,
    active: active !== null,
    activeTrigger: active?.trigger ?? null,
    readError: step === 7 ? false : !w.activeReadOk || !w.runReadOk,
    detailsLock: detailsLockReason({ hasRun, doc: w.doc }),
    docOrigin: { generator: docOrigin(w.doc).generator, userEdited: albumEditedByUser(w.doc) },
    albumConfirmed: w.confirmed,
    aiOn: w.aiOn,
    photoCount: step <= 5 ? w.photos : undefined,
  });
}

/**
 * /books/[id]/edit (M20c: modelled, so confirmed worlds prove editor ↔ wizard never loops): the
 * editor's own redirect (editorRedirect) — a running build → /build, an empty album → upload / build
 * (wizard hrefs only for a never-built, unconfirmed book). The editor's reads: the active run as
 * stored (its read throws instead of guessing), hasBuildRun read error → true.
 */
function editorTarget(w: World): string | null {
  const isEmpty = typeof w.doc === "object" && w.doc !== null && Object.keys(w.doc).length === 0;
  const docError = isEmpty ? ("empty" as const) : parseBookDoc(w.doc).ok ? null : ("invalid" as const);
  return editorRedirect({
    book: { id: BOOK } as never,
    activeBuildRunId: w.active ? "run" : null,
    docError,
    photos: Array.from({ length: w.photos }, () => ({}) as never),
    hasBuildRun: w.runReadOk ? w.runExists || w.active !== null : true,
    aiMode: w.aiOn ? "live" : "off",
    albumConfirmed: w.confirmed,
  } as Parameters<typeof editorRedirect>[0]);
}

type Screen =
  | { kind: "wizard"; step: number }
  | { kind: "classic-build" }
  | { kind: "classic-upload" }
  | { kind: "editor" };

/**
 * Follows server redirects from a URL until a page renders. Throws on a loop (or > 6 hops).
 * `editor`: model the editor's own redirect (default: confirmed worlds only — the pre-M20c
 * assertions treat the editor as terminal).
 */
function follow(
  w: World,
  start: string,
  opts: { editor?: boolean } = {},
): { screen: Screen; hops: string[] } {
  const modelEditor = opts.editor ?? w.confirmed;
  const hops: string[] = [];
  let url = start;
  for (let i = 0; i < 6; i++) {
    if (hops.includes(url)) throw new Error(`redirect loop: ${[...hops, url].join(" → ")}`);
    hops.push(url);
    const u = new URL(url, "https://x.test");
    if (u.pathname === `/books/${BOOK}/edit`) {
      const to = modelEditor ? editorTarget(w) : null;
      if (!to) return { screen: { kind: "editor" }, hops };
      url = to;
      continue;
    }
    if (u.pathname === `/books/${BOOK}/upload`) {
      const to = uploadTarget(w);
      if (!to) return { screen: { kind: "classic-upload" }, hops };
      url = to;
      continue;
    }
    if (u.pathname === `/books/${BOOK}/build`) {
      const trigger = u.searchParams.get("trigger") === "rebuild" ? "rebuild" : "build";
      const entry = buildEntryRedirect(buildInput(w, { trigger, auto: u.searchParams.get("auto") === "1" }));
      if (entry.kind === "classic") return { screen: { kind: "classic-build" }, hops };
      url = entry.kind === "editor" ? `/books/${BOOK}/edit` : entry.href;
      continue;
    }
    if (u.pathname === "/books/new") {
      // M20c: the page sends a confirmed book to the editor for any step (1–7) before the gate.
      if (w.confirmed) {
        url = `/books/${BOOK}/edit`;
        continue;
      }
      // The page (resolveBookStep): gate the asked step; when the gate moves the book to another
      // data step it loads that one in the same request (no extra redirect).
      let step = Number(u.searchParams.get("step")) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
      let target = wizardGate(w, step);
      for (let j = 0; j < 2 && typeof target === "number" && target >= 6 && target !== step; j++) {
        step = target as 6 | 7;
        target = wizardGate(w, step);
      }
      if (target === "editor") url = `/books/${BOOK}/edit`;
      else if (target === "classic") url = `/books/${BOOK}/build`;
      else return { screen: { kind: "wizard", step: target }, hops };
      continue;
    }
    throw new Error(`unexpected url ${url}`);
  }
  throw new Error(`too many hops: ${hops.join(" → ")}`);
}

// --- helpers -----------------------------------------------------------------------------------------

describe("wizardStepHref", () => {
  it("builds /books/new?book=<id>&step=N, &auto=1 only when asked", () => {
    expect(wizardStepHref(BOOK, 3)).toBe(`/books/new?book=${BOOK}&step=3`);
    expect(wizardStepHref(BOOK, 5)).toBe(`/books/new?book=${BOOK}&step=5`);
    expect(wizardStepHref(BOOK, 6, { auto: true })).toBe(`/books/new?book=${BOOK}&step=6&auto=1`);
    expect(wizardStepHref(BOOK, 7, { auto: false })).toBe(`/books/new?book=${BOOK}&step=7`);
  });
});

// --- upload ------------------------------------------------------------------------------------------

describe("/books/[id]/upload entry", () => {
  it("fresh book (no run, details unlocked) → wizard step 3 (Photos)", () => {
    expect(uploadTarget(world())).toBe(wizardStepHref(BOOK, 3));
    expect(uploadTarget(world({ doc: rule }))).toBe(wizardStepHref(BOOK, 3));
    // run read error = "no run" on this page (the wizard gate agrees for step 3)
    expect(uploadTarget(world({ runReadOk: false, activeReadOk: false }))).toBe(wizardStepHref(BOOK, 3));
    expect(follow(world(), `/books/${BOOK}/upload`).screen).toEqual({ kind: "wizard", step: 3 });
    expect(follow(world({ photos: 0 }), `/books/${BOOK}/upload`).screen).toEqual({ kind: "wizard", step: 3 });
  });

  it("built (run exists / running / AI album) → classic add-more-photos screen", () => {
    expect(uploadTarget(world({ runExists: true, doc: ai }))).toBeNull();
    expect(uploadTarget(world({ active: { trigger: "build" }, runExists: true, doc: rule }))).toBeNull();
    expect(uploadTarget(world({ doc: ai }))).toBeNull();
  });

  it("user-edited → classic (never the wizard)", () => {
    expect(uploadTarget(world({ doc: edited }))).toBeNull();
    expect(uploadTarget(world({ doc: edited, runExists: true }))).toBeNull();
  });

  it("AI off: a fresh book uses the wizard's photo step", () => {
    expect(uploadTarget(world({ aiOn: false }))).toBe(wizardStepHref(BOOK, 3));
  });
});

// --- build -------------------------------------------------------------------------------------------

describe("/books/[id]/build entry", () => {
  const go = (w: World, q: { trigger?: "build" | "rebuild"; auto?: boolean } = {}) => buildEntryRedirect(buildInput(w, q));

  it("fresh first build (no run yet / first run active) → wizard step 6, &auto=1 kept", () => {
    expect(go(world())).toEqual({ kind: "wizard", href: wizardStepHref(BOOK, 6) });
    expect(go(world({ doc: rule }))).toEqual({ kind: "wizard", href: wizardStepHref(BOOK, 6) });
    expect(go(world({ doc: rule, active: { trigger: "build" }, runExists: true }), { auto: true })).toEqual({
      kind: "wizard",
      href: wizardStepHref(BOOK, 6, { auto: true }),
    });
    // unknown run state (read error) → step 6 too: StepSorting POSTs and the server answers 409 for a queued run
    expect(go(world({ doc: rule, activeReadOk: false }), { auto: true })).toEqual({
      kind: "wizard",
      href: wizardStepHref(BOOK, 6, { auto: true }),
    });
    expect(go(world({ runReadOk: false }))).toEqual({ kind: "wizard", href: wizardStepHref(BOOK, 6) });
  });

  it("?auto=1 with no active run: gate says Review → step 7; otherwise the editor (as before)", () => {
    expect(go(world({ doc: ai, runExists: true }), { auto: true })).toEqual({ kind: "wizard", href: wizardStepHref(BOOK, 7) });
    expect(go(world({ doc: rule, runExists: true }), { auto: true })).toEqual({ kind: "wizard", href: wizardStepHref(BOOK, 7) });
    // edited meanwhile → editor
    expect(go(world({ doc: edited, runExists: true }), { auto: true })).toEqual({ kind: "editor" });
    // no run at all (auto link without a run) → editor, never a fresh POST from an auto link
    expect(go(world({ doc: rule }), { auto: true })).toEqual({ kind: "editor" });
    // run-exists read failed → not provably Review → editor
    expect(go(world({ doc: ai, runExists: true, runReadOk: false }), { auto: true })).toEqual({ kind: "editor" });
  });

  it("built book (AI album, finished run) without ?auto → classic, as before M20", () => {
    expect(go(world({ doc: ai, runExists: true }))).toEqual({ kind: "classic" });
    // rule album after a finished run (e.g. the AI fell back) → classic (gate 7 ≠ 6), never auto-review
    expect(go(world({ doc: rule, runExists: true }))).toEqual({ kind: "classic" });
  });

  it("rebuild (?trigger=rebuild, Try AI again) → classic, whatever the album", () => {
    for (const doc of Object.values(DOCS)) {
      expect(go(world({ doc }), { trigger: "rebuild" })).toEqual({ kind: "classic" });
      expect(go(world({ doc, runExists: true, active: { trigger: "rebuild" } }), { trigger: "rebuild" })).toEqual({ kind: "classic" });
    }
    // a finished auto link on a rebuild keeps the M13 rule (editor)
    expect(go(world({ doc: rule, runExists: true }), { trigger: "rebuild", auto: true })).toEqual({ kind: "editor" });
  });

  it("running rebuild opened without ?trigger → classic (the wizard gate's 'classic')", () => {
    for (const doc of [rule, ai, empty]) {
      expect(go(world({ doc, runExists: true, active: { trigger: "rebuild" } }))).toEqual({ kind: "classic" });
    }
  });

  it("M20b: AI off behaves like AI on — a fresh first (rule) build → wizard step 6, finished → 7", () => {
    for (const doc of [empty, rule]) {
      expect(go(world({ doc, aiOn: false }))).toEqual({ kind: "wizard", href: wizardStepHref(BOOK, 6) });
      expect(go(world({ doc, aiOn: false, active: { trigger: "build" }, runExists: true }), { auto: true })).toEqual({
        kind: "wizard",
        href: wizardStepHref(BOOK, 6, { auto: true }),
      });
    }
    // the rule build already finished inside the POST → Review, not the editor
    expect(go(world({ doc: rule, aiOn: false, runExists: true }), { auto: true })).toEqual({
      kind: "wizard",
      href: wizardStepHref(BOOK, 7),
    });
    // built / edited / rebuilding books stay classic with AI off too
    expect(go(world({ doc: rule, aiOn: false, runExists: true }))).toEqual({ kind: "classic" });
    expect(go(world({ doc: edited, aiOn: false }))).toEqual({ kind: "classic" });
    expect(go(world({ doc: rule, aiOn: false }), { trigger: "rebuild" })).toEqual({ kind: "classic" });
  });

  it("user-edited album → classic (no ?auto) / editor (?auto)", () => {
    expect(go(world({ doc: edited }))).toEqual({ kind: "classic" });
    expect(go(world({ doc: edited, runExists: true, active: { trigger: "build" } }))).toEqual({ kind: "classic" });
    expect(go(world({ doc: edited, runExists: true }), { auto: true })).toEqual({ kind: "editor" });
    // unparsable doc counts as edited
    expect(go(world({ doc: { pages: "nope" } }))).toEqual({ kind: "classic" });
  });
});

// --- no loops ------------------------------------------------------------------------------------------

describe("no redirect loops between /books/new and /books/[id]/build", () => {
  const worlds: World[] = [];
  for (const doc of Object.values(DOCS))
    for (const aiOn of [true, false])
      for (const active of [null, { trigger: "build" as const }, { trigger: "rebuild" as const }])
        for (const runExists of [false, true])
          for (const activeReadOk of [true, false])
            for (const runReadOk of [true, false]) {
              if (active && !runExists) continue; // an active run is a run
              worlds.push(world({ doc, aiOn, active, runExists, activeReadOk, runReadOk }));
            }

  const starts = [
    `/books/${BOOK}/build`,
    `/books/${BOOK}/build?auto=1`,
    `/books/${BOOK}/build?trigger=rebuild`,
    `/books/${BOOK}/build?trigger=rebuild&auto=1`,
    `/books/${BOOK}/upload`,
    `/books/new?book=${BOOK}&step=1`,
    `/books/new?book=${BOOK}&step=2`,
    `/books/new?book=${BOOK}&step=3`,
    `/books/new?book=${BOOK}&step=4`,
    `/books/new?book=${BOOK}&step=5`,
    `/books/new?book=${BOOK}&step=6`,
    `/books/new?book=${BOOK}&step=6&auto=1`,
    `/books/new?book=${BOOK}&step=7`,
  ];

  it(`every world × entry URL settles in ≤ 3 page loads (${worlds.length} worlds)`, () => {
    for (const w of worlds) {
      for (const start of starts) {
        const { hops } = follow(w, start);
        expect(hops.length, `${start} in ${JSON.stringify({ ...w, doc: docOrigin(w.doc) })}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it("gate 'classic' (running rebuild only) → /build renders classic, no bounce back", () => {
    const rebuilding = world({ doc: rule, runExists: true, active: { trigger: "rebuild" } });
    expect(wizardGate(rebuilding, 6)).toBe("classic");
    expect(follow(rebuilding, `/books/new?book=${BOOK}&step=6`)).toEqual({
      screen: { kind: "classic-build" },
      hops: [`/books/new?book=${BOOK}&step=6`, `/books/${BOOK}/build`],
    });

    // M20b: AI off is no longer "classic" — the first rule build renders wizard step 6 directly
    const aiOff = world({ doc: rule, aiOn: false });
    expect(wizardGate(aiOff, 6)).toBe(6);
    expect(follow(aiOff, `/books/new?book=${BOOK}&step=6`)).toEqual({
      screen: { kind: "wizard", step: 6 },
      hops: [`/books/new?book=${BOOK}&step=6`],
    });
    expect(follow(aiOff, `/books/${BOOK}/build`)).toEqual({
      screen: { kind: "wizard", step: 6 },
      hops: [`/books/${BOOK}/build`, `/books/new?book=${BOOK}&step=6`],
    });
    // a running AI-off first build: step 6 resumes it; a finished one: step 7
    const aiOffRunning = world({ doc: rule, aiOn: false, active: { trigger: "build" }, runExists: true });
    expect(follow(aiOffRunning, `/books/new?book=${BOOK}&step=6`).screen).toEqual({ kind: "wizard", step: 6 });
    const aiOffDone = world({ doc: rule, aiOn: false, runExists: true });
    expect(follow(aiOffDone, `/books/new?book=${BOOK}&step=6`).screen).toEqual({ kind: "wizard", step: 7 });
    expect(follow(aiOffDone, `/books/new?book=${BOOK}&step=7`).hops).toHaveLength(1);
  });

  it("M20b: no world ever answers 'classic' on /books/new except a running rebuild", () => {
    for (const w of worlds) {
      for (const step of [5, 6, 7] as const) {
        if (wizardGate(w, step) === "classic") expect(w.activeReadOk && w.active?.trigger).toBe("rebuild");
      }
    }
  });

  it("build → wizard lands on a rendered wizard step (never bounced back to /build)", () => {
    const fresh = world({ doc: rule });
    expect(follow(fresh, `/books/${BOOK}/build`)).toEqual({
      screen: { kind: "wizard", step: 6 },
      hops: [`/books/${BOOK}/build`, `/books/new?book=${BOOK}&step=6`],
    });
    const running = world({ doc: rule, runExists: true, active: { trigger: "build" } });
    expect(follow(running, `/books/${BOOK}/build?auto=1`).screen).toEqual({ kind: "wizard", step: 6 });
    const finished = world({ doc: ai, runExists: true });
    expect(follow(finished, `/books/${BOOK}/build?auto=1`)).toEqual({
      screen: { kind: "wizard", step: 7 },
      hops: [`/books/${BOOK}/build?auto=1`, `/books/new?book=${BOOK}&step=7`],
    });
  });

  it("whenever the build page redirects into the wizard, the wizard renders that same step", () => {
    for (const w of worlds) {
      for (const q of [{}, { auto: true }]) {
        const entry = buildEntryRedirect(buildInput(w, q));
        if (entry.kind !== "wizard") continue;
        const step = Number(new URL(entry.href, "https://x.test").searchParams.get("step")) as 6 | 7;
        expect(wizardGate(w, step)).toBe(step);
      }
    }
  });

  it("Try AI again (?trigger=rebuild) never enters the wizard", () => {
    for (const w of worlds) {
      const r = follow(w, `/books/${BOOK}/build?trigger=rebuild`);
      expect(r.screen).toEqual({ kind: "classic-build" });
      expect(r.hops).toHaveLength(1);
    }
  });
});

// --- other entry points ----------------------------------------------------------------------------------

describe("other entry points (one hop)", () => {
  it("dashboard: fresh drafts open the wizard directly; running builds keep /build", () => {
    const card = { id: BOOK, page_count: 0, photo_count: 0, ai_status: "idle", user_edited: false };
    expect(bookCardHref(card)).toBe(wizardStepHref(BOOK, 3));
    expect(bookCardHref({ ...card, photo_count: 5 })).toBe(wizardStepHref(BOOK, 6));
    expect(bookCardHref({ ...card, photo_count: 5, ai_status: "planning" })).toBe(`/books/${BOOK}/build`);
    expect(bookCardHref({ ...card, page_count: 12, photo_count: 5, ai_status: "done" })).toBe(`/books/${BOOK}/edit`);
    // a fresh draft's dashboard link renders the wizard without any redirect
    expect(follow(world({ photos: 0 }), bookCardHref(card))).toEqual({
      screen: { kind: "wizard", step: 3 },
      hops: [`/books/new?book=${BOOK}&step=3`],
    });
  });
});

// --- Task 5: the new step order (3 Photos, 4 Story, 5 Design) ---------------------------------------------

describe("Task 5: hard loads land on the right step from the book's server state", () => {
  const url = (n: number) => `/books/new?book=${BOOK}&step=${n}`;
  const screen = (w: World, n: number) => follow(w, url(n)).screen;

  it("no photos yet: 1–3 as asked; Story / Design (4–5) → Photos (3)", () => {
    const w = world({ photos: 0 });
    for (const n of [1, 2, 3]) expect(screen(w, n)).toEqual({ kind: "wizard", step: n });
    for (const n of [4, 5]) expect(screen(w, n)).toEqual({ kind: "wizard", step: 3 });
  });

  it("photos in, no run: 3–5 as asked (open steps); 1–2 are locked → Photos (3)", () => {
    for (const doc of [empty, rule]) {
      const w = world({ photos: 3, doc });
      for (const n of [3, 4, 5]) expect(screen(w, n)).toEqual({ kind: "wizard", step: n });
      for (const n of [1, 2]) expect(screen(w, n)).toEqual({ kind: "wizard", step: 3 });
    }
  });

  it("a book mid-wizard under the OLD numbering (5 = photos) opens somewhere sensible, never crashes", () => {
    // Old "photos" bookmark, nothing uploaded → the new Photos step.
    expect(screen(world({ photos: 0 }), 5)).toEqual({ kind: "wizard", step: 3 });
    // Old "photos" bookmark with photos in → the nearest open step asked for (Design).
    expect(screen(world({ photos: 4, doc: rule }), 5)).toEqual({ kind: "wizard", step: 5 });
    // Old shape / style bookmarks (3 / 4) of a book without photos → Photos.
    expect(screen(world({ photos: 0 }), 3)).toEqual({ kind: "wizard", step: 3 });
    expect(screen(world({ photos: 0 }), 4)).toEqual({ kind: "wizard", step: 3 });
  });

  it("a running first build → 6 and a finished one → 7, whatever step (1–7) was asked", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      expect(screen(world({ active: { trigger: "build" }, runExists: true, doc: rule }), n)).toEqual({ kind: "wizard", step: 6 });
      expect(screen(world({ runExists: true, doc: ai }), n)).toEqual({ kind: "wizard", step: 7 });
      expect(screen(world({ doc: edited }), n)).toEqual({ kind: "editor" });
    }
  });

  it("/books/[id]/build of a fresh book with photos → step 6 (the first build), as before", () => {
    expect(follow(world({ photos: 6, doc: rule }), `/books/${BOOK}/build`).screen).toEqual({ kind: "wizard", step: 6 });
  });

  it("the gate keeps the asked step when the photo count is unknown (old callers)", () => {
    const base = {
      hasRun: false,
      active: false,
      readError: false,
      detailsLock: null,
      docOrigin: { generator: "none" as const, userEdited: false },
      albumConfirmed: false,
    };
    for (const requested of [1, 2, 3, 4, 5]) expect(resolveWizardStep({ ...base, requested })).toBe(requested);
    expect(resolveWizardStep({ ...base, requested: 2, photoCount: 1 })).toBe(3);
    expect(resolveWizardStep({ ...base, requested: 5, photoCount: 0 })).toBe(3);
    expect(resolveWizardStep({ ...base, requested: 4, photoCount: 2 })).toBe(4);
    // A run read error with details unlocked: still the open step (never a build POST from steps ≤ 5).
    expect(resolveWizardStep({ ...base, readError: true, requested: 5, photoCount: 0 })).toBe(3);
    expect(resolveWizardStep({ ...base, readError: true, requested: 4, photoCount: 3 })).toBe(4);
    expect(resolveWizardStep({ ...base, readError: true, requested: 6, photoCount: 3 })).toBe(6);
  });
});

// --- M20c: confirmed album ("Generate album" ran) ------------------------------------------------------

describe("M20c: a confirmed book never lands in the wizard", () => {
  const confirmedWorlds: World[] = [];
  for (const doc of Object.values(DOCS))
    for (const aiOn of [true, false])
      for (const active of [null, { trigger: "build" as const }, { trigger: "rebuild" as const }])
        for (const runExists of [false, true])
          for (const activeReadOk of [true, false])
            for (const runReadOk of [true, false])
              for (const photos of [0, 3]) {
                if (active && !runExists) continue;
                confirmedWorlds.push({ doc, aiOn, active, runExists, activeReadOk, runReadOk, confirmed: true, photos });
              }

  const wizardStarts = [1, 2, 3, 4, 5, 6, 7].map((n) => `/books/new?book=${BOOK}&step=${n}`);
  const starts = [
    ...wizardStarts,
    `/books/new?book=${BOOK}&step=6&auto=1`,
    `/books/${BOOK}/edit`,
    `/books/${BOOK}/build`,
    `/books/${BOOK}/build?auto=1`,
    `/books/${BOOK}/build?trigger=rebuild`,
    `/books/${BOOK}/build?trigger=rebuild&auto=1`,
    `/books/${BOOK}/upload`,
  ];

  it("the gate answers 'editor' for every requested step 1–7, whatever the run / doc state", () => {
    for (const w of confirmedWorlds) {
      for (const requested of [1, 2, 3, 4, 5, 6, 7, 0, 9]) {
        const target = resolveWizardStep({
          requested,
          hasRun: w.runExists,
          active: w.active !== null,
          activeTrigger: w.active?.trigger ?? null,
          readError: !w.activeReadOk || !w.runReadOk,
          detailsLock: detailsLockReason({ hasRun: w.runExists, doc: w.doc }),
          docOrigin: { generator: docOrigin(w.doc).generator, userEdited: albumEditedByUser(w.doc) },
          albumConfirmed: true,
          aiOn: w.aiOn,
        });
        expect(target).toBe("editor");
      }
      for (const step of [1, 2, 3, 4, 5, 6, 7] as const) expect(wizardGate(w, step)).toBe("editor");
    }
  });

  it(`every confirmed world × entry URL settles without a loop and never renders the wizard (${confirmedWorlds.length} worlds)`, () => {
    for (const w of confirmedWorlds) {
      for (const start of starts) {
        const label = `${start} in ${JSON.stringify({ ...w, doc: docOrigin(w.doc) })}`;
        const { screen, hops } = follow(w, start);
        expect(screen.kind, label).not.toBe("wizard");
        // never redirected INTO the wizard (only a start URL may be a wizard URL)
        expect(hops.slice(1).some((h) => h.startsWith("/books/new")), label).toBe(false);
        expect(hops.length, label).toBeLessThanOrEqual(4);
      }
    }
  });

  it("a generated book: wizard URLs (and Back into one) → the editor in one redirect", () => {
    const generated = world({ doc: ai, runExists: true, confirmed: true });
    for (const start of wizardStarts) {
      expect(follow(generated, start)).toEqual({ screen: { kind: "editor" }, hops: [start, `/books/${BOOK}/edit`] });
    }
    const ruleGenerated = world({ doc: rule, aiOn: false, runExists: true, confirmed: true });
    expect(follow(ruleGenerated, `/books/new?book=${BOOK}&step=7`).screen).toEqual({ kind: "editor" });
    // ?auto=1 after the run ended → editor (was: wizard Review)
    expect(follow(generated, `/books/${BOOK}/build?auto=1`)).toEqual({
      screen: { kind: "editor" },
      hops: [`/books/${BOOK}/build?auto=1`, `/books/${BOOK}/edit`],
    });
  });

  it("classic rebuild / add-more-photos paths are unchanged for confirmed books", () => {
    const generated = world({ doc: ai, runExists: true, confirmed: true });
    // Try AI again
    expect(follow(generated, `/books/${BOOK}/build?trigger=rebuild`)).toEqual({
      screen: { kind: "classic-build" },
      hops: [`/books/${BOOK}/build?trigger=rebuild`],
    });
    // a running rebuild opened from the editor / dashboard → classic progress
    const rebuilding = world({ doc: ai, runExists: true, active: { trigger: "rebuild" }, confirmed: true });
    expect(follow(rebuilding, `/books/${BOOK}/edit`).screen).toEqual({ kind: "classic-build" });
    expect(follow(rebuilding, `/books/new?book=${BOOK}&step=6`).screen).toEqual({ kind: "classic-build" });
    // add more photos
    expect(follow(generated, `/books/${BOOK}/upload`)).toEqual({ screen: { kind: "classic-upload" }, hops: [`/books/${BOOK}/upload`] });
    // even a confirmed book that somehow has no run row and an unlocked setup keeps the classic upload
    expect(uploadTarget(world({ confirmed: true }))).toBeNull();
  });

  it("an empty confirmed album goes to the classic pages from the editor, never the wizard", () => {
    expect(follow(world({ confirmed: true, photos: 0 }), `/books/${BOOK}/edit`)).toEqual({
      screen: { kind: "classic-upload" },
      hops: [`/books/${BOOK}/edit`, `/books/${BOOK}/upload`],
    });
    expect(follow(world({ confirmed: true, photos: 3 }), `/books/${BOOK}/edit`)).toEqual({
      screen: { kind: "classic-build" },
      hops: [`/books/${BOOK}/edit`, `/books/${BOOK}/build`],
    });
  });

  it("unconfirmed worlds with the editor modelled still never loop", () => {
    for (const doc of Object.values(DOCS))
      for (const active of [null, { trigger: "build" as const }, { trigger: "rebuild" as const }])
        for (const runExists of [false, true])
          for (const runReadOk of [true, false])
            for (const photos of [0, 3]) {
              if (active && !runExists) continue;
              const w = world({ doc, active, runExists, runReadOk, photos });
              for (const start of starts.filter((s) => !/step=[1-4]$/.test(s))) {
                expect(() => follow(w, start, { editor: true })).not.toThrow();
              }
            }
  });

  it("dashboard Open → the editor for a confirmed book (running build keeps /build)", () => {
    const card = { id: BOOK, page_count: 0, photo_count: 0, ai_status: "idle", user_edited: false, album_confirmed: true };
    expect(bookCardHref(card)).toBe(`/books/${BOOK}/edit`);
    expect(bookCardHref({ ...card, photo_count: 5 })).toBe(`/books/${BOOK}/edit`);
    expect(bookCardHref({ ...card, page_count: 12, photo_count: 5, ai_status: "done" })).toBe(`/books/${BOOK}/edit`);
    expect(bookCardHref({ ...card, photo_count: 5, ai_status: "planning" })).toBe(`/books/${BOOK}/build`);
    // unconfirmed fresh drafts keep their wizard links
    expect(bookCardHref({ ...card, album_confirmed: false })).toBe(wizardStepHref(BOOK, 3));
  });
});
