// M20 T9 (D-072): entry points into the continuous wizard. /books/[id]/upload and /books/[id]/build
// redirect fresh books into /books/new?book=<id>&step=5|6|7 and keep the classic screens for built,
// edited, rebuilding and AI-off books; createBookAction's `next` and the dashboard's fresh-draft
// links point straight into the wizard. Pure decision helpers (src/lib/books/wizard-routes.ts) plus a
// small route simulator proving the build page and the /books/new gate never redirect in a loop.
import { describe, expect, it } from "vitest";
import { devPreviewDoc } from "@/lib/book/dev-preview";
import { docOrigin } from "@/lib/book/replaceable";
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
};

const world = (w: Partial<World> = {}): World => ({
  doc: empty,
  aiOn: true,
  active: null,
  runExists: false,
  activeReadOk: true,
  runReadOk: true,
  ...w,
});

/** What the build page passes to buildEntryRedirect for this world + query. */
function buildInput(w: World, q: { trigger?: "build" | "rebuild"; auto?: boolean } = {}): BuildEntryInput {
  const trigger = q.trigger ?? "build";
  const active = w.activeReadOk ? w.active : null;
  // The page only reads hasAnyRunForBook for trigger=build with AI on (null otherwise / on error).
  const runExists = trigger === "build" && w.aiOn && w.runReadOk ? w.runExists || w.active !== null : null;
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
  };
}

/** The upload page's inputs (read errors count as "no run" there). */
function uploadTarget(w: World): string | null {
  const hasRun = w.runReadOk ? w.runExists || w.active !== null : false;
  const active = w.activeReadOk ? w.active : null;
  const firstRun: FirstRunState = active ? "active" : hasRun ? "done" : "none";
  return uploadEntryRedirect({ bookId: BOOK, firstRun, detailsLock: detailsLockReason({ hasRun, doc: w.doc }) });
}

/** /books/new?book=&step=5|6|7 hard load: the gate as loadWizardStep computes it (wizard-data.ts). */
function wizardGate(w: World, step: 5 | 6 | 7): WizardTarget {
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
    aiOn: w.aiOn,
  });
}

type Screen =
  | { kind: "wizard"; step: number }
  | { kind: "classic-build" }
  | { kind: "classic-upload" }
  | { kind: "editor" };

/** Follows server redirects from a URL until a page renders. Throws on a loop (or > 6 hops). */
function follow(w: World, start: string): { screen: Screen; hops: string[] } {
  const hops: string[] = [];
  let url = start;
  for (let i = 0; i < 6; i++) {
    if (hops.includes(url)) throw new Error(`redirect loop: ${[...hops, url].join(" → ")}`);
    hops.push(url);
    const u = new URL(url, "https://x.test");
    if (u.pathname === `/books/${BOOK}/edit`) return { screen: { kind: "editor" }, hops };
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
      const step = Number(u.searchParams.get("step")) as 5 | 6 | 7;
      const target = wizardGate(w, step);
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
    expect(wizardStepHref(BOOK, 5)).toBe(`/books/new?book=${BOOK}&step=5`);
    expect(wizardStepHref(BOOK, 6, { auto: true })).toBe(`/books/new?book=${BOOK}&step=6&auto=1`);
    expect(wizardStepHref(BOOK, 7, { auto: false })).toBe(`/books/new?book=${BOOK}&step=7`);
  });
});

// --- upload ------------------------------------------------------------------------------------------

describe("/books/[id]/upload entry", () => {
  it("fresh book (no run, details unlocked) → wizard step 5", () => {
    expect(uploadTarget(world())).toBe(wizardStepHref(BOOK, 5));
    expect(uploadTarget(world({ doc: rule }))).toBe(wizardStepHref(BOOK, 5));
    // run read error = "no run" on this page (the wizard gate agrees for step 5)
    expect(uploadTarget(world({ runReadOk: false, activeReadOk: false }))).toBe(wizardStepHref(BOOK, 5));
    expect(follow(world(), `/books/${BOOK}/upload`).screen).toEqual({ kind: "wizard", step: 5 });
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

  it("AI off: a fresh book still uses the wizard's photo step (only the build step goes classic)", () => {
    expect(uploadTarget(world({ aiOn: false }))).toBe(wizardStepHref(BOOK, 5));
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

  it("AI off → classic, never the wizard", () => {
    for (const doc of Object.values(DOCS)) {
      expect(go(world({ doc, aiOn: false }))).toEqual({ kind: "classic" });
      expect(go(world({ doc, aiOn: false, active: { trigger: "build" }, runExists: true }))).toEqual({ kind: "classic" });
    }
    expect(go(world({ doc: rule, aiOn: false, runExists: true }), { auto: true })).toEqual({ kind: "editor" });
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
              worlds.push({ doc, aiOn, active, runExists, activeReadOk, runReadOk });
            }

  const starts = [
    `/books/${BOOK}/build`,
    `/books/${BOOK}/build?auto=1`,
    `/books/${BOOK}/build?trigger=rebuild`,
    `/books/${BOOK}/build?trigger=rebuild&auto=1`,
    `/books/${BOOK}/upload`,
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

  it("gate 'classic' (running rebuild / AI off) → /build renders classic, no bounce back", () => {
    const rebuilding = world({ doc: rule, runExists: true, active: { trigger: "rebuild" } });
    expect(wizardGate(rebuilding, 6)).toBe("classic");
    expect(follow(rebuilding, `/books/new?book=${BOOK}&step=6`)).toEqual({
      screen: { kind: "classic-build" },
      hops: [`/books/new?book=${BOOK}&step=6`, `/books/${BOOK}/build`],
    });

    const aiOff = world({ doc: rule, aiOn: false });
    expect(wizardGate(aiOff, 6)).toBe("classic");
    expect(follow(aiOff, `/books/new?book=${BOOK}&step=6`).screen).toEqual({ kind: "classic-build" });
    expect(follow(aiOff, `/books/${BOOK}/build`).hops).toHaveLength(1);
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
    expect(bookCardHref(card)).toBe(wizardStepHref(BOOK, 5));
    expect(bookCardHref({ ...card, photo_count: 5 })).toBe(wizardStepHref(BOOK, 6));
    expect(bookCardHref({ ...card, photo_count: 5, ai_status: "planning" })).toBe(`/books/${BOOK}/build`);
    expect(bookCardHref({ ...card, page_count: 12, photo_count: 5, ai_status: "done" })).toBe(`/books/${BOOK}/edit`);
    // a fresh draft's dashboard link renders the wizard without any redirect
    expect(follow(world(), bookCardHref(card)).hops).toHaveLength(1);
  });
});
