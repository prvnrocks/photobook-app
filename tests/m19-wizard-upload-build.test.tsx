// M19 T6 + T7 (D-071): wizard step 5 (upload) and step 6 (sorting) — chrome choice, no setup card,
// thumbnail URLs revoked, truthful checklist mapping. Node environment: pure helpers directly,
// components via renderToStaticMarkup, pages via source.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunState } from "@/lib/runs/client";

vi.mock("@/app/books/actions", () => ({ deleteUnfinishedAction: vi.fn(), updateBookSetupAction: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

const { isWizardUpload, isWizardBuild, wizardBackHref } = await import("@/lib/books/wizard-routes");
const { wizardChecklist } = await import("@/lib/runs/build-checklist");
const { createThumbStrip, THUMB_STRIP_MAX } = await import("@/lib/upload/thumb-strip");
const { fanPhotoUrls } = await import("@/lib/runs/draft-preview");
const { devPreviewDoc } = await import("@/lib/book/dev-preview");
const { docOrigin } = await import("@/lib/book/replaceable");
const { Uploader, WIZARD_KEEP_OPEN_COPY } = await import("@/components/upload/Uploader");
const { UploadProgress, uploadProgressText } = await import("@/components/upload/UploadProgress");
const { UploadThumbs } = await import("@/components/upload/UploadThumbs");
const { UploadStage, UploadPickArt, UPLOAD_SORTING_NEXT_COPY } = await import("@/components/upload/UploadStage");
const stageModel = await import("@/components/upload/upload-stage-model");
const { STAGE_MAX_THUMBS } = stageModel;
const { BuildProgress, WIZARD_BUILD_KEEP_OPEN_COPY } = await import("@/components/review/BuildProgress");
const { PhotoFan } = await import("@/components/review/PhotoFan");
type UploaderProps = import("@/components/upload/Uploader").UploaderProps;
type QueueProgress = import("@/lib/upload/queue").QueueProgress;

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const BOOK = "11111111-1111-4111-8111-111111111111";

// --- chrome choice ---------------------------------------------------------------------------------

describe("wizard chrome choice", () => {
  it("upload: wizard only for a fresh book (no run, setup unlocked)", () => {
    expect(isWizardUpload("none", null)).toBe(true);
    expect(isWizardUpload("none", "user_edited")).toBe(false);
    expect(isWizardUpload("none", "ai_started")).toBe(false);
    expect(isWizardUpload("active", null)).toBe(false);
    expect(isWizardUpload("done", null)).toBe(false);
    expect(wizardBackHref(BOOK)).toBe(`/books/new?book=${BOOK}&step=4`);
  });

  it("build: wizard only for the first AI build of an unedited, non-AI album", () => {
    const rule = { ...devPreviewDoc(), meta: { generator: "rule" as const, generatorVersion: 1, runId: null, userEdited: false } };
    const ai = { ...rule, meta: { ...rule.meta, generator: "ai" as const } };
    const edited = { ...rule, meta: { ...rule.meta, userEdited: true } };
    // fixtures say what they claim
    expect(docOrigin(rule)).toEqual({ generator: "rule", userEdited: false });
    expect(docOrigin(ai)).toEqual({ generator: "ai", userEdited: false });
    expect(docOrigin(edited).userEdited).toBe(true);

    expect(isWizardBuild({ trigger: "build", aiOn: true, doc: {} })).toBe(true);
    expect(isWizardBuild({ trigger: "build", aiOn: true, doc: rule })).toBe(true);
    expect(isWizardBuild({ trigger: "rebuild", aiOn: true, doc: rule })).toBe(false);
    expect(isWizardBuild({ trigger: "build", aiOn: false, doc: rule })).toBe(false);
    expect(isWizardBuild({ trigger: "build", aiOn: true, doc: ai })).toBe(false);
    expect(isWizardBuild({ trigger: "build", aiOn: true, doc: edited })).toBe(false);
    // unparsable → treated as edited (safe side)
    expect(isWizardBuild({ trigger: "build", aiOn: true, doc: { pages: "nope" } })).toBe(false);
  });

  // M20 T9 (D-072): the pages no longer wear wizard chrome — fresh books are redirected into
  // /books/new?book=<id>&step=5|6 (decision table: tests/m20-entry-redirects.test.ts).
  it("upload page: fresh book → redirect into wizard step 5; classic screen otherwise (no wizard chrome)", () => {
    const page = src("src/app/books/[id]/upload/page.tsx");
    expect(page).toContain("detailsLock: detailsLockReason({ hasRun, doc: book.doc }),");
    expect(page).toContain("if (wizardHref) redirect(wizardHref);");
    expect(page).not.toContain("WizardShell");
    expect(page).not.toContain('variant="wizard"');
    expect(page).toContain("<AppHeader displayName={displayName} />");
    expect(page).toContain("<Uploader {...uploaderProps} />");
  });

  it("build page: first build → redirect into wizard step 6; classic screen otherwise (no wizard chrome)", () => {
    const page = src("src/app/books/[id]/build/page.tsx");
    expect(page).toContain("const entry = buildEntryRedirect({");
    expect(page).toContain("if (entry.kind === \"wizard\") redirect(entry.href);");
    expect(page).not.toContain("WizardShell");
    expect(page).not.toContain("PhotoFan");
    expect(page).toContain("<BuildProgress {...progressProps} preview={preview} />");
    // The redirects run before the classic screen renders.
    expect(page.indexOf("redirect(entry.href)")).toBeLessThan(page.indexOf("<BuildProgress"));
  });
});

// --- step 5: upload --------------------------------------------------------------------------------

describe("Uploader (step 5)", () => {
  const props: UploaderProps = {
    bookId: BOOK, userId: "u1", isPaid: false, existing: [], maxUpload: 150, readyCount: 0, pendingCount: 0,
    hasDoc: false, firstRun: "none", dailyCap: 3,
  };
  const back = <a href="/back" data-testid="wizard-back">Back</a>;

  it("wizard: big pick area + Back before any photo is picked; no setup card", () => {
    const html = renderToStaticMarkup(<Uploader {...props} variant="wizard" back={back} />);
    expect(html).toMatch(/<button[^>]*min-h-56[^>]*data-testid="upload-pick"/);
    expect(html).toContain('data-testid="upload-wizard-back"');
    expect(html).toContain('data-testid="wizard-back"');
    expect(html).not.toContain("setup-card");
    expect(html).not.toContain("upload-handoff");
  });

  it("classic: never shows Back (even if passed) and keeps the smaller pick area", () => {
    const html = renderToStaticMarkup(<Uploader {...props} back={back} />);
    expect(html).toMatch(/<button[^>]*min-h-40[^>]*data-testid="upload-pick"/);
    expect(html).not.toContain("wizard-back");
  });

  it("no setup card, no /books/start hand-off, Back hidden once photos are picked or uploading", () => {
    const u = src("src/components/upload/Uploader.tsx");
    for (const gone of ["SetupCard", "useBookSetup", "setupCtl", "takePendingFiles", "hasPendingFiles", "pending-files", "setup-ui"]) {
      expect(u).not.toContain(gone);
    }
    expect(u).toContain("{wizard && (props.onBack || props.back) && !picked && !busy ? (");
    expect(u).toContain("setPicked(true);");
    expect(existsSync(join(process.cwd(), "src/components/upload/SetupCard.tsx"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/components/upload/use-book-setup.ts"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/lib/upload/setup-ui.ts"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/components/upload/pending-files.ts"))).toBe(false);
  });

  it("wizard keep-open is a plain line; classic keeps the info Notice", () => {
    const u = src("src/components/upload/Uploader.tsx");
    expect(WIZARD_KEEP_OPEN_COPY).toBe("Keep this tab open while your photos upload.");
    expect(u).toMatch(/\{busy && !wizard \? \(\s*<Notice tone="info" title="Keep this screen open" data-testid="upload-keep-open">/);
    expect(u).toMatch(/\{busy && wizard \? \([\s\S]*data-testid="upload-keep-open"/);
  });
});

describe("UploadProgress wizard card", () => {
  const p = (over: Partial<QueueProgress> = {}): QueueProgress => ({
    type: "progress", done: 12, total: 20, uploaded: 12, failed: 0, skipped: 0, retried: 0, ...over,
  });

  it("'12 of 20 uploaded' + ring + thumbs + Pause, same testids (M20: rendered as the upload stage)", () => {
    const html = renderToStaticMarkup(
      <UploadProgress progress={p()} paused={false} onTogglePause={() => {}} variant="wizard" thumbs={<UploadThumbs items={[]} />} />,
    );
    expect(html).toMatch(/data-testid="upload-progress">12 of 20 uploaded</);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('data-testid="upload-thumbs"');
    expect(html).toMatch(/data-testid="upload-pause"[^>]*>Pause</);
    expect(html).not.toContain("upload-counts"); // nothing skipped / failed
    expect(renderToStaticMarkup(<UploadProgress progress={p({ skipped: 2, failed: 1 })} paused={false} onTogglePause={() => {}} variant="wizard" />))
      .toMatch(/data-testid="upload-counts">2 skipped · 1 failed</);
  });

  it("text per variant and paused", () => {
    expect(uploadProgressText(p(), true, "wizard")).toBe("Paused · 12 of 20 uploaded");
    expect(uploadProgressText(p(), false, "default")).toBe("Uploading 13 of 20");
    expect(uploadProgressText(p(), true, "default")).toBe("Paused · 12 of 20 done");
  });

  it("thumbs (M20 T5): at most 12 on the book, decorative, object URLs as img src, stable slots", () => {
    const one = renderToStaticMarkup(<UploadThumbs items={[{ key: 4, url: "blob:a" }]} />);
    expect(one).toMatch(/<ul aria-hidden="true"/);
    expect(one.match(/<li /g)).toHaveLength(1);
    expect(one).toContain('src="blob:a"');
    expect(one).toContain('alt=""');
    const many = Array.from({ length: 15 }, (_, i) => ({ key: i, url: `blob:${i}` }));
    const html = renderToStaticMarkup(<UploadThumbs items={many} />);
    expect(html.match(/data-testid="upload-thumb"/g)).toHaveLength(STAGE_MAX_THUMBS);
    expect(html).toContain('data-count="12"');
    expect(html).not.toContain('src="blob:2"'); // only the newest 12
    expect(html).toContain('src="blob:14"');
    for (const m of html.match(/<li [^>]*>/g) ?? []) expect(m).toMatch(/style="left:[\d.]+%;top:[\d.]+%;width:17%/);
  });
});

// --- M20 T5: the upload stage ---------------------------------------------------------------------

describe("UploadStage (M20 T5)", () => {
  const p = (over: Partial<QueueProgress> = {}): QueueProgress => ({
    type: "progress", done: 12, total: 20, uploaded: 12, failed: 0, skipped: 0, retried: 0, ...over,
  });
  const stage = (over: Partial<QueueProgress> = {}, extra: { paused?: boolean; settled?: boolean } = {}) =>
    renderToStaticMarkup(
      <UploadStage
        progress={p(over)}
        paused={extra.paused ?? false}
        onTogglePause={() => {}}
        headline="now"
        statusText="throttled"
        settled={extra.settled}
        thumbs={<UploadThumbs items={[]} />}
      />,
    );

  it("running: ring with count + %, incoming card, visible headline, sr-only throttled live region", () => {
    const html = stage();
    expect(html).toMatch(/data-testid="upload-running"[^>]*data-variant="wizard"[^>]*data-state="running"/);
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuemax="20"[^>]*aria-valuenow="12"/);
    expect(html).toMatch(/data-testid="upload-ring-count">12 of 20</);
    expect(html).toMatch(/data-testid="upload-percent">60%</);
    expect(html).toContain('data-testid="upload-incoming"');
    // The visible headline follows every tick; only the throttled copy is announced.
    expect(html).toMatch(/aria-hidden="true" data-testid="upload-progress">now</);
    expect(html).toMatch(/class="sr-only" role="status" aria-live="polite" data-testid="upload-progress-live">throttled</);
    expect(html.match(/aria-live=/g)).toHaveLength(1);
    expect(html).toMatch(/data-testid="upload-pause"[^>]*>Pause</);
    expect(html).not.toContain("upload-pile");
    expect(html).not.toContain("upload-burst");
    expect(html).not.toContain("upload-stalled"); // only after STALL_MS without progress
  });

  it("UploadProgress passes the unthrottled headline and the throttled live text", () => {
    const html = renderToStaticMarkup(<UploadProgress progress={p()} paused={false} onTogglePause={() => {}} variant="wizard" />);
    expect(html).toMatch(/data-testid="upload-progress">12 of 20 uploaded</);
    expect(html).toMatch(/data-testid="upload-progress-live">12 of 20 uploaded</);
    expect(src("src/components/upload/UploadProgress.tsx")).toContain("useThrottledValue(text, paused ? 0 : ANNOUNCE_EVERY_MS)");
  });

  it("older photos collapse into a +N pile beyond 12", () => {
    expect(stage({ done: 15, uploaded: 15 })).toMatch(/data-testid="upload-pile"[\s\S]*>\+3</);
    expect(stage({ done: 12, uploaded: 12 })).not.toContain("upload-pile");
  });

  it("paused: Resume, no incoming shimmer state; skipped/failed shown calmly", () => {
    const html = stage({ skipped: 2, failed: 1 }, { paused: true });
    expect(html).toContain('data-state="paused"');
    expect(html).toMatch(/data-testid="upload-pause"[^>]*>Resume</);
    expect(html).toMatch(/<p class="text-sm text-muted-foreground" data-testid="upload-counts">2 skipped · 1 failed</);
  });

  it("settled: closed book, burst, 'Sorting next…', no Pause", () => {
    const html = stage({ done: 20, uploaded: 19, failed: 1 });
    expect(html).toContain('data-state="settled"');
    expect(html).toContain('data-testid="upload-settled"');
    expect(html).toContain('data-testid="upload-burst"');
    expect(html.match(/class="up-dot"/g)).toHaveLength(18);
    expect(html).toContain(`data-testid="upload-sorting-next">${UPLOAD_SORTING_NEXT_COPY}<`);
    expect(html).not.toContain("upload-pause");
    // nothing uploaded → calm, no celebration
    const none = stage({ done: 3, total: 3, uploaded: 0, skipped: 3 });
    expect(none).toContain('data-state="settled"');
    expect(none).not.toContain("upload-burst");
    expect(none).toContain("No new photos were added.");
    // forced by the caller (e.g. while finalizing) / never settled with nothing picked
    expect(stage({}, { settled: true })).toContain('data-state="settled"');
    expect(stage({ done: 0, total: 0, uploaded: 0 })).toContain('data-state="running"');
  });

  it("model: stable slots, pile, percent, slot geometry inside the book", () => {
    const { assignSlots, pileCount, stagePercent, stageState, THUMB_SLOTS, THUMB_W, THUMB_H } = stageModel;
    expect(THUMB_SLOTS).toHaveLength(STAGE_MAX_THUMBS);
    for (const s of THUMB_SLOTS) {
      expect(s.left).toBeGreaterThanOrEqual(3);
      expect(s.left + THUMB_W).toBeLessThanOrEqual(97);
      expect(s.top).toBeGreaterThanOrEqual(26); // below the incoming card, on the book (y ≥ 24 %)
      expect(s.top + THUMB_H).toBeLessThanOrEqual(97);
    }
    const a = assignSlots(new Map(), [0, 1, 2]);
    expect([...a]).toEqual([[0, 0], [1, 1], [2, 2]]);
    const full = assignSlots(new Map(), Array.from({ length: 12 }, (_, k) => k));
    const next = assignSlots(full, [...Array.from({ length: 11 }, (_, k) => k + 1), 20]);
    expect(next.get(20)).toBe(0); // newest takes the evicted photo's slot
    for (let k = 1; k < 12; k++) expect(next.get(k)).toBe(k); // nobody moves
    expect(new Set(next.values()).size).toBe(12);
    expect(assignSlots(new Map(), Array.from({ length: 20 }, (_, k) => k)).size).toBe(12);
    expect(pileCount(15)).toBe(3);
    expect(pileCount(4)).toBe(0);
    expect(stagePercent({ done: 1, total: 3, uploaded: 1 })).toBe(33);
    expect(stagePercent({ done: 0, total: 0, uploaded: 0 })).toBe(0);
    expect(stageState({ done: 2, total: 2, uploaded: 2 }, true)).toBe("settled");
    expect(stageState({ done: 1, total: 2, uploaded: 1 }, true)).toBe("paused");
  });

  it("pick art: book + dashed drop page + big 'Choose photos'; reacts to the button's data-drag", () => {
    const html = renderToStaticMarkup(<UploadPickArt />);
    expect(html).toContain('data-testid="upload-pick-art"');
    expect(html).toContain("border-dashed");
    expect(html).toContain("Drop photos here");
    expect(html).toMatch(/up-pick-cta[^"]*min-h-12[^"]*"/);
    expect(html).toMatch(/Choose photos/);
    expect(src("src/components/upload/upload-motion.css")).toContain('[data-drag="over"] .up-pick-book');
    expect(stageModel.UPLOAD_PICK_WIZARD_CLASS).toMatch(/(^| )group( |$)/);
    expect(stageModel.UPLOAD_PICK_WIZARD_CLASS).toContain("min-h-56");
  });

  it("motion: every animation/transition sits under prefers-reduced-motion: no-preference (static otherwise)", () => {
    const css = src("src/components/upload/upload-motion.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const open = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(open).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = css.indexOf("{", open); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const outside = css.slice(0, open) + css.slice(end + 1);
    const inside = css.slice(open, end);
    expect(outside).not.toMatch(/(^|[\s;{])(animation|transition)(-[a-z-]+)?\s*:/);
    expect(inside).toMatch(/animation:\s*up-fly/);
    expect(inside).toMatch(/animation:\s*up-burst/);
    // compositor-friendly: no animated layout properties
    for (const kf of css.match(/@keyframes[^{]+\{[\s\S]*?\n\}/g) ?? []) {
      expect(kf).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding)\s*:/);
    }
  });
});

describe("thumb strip (object URLs)", () => {
  const setup = () => {
    let n = 0;
    const live = new Set<string>();
    const revoked: string[] = [];
    const strip = createThumbStrip({
      createUrl: () => {
        const u = `blob:${n++}`;
        live.add(u);
        return u;
      },
      revokeUrl: (u) => {
        live.delete(u);
        revoked.push(u);
      },
    });
    return { strip, live, revoked };
  };
  const files = (k: number) => Array.from({ length: k }, () => new Blob(["x"]));

  it("keeps the last 12 uploaded (M20 stage); revokes each URL as it leaves the strip", () => {
    const { strip, live, revoked } = setup();
    expect(THUMB_STRIP_MAX).toBe(STAGE_MAX_THUMBS);
    strip.track(0, files(14));
    for (let k = 0; k < 12; k++) strip.uploaded(k);
    expect(live.size).toBe(12);
    expect(revoked).toEqual([]);
    expect(strip.uploaded(12).map((t) => t.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(revoked).toEqual(["blob:0"]);
    strip.uploaded(13);
    expect(revoked).toEqual(["blob:0", "blob:1"]);
    expect(live.size).toBe(12);
  });

  it("failed / skipped / unknown keys never get a URL; duplicates are ignored", () => {
    const { strip, live } = setup();
    strip.track(10, files(3));
    strip.settled(10);
    expect(strip.uploaded(10)).toEqual([]); // forgotten
    expect(strip.uploaded(99)).toEqual([]); // never tracked
    strip.uploaded(11);
    strip.uploaded(11);
    expect(strip.items().map((t) => t.key)).toEqual([11]);
    expect(live.size).toBe(1);
  });

  it("dispose (unmount / new queue) revokes every shown URL", () => {
    const { strip, live, revoked } = setup();
    strip.track(0, files(2));
    strip.uploaded(0);
    strip.uploaded(1);
    strip.dispose();
    expect(live.size).toBe(0);
    expect(revoked).toHaveLength(2);
    expect(strip.items()).toEqual([]);
    expect(strip.uploaded(0)).toEqual([]); // files forgotten too
  });

  it("the hook disposes on unmount and on queue reset", () => {
    const t = src("src/components/upload/UploadThumbs.tsx");
    expect(t).toMatch(/return \(\) => \{\s*mountedRef\.current = false;\s*stripRef\.current\?\.dispose\(\);/);
    expect(src("src/components/upload/Uploader.tsx")).toMatch(/queueRef\.current = q;\s*thumbs\.reset\(\);/);
  });
});

// --- step 6: sorting -------------------------------------------------------------------------------

describe("wizardChecklist (truthful mapping of every RunState)", () => {
  const states = (s: RunState, finished = false) => wizardChecklist(s, finished).map((r) => r.state);

  it("labels in order", () => {
    expect(wizardChecklist("queued").map((r) => r.label)).toEqual([
      "Checking for duplicates and blurry photos",
      "Finding places and moments",
      "Preparing your book",
    ]);
  });

  it.each<[RunState, string[]]>([
    ["queued", ["todo", "todo", "todo"]],
    ["curating", ["current", "todo", "todo"]],
    ["storytelling", ["done", "current", "todo"]],
    ["captioning", ["done", "done", "current"]],
    ["critiquing", ["done", "done", "current"]],
    ["repairing", ["done", "done", "current"]],
    ["validating", ["done", "done", "current"]],
    ["done", ["done", "done", "done"]],
    ["failed", ["todo", "todo", "todo"]],
  ])("%s", (state, want) => {
    expect(states(state)).toEqual(want);
  });

  it("finished (leaving for the editor) → all done, from any state", () => {
    for (const s of ["queued", "curating", "validating"] as const) expect(states(s, true)).toEqual(["done", "done", "done"]);
  });
});

describe("BuildProgress wizard variant", () => {
  const base = { bookId: "b1", activeRunId: null, trigger: "build" as const, isPaid: false, dailyCap: 3 };

  it("fan first, three checklist rows, keep-open line; no classic bar / draft note", () => {
    const html = renderToStaticMarkup(<BuildProgress {...base} variant="wizard" preview={<PhotoFan urls={["https://x/1.jpg"]} />} />);
    expect(html).toMatch(/data-testid="build-progress"[^>]*data-variant="wizard"|data-variant="wizard"[^>]*data-testid="build-progress"/);
    expect(html.indexOf("build-photo-fan")).toBeLessThan(html.indexOf('data-testid="build-checklist"'));
    for (const id of ["sift", "moments", "book"]) expect(html).toContain(`data-testid="build-step-${id}"`);
    expect(html.match(/<li [^>]*data-state="todo"/g)).toHaveLength(3); // queued (M20: + 3 bar segments)
    expect(html).toContain(WIZARD_BUILD_KEEP_OPEN_COPY);
    expect(html).not.toContain("build-bar");
    expect(html).not.toContain("build-ai-note");
    for (const m of html.match(/<li [^>]*>/g) ?? []) expect(m).toContain("min-h-12");
  });

  it("classic variant unchanged", () => {
    const html = renderToStaticMarkup(<BuildProgress {...base} />);
    expect(html).toContain('data-testid="build-bar"');
    expect(html).toContain('data-testid="build-step-photos"');
    expect(html).not.toContain("data-variant");
  });
});

describe("PhotoFan", () => {
  it("three photo cards on top + three backing cards; placeholders for missing photos; decorative", () => {
    // M20 T7: poses per phase live in CSS custom properties; motion in sorting-motion.css
    // (tests/m20-sorting-step.test.tsx checks the reduced-motion fallback).
    const html = renderToStaticMarkup(<PhotoFan urls={["https://x/1.jpg", "https://x/2.jpg"]} />);
    expect(html.match(/data-testid="build-photo-fan-item"/g)).toHaveLength(3);
    expect(html.match(/data-testid="build-photo-fan-back"/g)).toHaveLength(3);
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain("--so-fan:translate(-64%,6%) rotate(-9deg)");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-count="2"');
    expect(renderToStaticMarkup(<PhotoFan urls={[]} />).match(/<img /g)).toBeNull();
  });

  it("fanPhotoUrls: draft order, skips unsigned, max FAN_PHOTOS (6)", () => {
    const ph = (id: string, url: string | null) => ({ id, thumbUrl: url, width: 1, height: 1 });
    const photos = [ph("a", "u-a"), ph("b", null), ph("c", "u-c"), ph("d", "u-d"), ph("e", "u-e"), ph("f", "u-f"), ph("g", "u-g"), ph("h", "u-h")];
    expect(fanPhotoUrls(["d", "b", "a", "c", "e"], photos)).toEqual(["u-d", "u-a", "u-c", "u-e"]);
    expect(fanPhotoUrls(["h", "g", "f", "e", "d", "c", "b", "a"], photos)).toEqual(["u-h", "u-g", "u-f", "u-e", "u-d", "u-c"]);
    expect(fanPhotoUrls(["d", "b", "a", "c", "e"], photos, 3)).toEqual(["u-d", "u-a", "u-c"]);
    expect(fanPhotoUrls(["b"], photos)).toEqual([]);
    expect(fanPhotoUrls([], [])).toEqual([]);
  });
});
