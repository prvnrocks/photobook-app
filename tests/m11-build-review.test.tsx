// M11 T11 + T12: build-stage checklist (only real snapshot states) and the review action hierarchy.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildChecklist } from "@/lib/runs/build-checklist";
import type { RunProgress, RunState } from "@/lib/runs/client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }) }));

const { BuildProgress } = await import("@/components/review/BuildProgress");
const { ReviewBody } = await import("@/components/review/ReviewBody");
const { RebuildButton } = await import("@/components/review/RebuildButton");
const { rebuildsLeftCopy } = await import("@/lib/review/ui");
const { UpdateAlbumBar } = await import("@/components/review/UpdateAlbumBar");

const progress = (p: Partial<RunProgress>): RunProgress => ({
  phase: "curating",
  photosTotal: 0,
  photosDone: 0,
  batchesTotal: 0,
  batchesDone: 0,
  photosCapped: 0,
  captionsTotal: 0,
  captionsDone: 0,
  ...p,
});

const states = (s: RunState, p: RunProgress | null = null, finished = false) =>
  buildChecklist(s, p, finished).map((x) => x.state);

describe("buildChecklist (T11)", () => {
  it("queued: nothing started", () => {
    expect(states("queued")).toEqual(["todo", "todo", "todo", "todo"]);
  });

  it("each run state marks exactly its step current and earlier steps done", () => {
    expect(states("curating")).toEqual(["current", "todo", "todo", "todo"]);
    expect(states("storytelling")).toEqual(["done", "current", "todo", "todo"]);
    expect(states("captioning")).toEqual(["done", "done", "current", "todo"]);
    for (const s of ["critiquing", "repairing", "validating"] as const) {
      expect(states(s)).toEqual(["done", "done", "done", "current"]);
    }
  });

  it("done or finished: all done; failed: nothing claimed", () => {
    expect(states("done")).toEqual(["done", "done", "done", "done"]);
    expect(states("queued", null, true)).toEqual(["done", "done", "done", "done"]);
    expect(states("failed")).toEqual(["todo", "todo", "todo", "todo"]);
  });

  it("counts come only from the snapshot, only on the current step", () => {
    const c = buildChecklist("curating", progress({ photosTotal: 40, photosDone: 12 }));
    expect(c[0].count).toBe("12 / 40");
    expect(buildChecklist("curating", progress({}))[0].count).toBeNull();
    expect(buildChecklist("curating", null)[0].count).toBeNull();
    const w = buildChecklist("captioning", progress({ photosTotal: 40, photosDone: 40, captionsTotal: 6, captionsDone: 9 }));
    expect(w[0].count).toBeNull();
    expect(w[2].count).toBe("6 / 6");
  });
});

describe("BuildProgress first render (T11)", () => {
  const html = renderToStaticMarkup(
    <BuildProgress bookId="b1" activeRunId={null} trigger="build" isPaid={false} dailyCap={3} />,
  );
  it("keeps the build-* testids and shows the checklist with nothing done yet", () => {
    for (const id of ["build-progress", "build-stage", "build-bar", "build-checklist"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('data-state="queued"');
    expect(html).toContain("Getting ready…");
    expect(html).not.toMatch(/data-testid="build-step-[a-z]+" data-state="(done|current)"/);
    expect(html).toContain("Keep this screen open");
  });
});

const PHOTO = { id: "p1", status: "kept", dropReason: null, userOverride: false, dupGroup: null, width: 400, height: 300, thumbUrl: "https://x.test/p1" } as const;

function review(opts: { userEdited?: boolean; building?: boolean; albumPhotoIds?: string[]; photos?: (typeof PHOTO)[] } = {}) {
  return renderToStaticMarkup(
    <ReviewBody
      bookId="b1"
      photos={opts.photos ?? [PHOTO]}
      aiUsed
      toggle={async () => ({ ok: true })}
      updateAlbum={async () => ({ ok: true, changed: false, pages: 0 })}
      albumPhotoIds={opts.albumPhotoIds ?? ["p1"]}
      userEdited={opts.userEdited ?? false}
      building={opts.building ?? false}
      rebuild={{ variant: "rebuild", rebuildsLeft: 2 }}
      confirm={async () => {}}
      empty={null}
    />,
  );
}

describe("Review hierarchy (T12)", () => {
  it("Continue to editor is the cta in the sticky action bar; Rebuild stays visible as secondary", () => {
    const html = review();
    const bar = html.slice(html.indexOf('data-testid="review-actions"'));
    expect(bar).toContain('data-testid="review-continue"');
    expect(bar).toContain("Continue to editor");
    expect(bar).not.toContain("Redo with AI");
    expect(html.indexOf("Redo with AI")).toBeLessThan(html.indexOf('data-testid="review-actions"'));
    expect(html).toContain("2 AI redos left");
    // No pending changes → no Update album.
    expect(html).not.toContain('data-testid="update-album-bar"');
    expect(html).toContain('data-testid="review-add-photos"');
  });

  it("pending choices: Update album joins the same action bar, Continue becomes secondary", () => {
    const p2 = { ...PHOTO, id: "p2", userOverride: true } as unknown as typeof PHOTO;
    const html = review({ photos: [PHOTO, p2] });
    const bar = html.slice(html.indexOf('data-testid="review-actions"'));
    expect(bar).toContain('data-testid="update-album-bar"');
    expect(bar).toContain("You changed 1 photo.");
    expect(bar).toContain('data-testid="review-continue-warning"');
    expect(bar.indexOf("update-album-bar")).toBeLessThan(bar.indexOf("review-continue\""));
    expect(bar).toMatch(/aria-describedby="review-continue-note"/);
  });

  it("user-edited (D-037 #2): only Continue in the editor, no Continue / Rebuild / Update", () => {
    const html = review({ userEdited: true });
    expect(html).toContain('data-testid="review-edited"');
    expect(html).toContain("Continue in the editor");
    expect(html).not.toContain('data-testid="review-continue"');
    expect(html).not.toContain("Rebuild");
    expect(html).not.toContain('data-testid="update-album-bar"');
  });
});

describe("RebuildButton + UpdateAlbumBar (T12)", () => {
  it("rebuilds-left copy", () => {
    expect(rebuildsLeftCopy(null)).toBeNull();
    expect(rebuildsLeftCopy(1)).toBe("1 AI redo left");
    expect(rebuildsLeftCopy(3)).toBe("3 AI redos left");
  });

  it("label kept; out of rebuilds disables and drops the count", () => {
    const ok = renderToStaticMarkup(<RebuildButton bookId="b1" variant="rebuild" rebuildsLeft={1} />);
    expect(ok).toContain("Redo with AI");
    expect(ok).toContain("1 AI redo left");
    const out = renderToStaticMarkup(<RebuildButton bookId="b1" variant="rebuild" rebuildsLeft={0} />);
    expect(out).toContain("disabled");
    expect(out).not.toContain("redos left");
    const replay = renderToStaticMarkup(<RebuildButton bookId="b1" variant="rebuild" rebuildsLeft={null} />);
    expect(replay).not.toContain('data-testid="rebuild-left"');
  });

  it("Apply photo changes row (formerly Update album): count, 44 px button, note", () => {
    const html = renderToStaticMarkup(
      <UpdateAlbumBar count={2} pending={false} error={null} onUpdate={() => {}} note={<p>note</p>} />,
    );
    expect(html).toContain("You changed 2 photos.");
    expect(html).toContain("Apply photo changes");
    expect(html).not.toContain("Update album");
    expect(html).toContain("h-11");
    expect(html).toContain("<p>note</p>");
  });
});
