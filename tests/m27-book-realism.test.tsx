// M27: the flipbook looks like a real open photobook — viewer-only paint. Pins the per-page paper
// overlay (side of the fold, corner curl, pointer-events none, paint only), the page-block edges
// beside the book (outside the book box, nothing where no pages are left), the reduced-motion guard
// of the curl's peel-in, and that none of it reaches BookPage / editor / print.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FlipPage } from "@/components/viewer/FlipPage";
import { fitBook, pageRatio } from "@/lib/viewer/fit";
import { bookEdgesStyle, maxStackPx, paperFor } from "@/lib/viewer/paper";
import type { StageMetrics } from "@/lib/viewer/stage-pool";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const css = read("src/components/viewer/viewer-motion.css").replace(/\/\*[\s\S]*?\*\//g, "");
const PORTRAIT = pageRatio("A5_PORTRAIT");
const LANDSCAPE = pageRatio("A5_LANDSCAPE");

function stage(width: number, height: number, pad: number): StageMetrics {
  return { width, height, padTop: pad, padRight: pad, padBottom: pad, padLeft: pad };
}

/** Body of the first rule whose selector matches `sel` (no nesting). */
function rule(sel: RegExp): string {
  const m = css.match(new RegExp(`${sel.source}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : "";
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(tsx?|css)$/.test(name)) out.push(rel);
  }
  return out;
}

describe("paperFor: side of the fold + curl per flip page", () => {
  it("spread: cover alone right, odd left, even right, unpaired last page alone on the left", () => {
    const count = 14; // cover + 12 pages + end card
    expect(paperFor(0, count, true)).toEqual({ side: "cover", curl: true });
    expect(paperFor(1, count, true)).toEqual({ side: "left", curl: false });
    expect(paperFor(2, count, true)).toEqual({ side: "right", curl: true });
    expect(paperFor(11, count, true)).toEqual({ side: "left", curl: false });
    expect(paperFor(12, count, true)).toEqual({ side: "right", curl: true });
    expect(paperFor(13, count, true)).toEqual({ side: "back", curl: false });
  });

  it("spread with a paired last page: its right page has no curl", () => {
    expect(paperFor(2, 3, true)).toEqual({ side: "right", curl: false });
  });

  it("phone: every page single (spine left), curl on all but the last", () => {
    for (let i = 0; i < 12; i++) expect(paperFor(i, 13, false)).toEqual({ side: "single", curl: true });
    expect(paperFor(12, 13, false)).toEqual({ side: "single", curl: false });
  });
});

describe("FlipPage paper overlay", () => {
  it("renders a decorative, non-interactive overlay as the page's last child", () => {
    for (const side of ["left", "right", "cover", "back", "single"] as const) {
      const html = renderToStaticMarkup(
        <FlipPage index={3} paper={{ side, curl: side === "right" }}>
          <div data-content="x" />
        </FlipPage>,
      );
      expect(html).toMatch(/<div data-content="x"><\/div><span aria-hidden="true" class="vw-paper"/);
      expect(html).toContain(`data-paper="${side}"`);
      expect(html.includes('data-curl="true"')).toBe(side === "right");
      expect(html).not.toMatch(/<span[^>]*vw-paper[^>]*>[^<]/); // empty: no text, nothing focusable
    }
  });

  it("no paper prop → no overlay (the page markup stays as before)", () => {
    const html = renderToStaticMarkup(
      <FlipPage index={0} density="hard">
        <i />
      </FlipPage>,
    );
    expect(html).toBe('<div class="overflow-hidden bg-white" data-flip-index="0" data-density="hard"><i></i></div>');
  });

  it("Flipbook passes each page its paper from paperFor(index, count, spread)", () => {
    expect(read("src/components/viewer/Flipbook.tsx")).toContain("paper={paperFor(i, pageCount, spread)}");
  });
});

describe("paper CSS (viewer-motion.css)", () => {
  it("overlay is absolute, pointer-events none, paint only", () => {
    const base = rule(/\.vw-paper\[data-paper\]/);
    expect(base).toMatch(/position:\s*absolute/);
    expect(base).toMatch(/inset:\s*0/);
    expect(base).toMatch(/pointer-events:\s*none/);
    const paperRules = [...css.matchAll(/([^{}]*\.vw-paper[^{}]*)\{([^}]*)\}/g)].map((m) => m[2]).join("\n");
    expect(paperRules).not.toMatch(/transform|translate|scale|rotate|margin|padding|border-width/);
  });

  it("gutter shading on the fold side of each page", () => {
    expect(rule(/\.vw-paper\[data-paper="left"\]/)).toMatch(/linear-gradient\(\s*to left/);
    expect(rule(/\.vw-paper\[data-paper="right"\]/)).toMatch(/linear-gradient\(\s*to right/);
    expect(rule(/\.vw-paper\[data-paper="single"\]/)).toMatch(/linear-gradient\(\s*to right/);
    expect(rule(/\.vw-paper\[data-paper="cover"\],\s*\.vw-paper\[data-paper="back"\]/)).toMatch(/linear-gradient\(\s*var\(--vw-hinge, to right\)/);
    expect(css).toMatch(/\n\.vw-paper\[data-paper="back"\]\s*\{\s*--vw-hinge:\s*to left;\s*\}/);
  });

  it("curl hint hides while page-flip draws a turn", () => {
    expect(css).toMatch(/\.stf__block:has\(\.stf__item[^)]*:not\(\.--simple\)\) \.vw-paper::after\s*\{\s*visibility:\s*hidden/);
    // A leading combinator in :has() is mangled by the production minifier into a hide-all rule.
    expect(css).not.toMatch(/:has\(\s*[>+~]/);
  });

  it("the peel-in animates only under prefers-reduced-motion: no-preference, clip-path only", () => {
    const start = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(css.match(/@media \(prefers-reduced-motion/g)).toHaveLength(1);
    const peelRule = css.indexOf("animation: vw-peel");
    const peelFrames = css.indexOf("@keyframes vw-peel");
    expect(peelRule).toBeGreaterThan(start);
    expect(peelFrames).toBeGreaterThan(start);
    // Everything after the media block's end is static paint.
    const tail = css.slice(css.indexOf(".vw-paper[data-paper] {"));
    expect(tail).not.toMatch(/animation|@keyframes|transition/);
    const frames = css.slice(peelFrames, css.indexOf("}", css.indexOf("to {", peelFrames)) + 1);
    expect(frames).toMatch(/clip-path/);
    expect(frames).not.toMatch(/transform|translate|scale|opacity|width|height/);
  });
});

describe("bookEdgesStyle: page-block edges beside the visible book", () => {
  const s = stage(1280, 657, 16);
  const box = fitBook({ width: 1248, height: 625 }, true, PORTRAIT)!;
  const bookLeft = 16 + (1248 - box.width) / 2;
  const bookTop = 16 + (625 - box.height) / 2;
  const max = maxStackPx(box.pageWidth);

  it("cover alone: under the right page only, no stack on the left", () => {
    const e = bookEdgesStyle(s, true, PORTRAIT, [0], 14)!;
    expect(e.left).toBe(bookLeft + box.pageWidth);
    expect(e.width).toBe(box.pageWidth + max);
    expect(e.background).not.toContain("to left");
    expect(e.background).toContain(`100% 0/${max}px 100% no-repeat`);
    expect([e.top, e.height]).toEqual([bookTop, box.height]);
  });

  it("middle spread: both stacks, thickness follows progress, outside the book box", () => {
    const e = bookEdgesStyle(s, true, PORTRAIT, [3, 4], 14)!;
    const tL = bookLeft - e.left;
    const tR = e.left + e.width - (bookLeft + box.width);
    expect(tL).toBeGreaterThanOrEqual(2);
    expect(tR).toBeGreaterThan(tL);
    expect(tR).toBeLessThanOrEqual(max);
    expect(e.background).toContain(`repeating-linear-gradient(to left,#fdfcf9 0 2px,#cfc8ba 2px 3px) 0 0/${tL}px 100% no-repeat`);
    expect(e.background).toContain(`repeating-linear-gradient(to right,#fdfcf9 0 2px,#cfc8ba 2px 3px) 100% 0/${tR}px 100% no-repeat`);
  });

  it("end card alone: under the left page only, no stack on the right", () => {
    const e = bookEdgesStyle(s, true, PORTRAIT, [13], 14)!;
    expect(e.left + e.width).toBe(bookLeft + box.pageWidth);
    expect(e.background).not.toContain("to right");
    expect(e.background).toContain(" 0 0/");
  });

  it("phone: only the right stack (spine on the left), stays inside the stage at 375 / 320", () => {
    for (const w of [375, 320]) {
      for (const ratio of [PORTRAIT, LANDSCAPE]) {
        const e = bookEdgesStyle(stage(w, 524, 8), false, ratio, [2], 13)!;
        expect(e.background).not.toContain("to left");
        expect(e.left + e.width).toBeLessThanOrEqual(w);
        expect(e.left).toBeGreaterThanOrEqual(0);
      }
    }
    expect(bookEdgesStyle(stage(375, 524, 8), false, PORTRAIT, [12], 13)).toBeNull(); // last page
  });

  it("no book → null", () => {
    expect(bookEdgesStyle(stage(40, 40, 8), false, PORTRAIT, [0], 13)).toBeNull();
    expect(bookEdgesStyle(s, true, PORTRAIT, [], 14)).toBeNull();
  });

  it("ViewerShell paints the edges as a pointer-events-none sibling before the flipbook", () => {
    const src = read("src/components/viewer/ViewerShell.tsx");
    expect(src).toMatch(/className="pointer-events-none absolute" style=\{edgesStyle\} data-testid="book-edges"/);
    expect(src.indexOf('data-testid="book-edges"')).toBeLessThan(src.indexOf("<FlipbookLoader"));
  });
});

describe("viewer-only: never in BookPage, editor or print", () => {
  it("no book / editor / print / layout source references the paper paint", () => {
    const dirs = ["src/components/book", "src/components/editor", "src/lib/layouts", "src/lib/book", "src/app/print", "src/app/dev-print"];
    for (const f of dirs.flatMap(walk)) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/vw-paper|lib\/viewer\/paper|viewer-motion\.css|book-edges/);
    }
  });

  it("only FlipPage, Flipbook and ViewerShell use it", () => {
    const users = walk("src")
      .filter((f) => /vw-paper|@\/lib\/viewer\/paper|data-testid="book-edges"/.test(readFileSync(join(root, f), "utf8")))
      .filter((f) => !f.endsWith("viewer-motion.css") && !f.endsWith("lib/viewer/paper.ts"))
      .sort();
    expect(users).toEqual([
      "src/components/viewer/FlipPage.tsx",
      "src/components/viewer/Flipbook.tsx",
      "src/components/viewer/ViewerShell.tsx",
    ]);
  });
});
