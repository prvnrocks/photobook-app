// @vitest-environment jsdom
// M21 T2: the share page leather band — title (dir="auto", testid publish-title), status chip per
// kind with numeric contrast on the leather, 3-step mini progress, back link slot, plus the share
// class recipes (no cn / buttonVariants / next/link in the new components).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/app/palette";
import { ShareBand, ShareProgress, ShareStatusChip, SHARE_TITLE_FALLBACK } from "@/components/publish/ShareBand";
import {
  SHARE_BACK_LINK,
  SHARE_CHIP_DOT,
  SHARE_CHIP_KINDS,
  SHARE_CHIP_TONE,
  SHARE_CHIP_TONES,
  SHARE_CTA_EMERALD,
  SHARE_CTA_GOLD,
  SHARE_LEATHER_LIGHTEST,
  SHARE_OPEN_LINK,
  shareChipKind,
} from "@/components/publish/share-classes";

const tagOf = (html: string, id: string) => html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";

function dom(html: string) {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("ShareBand", () => {
  it("renders the leather band with eyebrow, title in a dir=auto span and the back slot", () => {
    const html = renderToStaticMarkup(
      <ShareBand
        title="رحلتنا إلى العين"
        chip={{ text: "Live · 21 days left", kind: "live" }}
        back={
          <a href="/books/b1/edit" data-testid="publish-back" className={SHARE_BACK_LINK}>
            Back to editor
          </a>
        }
      />,
    );
    const el = dom(html);
    expect(el.querySelector('[data-testid="share-band"]')?.className).toContain("home-leather");
    expect(el.textContent).toContain("Share");
    const title = el.querySelector('[data-testid="publish-title"]')!;
    expect(title.tagName).toBe("SPAN");
    expect(title.getAttribute("dir")).toBe("auto");
    expect(title.textContent).toBe("رحلتنا إلى العين");
    expect(title.parentElement!.tagName).toBe("H1");
    const back = el.querySelector('[data-testid="publish-back"]')!;
    expect(back.textContent).toBe("Back to editor");
    expect(back.getAttribute("href")).toBe("/books/b1/edit");
    // The chip shows its text and kind.
    const chip = el.querySelector('[data-testid="publish-status-chip"]')!;
    expect(chip.getAttribute("data-kind")).toBe("live");
    expect(chip.textContent).toBe("Live · 21 days left");
  });

  it("falls back to 'Your book' for a blank title and can render the title as a <p>", () => {
    const el = dom(renderToStaticMarkup(<ShareBand title="   " titleAs="p" />));
    const title = el.querySelector('[data-testid="publish-title"]')!;
    expect(title.textContent).toBe(SHARE_TITLE_FALLBACK);
    expect(title.parentElement!.tagName).toBe("P");
    expect(el.querySelector('[data-testid="publish-status-chip"]')).toBeNull();
    expect(el.querySelector("h1")).toBeNull();
  });

  it("puts no title/eyebrow text in a tracked eyebrow (letter-spacing breaks Arabic joining)", () => {
    const html = renderToStaticMarkup(<ShareBand title="رحلتنا" />);
    const el = dom(html);
    const title = el.querySelector('[data-testid="publish-title"]')!;
    let n: Element | null = title;
    while (n) {
      expect(n.className).not.toMatch(/tracking-\[0\.2/);
      n = n.parentElement;
    }
  });
});

describe("status chip", () => {
  it.each(SHARE_CHIP_KINDS)("kind %s renders its tone classes and dot", (kind) => {
    const html = renderToStaticMarkup(<ShareStatusChip text="Status" kind={kind} />);
    const tag = tagOf(html, "publish-status-chip");
    expect(tag).toContain(`data-kind="${kind}"`);
    for (const c of SHARE_CHIP_TONE[kind].split(" ")) expect(tag).toContain(c);
    expect(html).toContain(SHARE_CHIP_DOT[kind]);
    // The class strings carry the same colours the contrast test checks.
    expect(SHARE_CHIP_TONE[kind]).toContain(`text-[${SHARE_CHIP_TONES[kind].text}]`);
    if (kind !== "paid") expect(SHARE_CHIP_TONE[kind]).toContain(`bg-[${SHARE_CHIP_TONES[kind].bg}]`);
  });

  it("maps kinds to the agreed colour families", () => {
    expect(SHARE_CHIP_TONE.paid).toContain("home-foil-fill");
    expect(SHARE_CHIP_TONES.live.text).toBe("#9ee6bd");
    expect(SHARE_CHIP_TONES.expiring).toEqual(SHARE_CHIP_TONES.expired);
    expect(SHARE_CHIP_TONES.draft.text).toBe("#d7cdb9");
  });

  it.each(SHARE_CHIP_KINDS)("kind %s text clears AA 4.5:1 on its chip and on the leather's lightest point", (kind) => {
    const tone = SHARE_CHIP_TONES[kind];
    expect(contrastRatio(tone.text, tone.bg)).toBeGreaterThanOrEqual(4.5);
    if (kind !== "paid") {
      // Light text on the leather: also safe with no chip background at all.
      expect(contrastRatio(tone.text, SHARE_LEATHER_LIGHTEST)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("records the measured numbers", () => {
    const r = (a: string, b: string) => Math.round(contrastRatio(a, b) * 100) / 100;
    expect(SHARE_LEATHER_LIGHTEST).toBe("#1f5443");
    expect(r("#d7cdb9", "#143f33")).toBe(7.45);
    expect(r("#9ee6bd", "#0f3a2d")).toBe(8.72);
    expect(r("#f3c969", "#2f2a14")).toBe(9.14);
    expect(r("#1b1b1d", "#bf9a23")).toBe(6.44);
    expect(r("#d7cdb9", "#1f5443")).toBe(5.53);
    expect(r("#9ee6bd", "#1f5443")).toBe(6.03);
    expect(r("#f3c969", "#1f5443")).toBe(5.55);
    // Paid: every foil stop (home-foil-fill) keeps ink text ≥ 4.5.
    for (const stop of ["#c9a227", "#ddc163", "#bf9a23"]) expect(contrastRatio("#1b1b1d", stop)).toBeGreaterThanOrEqual(4.5);
    // Band text on the leather.
    expect(r("#f2e8d8", "#1f5443")).toBe(7.19);
    expect(r("#e3c766", "#1f5443")).toBe(5.25);
    expect(contrastRatio("#b9c2b6", "#1f5443")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("shareChipKind", () => {
  it("maps shareStatus() results (incl. kind 'changes') to a chip colour", () => {
    expect(shareChipKind({ kind: "draft", chip: "Draft" })).toBe("draft");
    expect(shareChipKind({ kind: "live", chip: "Live" })).toBe("live");
    expect(shareChipKind({ kind: "expiring", chip: "Expires in 3 days" })).toBe("expiring");
    expect(shareChipKind({ kind: "expired", chip: "Expired" })).toBe("expired");
    expect(shareChipKind({ kind: "paid", chip: "Paid · permanent" })).toBe("paid");
    expect(shareChipKind({ kind: "changes", chip: "Paid · permanent" })).toBe("paid");
    expect(shareChipKind({ kind: "changes", chip: "Expires in 1 day" })).toBe("expiring");
    expect(shareChipKind({ kind: "changes", chip: "Live" })).toBe("live");
    expect(shareChipKind({ kind: "mystery", chip: "?" })).toBe("draft");
  });
});

describe("ShareProgress", () => {
  it("shows Photos ✓ · Your book ✓ · Share (current)", () => {
    const el = dom(renderToStaticMarkup(<ShareProgress />));
    const nav = el.querySelector('[data-testid="share-progress"]')!;
    expect(nav.tagName).toBe("NAV");
    expect(nav.getAttribute("aria-label")).toBe("Book steps");
    const items = [...el.querySelectorAll("li")];
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual(["done", "done", "current"]);
    expect(items.map((li) => li.getAttribute("data-testid"))).toEqual(["share-progress-photos", "share-progress-book", "share-progress-share"]);
    expect(items[2].getAttribute("aria-current")).toBe("step");
    expect(items[0].getAttribute("aria-current")).toBeNull();
    expect(items[0].textContent).toContain("Photos");
    expect(items[0].textContent).toContain("completed");
    expect(items[1].textContent).toContain("Your book");
    expect(items[2].textContent).toContain("Share");
    expect(items[2].textContent).toContain("current step");
    // Done steps draw a check.
    expect(items[0].querySelector("svg")).not.toBeNull();
    expect(items[2].querySelector("svg")).toBeNull();
  });

  it("is part of the band", () => {
    expect(renderToStaticMarkup(<ShareBand title="x" />)).toContain('data-testid="share-progress"');
  });
});

describe("share class recipes", () => {
  it("give every interactive recipe a ≥ 44 px target and a focus ring", () => {
    for (const c of [SHARE_CTA_GOLD, SHARE_CTA_EMERALD, SHARE_BACK_LINK, SHARE_OPEN_LINK]) {
      expect(c).toMatch(/min-h-1[1-4]/);
      expect(c).toContain("focus-visible:ring-2");
    }
    expect(SHARE_CTA_GOLD).toContain("home-foil-fill");
    expect(SHARE_CTA_GOLD).toContain("rounded-full");
    expect(SHARE_CTA_EMERALD).toContain("rounded-full");
    expect(SHARE_CTA_EMERALD).toContain("text-[#0e3b2e]");
    expect(contrastRatio("#0e3b2e", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("new share components use no cn / buttonVariants / next/link / hooks", () => {
    for (const f of ["ShareBand.tsx", "SharePreview.tsx", "share-classes.ts"]) {
      const src = readFileSync(join(process.cwd(), "src/components/publish", f), "utf8");
      expect(src).not.toMatch(/from "@\/lib\/utils"|\bcn\(/);
      expect(src).not.toMatch(/\bbuttonVariants\(|from "[^"]*button-variants"/);
      expect(src).not.toMatch(/from "next\/link"/);
      expect(src).not.toMatch(/\buse(State|Effect|Ref|Memo|Callback|Transition)\(/);
      expect(src).not.toMatch(/^"use client"/m);
    }
  });
});
