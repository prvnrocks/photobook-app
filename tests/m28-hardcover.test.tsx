// M28: the viewer's book is a hardcover — viewer-only paint (D-079). Pins which flip pages are hard
// boards (density + hinge groove, no curl), the case geometry from fitBook (closed vs open, clamped
// so it never leaves the stage and never changes the book box), the case colour, the ground shadow
// under the case, and that the CSS stays paint-only and production-minifier-safe.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FlipPage } from "@/components/viewer/FlipPage";
import { BOARD_CLOTH, coverBoardColor, FREE_END_PAPER } from "@/lib/viewer/end-card";
import { fitBook, pageRatio, type PageRatio } from "@/lib/viewer/fit";
import { flipLayout } from "@/lib/viewer/pages";
import { bookCase, isBoardPage, maxStackPx, paperFor, squarePx, type BookCase, type CaseBox } from "@/lib/viewer/paper";
import { stagePoolStyle, type StageMetrics } from "@/lib/viewer/stage-pool";
import { visiblePages } from "@/lib/viewer/window";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const css = read("src/components/viewer/viewer-motion.css").replace(/\/\*[\s\S]*?\*\//g, "");
const PORTRAIT = pageRatio("A5_PORTRAIT");
const LANDSCAPE = pageRatio("A5_LANDSCAPE");

function stage(width: number, height: number, pad: number): StageMetrics {
  return { width, height, padTop: pad, padRight: pad, padBottom: pad, padLeft: pad };
}

function rule(sel: RegExp): string {
  const m = css.match(new RegExp(`${sel.source}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : "";
}

/** The visible pages' rect (what page-flip shows), from the same fit the Flipbook uses. */
function pagesRect(s: StageMetrics, spread: boolean, ratio: PageRatio, visible: number[]): CaseBox {
  const avail = { width: s.width - s.padLeft - s.padRight, height: s.height - s.padTop - s.padBottom };
  const box = fitBook(avail, spread, ratio)!;
  const left = s.padLeft + (avail.width - box.width) / 2;
  const top = s.padTop + (avail.height - box.height) / 2;
  const alone = spread && visible.length === 1;
  return {
    left: alone && visible[0] === 0 ? left + box.pageWidth : left,
    top,
    width: alone ? box.pageWidth : box.width,
    height: box.height,
  };
}

const right = (b: CaseBox) => b.left + b.width;
const bottom = (b: CaseBox) => b.top + b.height;
const parts = (c: BookCase) => [c.boards, c.face, c.edges].filter((b): b is CaseBox => !!b);

describe("hard boards: density per flip index", () => {
  it("front cover (0) and the back (last) are boards; everything between is paper", () => {
    expect(isBoardPage(0, 14)).toBe(true);
    expect(isBoardPage(13, 14)).toBe(true);
    for (let i = 1; i < 13; i++) expect(isBoardPage(i, 14)).toBe(false);
    expect(isBoardPage(0, 0)).toBe(false);
  });

  it("Flipbook gives page-flip data-density hard on the boards only (the board's inner side stays soft)", () => {
    const src = read("src/components/viewer/Flipbook.tsx");
    expect(src).toContain('density={isBoardPage(i, pageCount) ? "hard" : undefined}');
    // page-flip turns a leaf whose two sides differ in density as one hard leaf: documented there.
    expect(src).toMatch(/Flip\.start sets\s*\/\/ both drawing densities to hard/);
  });

  it("FlipPage writes data-density for page-flip", () => {
    const html = renderToStaticMarkup(
      <FlipPage index={13} density="hard" paper={paperFor(13, 14, true)}>
        <i />
      </FlipPage>,
    );
    expect(html).toContain('data-density="hard"');
  });
});

describe("paperFor: groove only on the boards, no curl on them", () => {
  const counts = [3, 14, 23];
  it("spread: cover hinge left, back (alone, left of the fold) hinge right; no other page has a board", () => {
    for (const count of counts) {
      for (let i = 0; i < count; i++) {
        const p = paperFor(i, count, true);
        if (i === 0) expect(p.board).toBe("left");
        else if (i === count - 1 && i % 2 === 1) expect(p.board).toBe("right");
        else expect(p.board).toBeUndefined();
        if (p.board) expect(p.curl).toBe(false);
      }
    }
  });

  it("viewer layouts always end on the back alone (end card at an odd index)", () => {
    for (let d = 1; d <= 30; d++) {
      const layout = flipLayout(d, { endCard: true, spread: true });
      expect(paperFor(layout.count - 1, layout.count, true).board).toBe("right");
    }
  });

  it("phone: cover and last page are boards, hinge left (spine stays left on phones)", () => {
    expect(paperFor(0, 13, false)).toEqual({ side: "single", curl: false, board: "left" });
    expect(paperFor(12, 13, false)).toEqual({ side: "single", curl: false, board: "left" });
    expect(paperFor(5, 13, false).board).toBeUndefined();
  });

  it("FlipPage marks the overlay with data-board only on boards", () => {
    const board = renderToStaticMarkup(
      <FlipPage index={0} density="hard" paper={paperFor(0, 14, true)}>
        <i />
      </FlipPage>,
    );
    expect(board).toContain('data-board="left"');
    expect(board).not.toContain("data-curl");
    const inner = renderToStaticMarkup(
      <FlipPage index={2} paper={paperFor(2, 14, true)}>
        <i />
      </FlipPage>,
    );
    expect(inner).not.toContain("data-board");
    expect(inner).toContain('data-curl="true"');
  });
});

describe("bookCase: the hardcover case round the visible pages", () => {
  const desk = stage(1280, 657, 16);
  const phone = stage(375, 524, 8);

  it("closed front (spread): face = cover page + wrapped edge, far board + page block on the fore-edge, nothing on the left page", () => {
    const pages = pagesRect(desk, true, PORTRAIT, [0]);
    const c = bookCase(desk, true, PORTRAIT, [0], 14)!;
    expect(c.state).toBe("front");
    expect(c.hinge).toBe("left");
    const f = c.face!;
    const r = c.square;
    expect(r).toBeGreaterThanOrEqual(2);
    expect([f.top, bottom(f), right(f)]).toEqual([pages.top - r, bottom(pages) + r, right(pages) + r]);
    expect(f.left).toBeLessThan(pages.left); // rounds into the spine
    expect(f.left).toBeGreaterThan(pages.left - r - 1);
    expect(c.edges!.left).toBe(right(f)); // the page block starts at the board edge
    expect(c.edges!.width).toBe(maxStackPx(pages.width));
    expect(right(c.boards)).toBeGreaterThan(right(c.edges!)); // far board peeks past the page block
    expect(c.boards.top).toBeGreaterThan(f.top); // seen slightly from below: offset down
    expect(bottom(c.boards)).toBeGreaterThan(bottom(f));
    expect(c.spineX).toBeNull();
    // Nothing reaches over the empty left half (closed book).
    for (const b of parts(c)) expect(b.left).toBeGreaterThan(pages.left - 20);
  });

  it("closed back (spread): mirrored — hinge right, fore-edge on the left", () => {
    const pages = pagesRect(desk, true, PORTRAIT, [13]);
    const c = bookCase(desk, true, PORTRAIT, [13], 14)!;
    expect(c.state).toBe("back");
    expect(c.hinge).toBe("right");
    expect(c.face!.left).toBe(pages.left - c.square);
    expect(right(c.face!)).toBeGreaterThan(right(pages));
    expect(right(c.edges!)).toBe(c.face!.left);
    expect(c.boards.left).toBeLessThan(c.edges!.left);
    expect(right(c.boards)).toBe(right(c.face!));
  });

  it("open spread: boards under both pages, one square beyond them (top, bottom, outside the page-block edges), spine at the fold", () => {
    const pages = pagesRect(desk, true, PORTRAIT, [5, 6]);
    const c = bookCase(desk, true, PORTRAIT, [5, 6], 14)!;
    expect(c.state).toBe("open");
    expect(c.face).toBeNull();
    const r = c.square;
    expect(r).toBe(Math.min(squarePx(pages.height), 16));
    expect(c.boards.top).toBe(pages.top - r);
    expect(bottom(c.boards)).toBe(bottom(pages) + r);
    expect(c.boards.left).toBe(c.edges!.left - r);
    expect(right(c.boards)).toBe(right(c.edges!) + r);
    expect(c.boards.left + c.spineX!).toBe(pages.left + pages.width / 2);
    expect(c.grow).toEqual({ left: pages.left - c.boards.left, right: right(c.boards) - right(pages), top: r, bottom: r });
  });

  it("open on a phone: spine flush left, board + page block on the right only", () => {
    const pages = pagesRect(phone, false, PORTRAIT, [3]);
    const c = bookCase(phone, false, PORTRAIT, [3], 13)!;
    expect(c.state).toBe("open");
    expect(c.boards.left).toBe(pages.left);
    expect(c.spineX).toBeNull();
    expect(c.edges!.background).not.toContain("to left");
  });

  it("phone: cover and last page are the closed book (hinge left)", () => {
    expect(bookCase(phone, false, PORTRAIT, [0], 13)).toMatchObject({ state: "front", hinge: "left" });
    expect(bookCase(phone, false, PORTRAIT, [12], 13)).toMatchObject({ state: "back", hinge: "left" });
  });

  it("never leaves the stage (≥ its padding: 8 px phone, 16 px ≥ sm), never covers the book box differently", () => {
    const stages: Array<[StageMetrics, boolean]> = [
      [stage(375, 524, 8), false],
      [stage(320, 470, 8), false],
      [stage(375, 300, 8), false],
      [stage(1280, 657, 16), true],
      [stage(999, 557, 16), true],
      [stage(768, 900, 16), true],
      [stage(1920, 980, 16), true],
    ];
    for (const [s, spread] of stages) {
      for (const ratio of [PORTRAIT, LANDSCAPE]) {
        const count = 14;
        for (let cur = 0; cur < count; cur++) {
          const visible = visiblePages(cur, count, spread);
          const c = bookCase(s, spread, ratio, visible, count)!;
          const pages = pagesRect(s, spread, ratio, visible);
          for (const b of parts(c)) {
            expect(b.left).toBeGreaterThanOrEqual(0);
            expect(b.top).toBeGreaterThanOrEqual(0);
            expect(right(b)).toBeLessThanOrEqual(s.width);
            expect(bottom(b)).toBeLessThanOrEqual(s.height);
          }
          // Squares ~2–3 % of the page height at most.
          expect(c.square).toBeLessThanOrEqual(Math.max(3, Math.round(pages.height * 0.03)));
          // The book box itself is fitBook's, unchanged — the case only surrounds it.
          if (c.face) {
            expect(c.face.left).toBeLessThanOrEqual(pages.left);
            expect(right(c.face)).toBeGreaterThanOrEqual(right(pages));
          }
          expect(c.boards.top).toBeLessThanOrEqual(pages.top + 3);
          expect(bottom(c.boards)).toBeGreaterThanOrEqual(bottom(pages));
        }
      }
    }
  });

  it("where the book touches the stage padding, the case reaches no further than the padding", () => {
    // 375 phone portrait: width-limited, 8 px either side.
    const c = bookCase(stage(375, 600, 8), false, PORTRAIT, [0], 13)!;
    expect(right(c.boards)).toBeLessThanOrEqual(375);
    expect(c.grow.right).toBeLessThanOrEqual(8);
    // 1280 portrait spread: height-limited, 16 px top and bottom.
    const d = bookCase(stage(1280, 657, 16), true, PORTRAIT, [5, 6], 14)!;
    expect(d.grow.top).toBeLessThanOrEqual(16);
    expect(d.grow.bottom).toBeLessThanOrEqual(16);
  });

  it("null when there is no book", () => {
    expect(bookCase(stage(40, 40, 8), false, PORTRAIT, [0], 13)).toBeNull();
    expect(bookCase(stage(1280, 657, 16), true, PORTRAIT, [], 14)).toBeNull();
    expect(bookCase(stage(1280, 657, 16), true, PORTRAIT, [0], 1)).toBeNull();
  });
});

describe("case colour", () => {
  it("the cover's background (book default), else cloth emerald", () => {
    expect(coverBoardColor({ kind: "color", hex: "#24476B" })).toBe("#24476B");
    expect(coverBoardColor({ kind: "photo", photoId: "00000000-0000-4000-8000-000000000000", veil: 0.3, veilColor: "#112233" })).toBe("#112233");
    expect(coverBoardColor("#abcdef")).toBe("#abcdef");
    expect(coverBoardColor(null)).toBe(BOARD_CLOTH);
    expect(coverBoardColor("nope")).toBe(BOARD_CLOTH);
    expect(BOARD_CLOTH).toBe("#0e3b2e");
  });

  it("free end card's paper is the back face colour (EndCard frame)", () => {
    expect(read("src/components/viewer/EndCard.tsx")).toContain(`bg-[${FREE_END_PAPER}]`);
  });
});

describe("ground shadow under the case", () => {
  it("stagePoolStyle with grow widens and lowers the pool by the case's reach", () => {
    const s = stage(1280, 657, 16);
    const base = stagePoolStyle(s, true, PORTRAIT, "center")!;
    const grown = stagePoolStyle(s, true, PORTRAIT, "center", { left: 20, right: 20, bottom: 12 })!;
    expect(grown).not.toEqual(base);
    const [bw] = base.backgroundSize.split(" ").map(parseFloat);
    const [gw] = grown.backgroundSize.split(" ").map(parseFloat);
    expect(gw).toBeGreaterThan(bw);
    expect(stagePoolStyle(s, true, PORTRAIT, "center", { left: 0, right: 0, bottom: 0 })).toEqual(base);
  });
});

describe("ViewerShell + CSS", () => {
  const shell = read("src/components/viewer/ViewerShell.tsx");

  it("board, page-block edges and cover face are pointer-events-none siblings before the flipbook, in that order", () => {
    const iBoard = shell.indexOf('data-testid="book-board"');
    const iEdges = shell.indexOf('data-testid="book-edges"');
    const iFace = shell.indexOf('data-testid="book-cover-face"');
    const iBook = shell.indexOf("<FlipbookLoader");
    expect(iBoard).toBeGreaterThan(0);
    expect(iBoard).toBeLessThan(iEdges);
    expect(iEdges).toBeLessThan(iFace);
    expect(iFace).toBeLessThan(iBook);
    expect(shell).toMatch(/className="vw-board pointer-events-none absolute"/);
    expect(shell).toMatch(/className="vw-board-face pointer-events-none absolute"/);
  });

  it("hinge groove: dark line ~4.6 % in from the spine with a light ridge beside it, mirrored for the back", () => {
    const g = rule(/\.vw-paper\[data-paper\]\[data-board\]/);
    expect(g).toMatch(/linear-gradient\(\s*var\(--vw-hinge, to right\)/);
    expect(g).toMatch(/rgb\(0 0 0 \/ 0\.2\d\) 4\.\d%/);
    expect(g).toMatch(/rgb\(255 255 255 \/ 0\.3\d\) 5\.\d%/);
    expect(rule(/\.vw-paper\[data-paper\]\[data-board="left"\]/)).toMatch(/--vw-hinge:\s*to right/);
    expect(rule(/\.vw-paper\[data-paper\]\[data-board="right"\]/)).toMatch(/--vw-hinge:\s*to left/);
  });

  it("case paint: cover colour, wrapped edge (dark outer line + highlight), spine hollow when open; paint only", () => {
    const board = rule(/\.vw-board\[data-state\]/);
    expect(board).toMatch(/background-color:\s*var\(--vw-cover\)/);
    expect(board).toMatch(/inset 0 0 0 1px rgb\(0 0 0/);
    expect(board).toMatch(/inset 0 0 0 2px rgb\(255 255 255/);
    expect(rule(/\.vw-board\[data-state="open"\]/)).toMatch(/var\(--vw-spine-x\)/);
    expect(rule(/\.vw-board-face\[data-hinge\]/)).toMatch(/background-color:\s*var\(--vw-cover\)/);
    const caseRules = [...css.matchAll(/([^{}]*\.vw-board[^{}]*)\{([^}]*)\}/g)].map((m) => m[2]).join("\n");
    expect(caseRules).not.toMatch(/transform|translate|scale|rotate|animation|transition|margin|padding/);
  });

  it("no :has() with a leading combinator (production minifier bug)", () => {
    expect(css).not.toMatch(/:has\(\s*[>+~]/);
  });
});
