// @vitest-environment jsdom
// M23 T3: viewer sheets as cards — ViewerSheet (ivory card, handle, 44 px close, vw-sheet-rise on the
// panel only, Escape / backdrop close, focus return), ContentsSheet (card rows, active row emerald +
// aria-current, dir="auto" + Cairo chain, "p. N" chip) and ShareButtons (WhatsApp pill, emerald
// outline Copy / More). No gold anywhere here; testids unchanged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contrastRatio } from "@/lib/app/palette";
import { ContentsSheet } from "@/components/viewer/ContentsSheet";
import { ShareButtons } from "@/components/viewer/ShareButtons";
import { ViewerSheet } from "@/components/viewer/ViewerSheet";
import * as VW from "@/components/viewer/viewer-classes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const FILES = ["ViewerSheet.tsx", "ContentsSheet.tsx", "ShareButtons.tsx"].map((f) => `src/components/viewer/${f}`);

const doc = {
  chapters: [
    { id: "ch-a", title: "Desert morning", dateLabel: "12 Feb" },
    { id: "ch-b", title: "عشاء العائلة", dateLabel: "14 Feb" },
  ],
  pages: [{ chapterId: "ch-a" }, { chapterId: "ch-a" }, { chapterId: "ch-b" }, { chapterId: "ch-b" }],
};

let host: HTMLDivElement | null = null;
let reactRoot: Root | null = null;
function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  reactRoot = createRoot(host);
  act(() => reactRoot!.render(node));
}
afterEach(() => {
  act(() => reactRoot?.unmount());
  host?.remove();
  host = null;
  reactRoot = null;
});
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("ViewerSheet", () => {
  it("ivory card panel with handle, title and 44 px close; vw-sheet-rise on the panel only", () => {
    const html = renderToStaticMarkup(
      <ViewerSheet open onClose={() => {}} title="Share this book" testId="share-sheet">
        <p>x</p>
      </ViewerSheet>,
    );
    expect(html).toContain('data-testid="share-sheet"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Share this book"');
    expect(html).toContain(VW.VW_SHEET_HANDLE);
    expect(html).toContain(VW.VW_SHEET_TITLE);
    expect(html).toContain(VW.VW_CLOSE_BTN);
    expect(html).toContain(VW.VW_SHEET_BACKDROP);
    expect(html.match(/vw-sheet-rise/g)).toHaveLength(1);
    expect(html).toMatch(/<div[^>]*role="dialog"[^>]*class="[^"]*vw-sheet-rise/);
    expect(renderToStaticMarkup(<ViewerSheet open={false} onClose={() => {}} title="t"><p /></ViewerSheet>)).toBe("");
  });

  it("Escape and backdrop close; focus goes to the panel and returns on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    mount(
      <ViewerSheet open onClose={onClose} title="Contents" testId="contents-sheet">
        <p>x</p>
      </ViewerSheet>,
    );
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = q("contents-sheet")!.querySelector<HTMLButtonElement>(":scope > button[aria-label='Close']")!;
    act(() => backdrop.click());
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => reactRoot!.render(<ViewerSheet open={false} onClose={onClose} title="Contents"><p /></ViewerSheet>));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("ContentsSheet", () => {
  it("card rows with testids; the active chapter is the emerald row with aria-current", () => {
    const html = renderToStaticMarkup(<ContentsSheet open onClose={() => {}} doc={doc} currentChapterId="ch-b" onJump={() => {}} />);
    expect(html).toContain('data-testid="contents-sheet"');
    expect(html.match(/data-testid="contents-item"/g)).toHaveLength(2);
    const rows = [...html.matchAll(/<button [^>]*data-testid="contents-item"[^>]*>/g)].map((m) => m[0]);
    const active = rows.filter((r) => r.includes('aria-current="true"'));
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('data-chapter-id="ch-b"');
    expect(active[0]).toContain(`class="${VW.VW_LIST_ROW_ACTIVE}"`);
    const idle = rows.find((r) => r.includes('data-chapter-id="ch-a"'))!;
    expect(idle).not.toContain("aria-current");
    expect(idle).toContain(`class="${VW.VW_LIST_ROW}"`);
    expect(html).toContain(">p. 1<");
    expect(html).toContain(">p. 3<");
    expect(html).toContain(VW.VW_PAGE_CHIP_ACTIVE);
  });

  it("title and date are dir=auto; Arabic titles get lang=ar and the Cairo chain", () => {
    const html = renderToStaticMarkup(<ContentsSheet open onClose={() => {}} doc={doc} currentChapterId={null} onJump={() => {}} />);
    expect(html).toMatch(/<span dir="auto" lang="ar" style="[^"]*--font-cairo[^"]*"[^>]*>عشاء العائلة<\/span>/);
    expect(html).toMatch(/<span dir="auto" class="[^"]*">14 Feb<\/span>/);
    expect(html).not.toContain("aria-current");
  });

  it("rows' text block is text-left (Arabic titles start where the date does); a date equal to the title is skipped", () => {
    const dated = {
      chapters: [{ id: "ch-d", title: "15 Nov 2026", dateLabel: "15 Nov 2026" }],
      pages: [{ chapterId: "ch-d" }],
    };
    const html = renderToStaticMarkup(<ContentsSheet open onClose={() => {}} doc={dated} currentChapterId={null} onJump={() => {}} />);
    expect(html.match(/15 Nov 2026/g)).toHaveLength(1);
    const plain = renderToStaticMarkup(<ContentsSheet open onClose={() => {}} doc={doc} currentChapterId={null} onJump={() => {}} />);
    expect(plain.match(/<span class="min-w-0 flex-1 text-left">/g)).toHaveLength(2);
  });

  it("tap jumps to the chapter's first page (unchanged)", () => {
    const onJump = vi.fn();
    mount(<ContentsSheet open onClose={() => {}} doc={doc} currentChapterId="ch-a" onJump={onJump} />);
    act(() => document.querySelector<HTMLButtonElement>('[data-chapter-id="ch-b"]')!.click());
    expect(onJump).toHaveBeenCalledWith(3, expect.objectContaining({ firstPageIdx: 2 }));
  });

  it("empty book message", () => {
    const html = renderToStaticMarkup(<ContentsSheet open onClose={() => {}} doc={{ chapters: [], pages: [] }} currentChapterId={null} onJump={() => {}} />);
    expect(html).toContain("This book has no chapters.");
  });
});

describe("ShareButtons", () => {
  it("WhatsApp pill + emerald outline Copy; testids and copy unchanged", () => {
    const html = renderToStaticMarkup(<ShareButtons url="https://x.ae/b/abc" title="Eid" />);
    expect(html).toContain('data-testid="share-buttons"');
    expect(html).toMatch(/<a [^>]*class="[^"]*rounded-full[^"]*bg-\[#0F7A40\][^"]*"[^>]*data-testid="share-whatsapp"/);
    expect(html).toContain("Send on WhatsApp");
    expect(html).toMatch(/<button [^>]*class="[^"]*border-\[#0e3b2e\][^"]*"[^>]*data-testid="share-copy"/);
    expect(html).toContain("Copy link");
    expect(html).toContain('aria-live="polite"');
  });

  it("More options (native share) is an emerald outline pill when available", async () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn(async () => {}) });
    mount(<ShareButtons url="https://x.ae/b/abc" title="Eid" />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const native = q("share-native");
    expect(native).not.toBeNull();
    expect(native!.className).toContain(VW.VW_CTA_EMERALD_OUTLINE);
    expect(native!.textContent).toBe("More options");
    Reflect.deleteProperty(navigator, "share");
  });
});

describe("module rules", () => {
  it("no gold, no cn / buttonVariants / next/link / zod / BTN in the three files", () => {
    for (const f of FILES) {
      const src = code(f);
      expect(src, f).not.toMatch(/home-foil|VW_CTA_GOLD|#e3c766|#7a5f0e|gold/i);
      expect(src, f).not.toMatch(/@\/lib\/utils|button-variants|button-classes|next\/link|from "zod"/);
    }
  });

  it("only ViewerSheet uses vw-sheet-rise", () => {
    expect(read(FILES[0])).toContain('"vw-sheet-rise"');
    for (const f of FILES.slice(1)) expect(read(f), f).not.toContain("vw-sheet-rise");
  });

  it("chip and meta text clear AA", () => {
    expect(contrastRatio("#4a4740", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#0e3b2e", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#4a4740", "#e6efe9")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#4a4740", "#efe7d8")).toBeGreaterThanOrEqual(4.5);
    expect(VW.VW_PAGE_CHIP).toContain("text-[#4a4740]");
    expect(VW.VW_PAGE_CHIP_ACTIVE).toContain("text-[#0e3b2e]");
    expect(VW.VW_LIST_ROW_META).toContain("text-[#4a4740]");
    expect(VW.VW_LIST_ROW_META).not.toMatch(/tracking-|uppercase/);
  });
});
