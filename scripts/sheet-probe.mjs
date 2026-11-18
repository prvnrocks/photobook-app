#!/usr/bin/env node
// Layout contact-sheet probe (M30): opens a /dev-book-page sheet in Chromium, checks every layout
// text panel for overflow and saves a screenshot of the sheet.
//
//   npm run dev            (AI is replay-only in dev; this script never calls AI)
//   node scripts/sheet-probe.mjs "<sheet query>" [out.png] [--width 1300] [--scale 2] [--base http://localhost:3000]
//   e.g. node scripts/sheet-probe.mjs "sheet=magazine-portrait&ar=1" /tmp/mag-p-ar.png
//
// Overflow method (lessons M29): on the text element itself, count the DISTINCT line tops of its
// client rects × the computed line-height and compare with the panel's text box — never
// scrollHeight (tall Arabic font metrics read as overflow). Quarter-turned panels count line
// lefts. Also flags a panel whose longest line is wider than its box (a word that cannot break),
// and fallback fonts (first family of the computed font is not a book face).
// Prints one line per panel ("ok" / "OVER"), exits 1 when any panel overflows.

import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const width = Number(flag("width", "1300"));
const scale = Number(flag("scale", "2"));
const base = flag("base", "http://localhost:3000");
const [query, out] = args;
if (!query) {
  console.error('usage: node scripts/sheet-probe.mjs "sheet=demo[&ar=1][&desc=0][&cw=coral]" [out.png]');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: scale });
await page.goto(`${base}/dev-book-page?${query}`, { waitUntil: "networkidle" });
await page.evaluate(async () => {
  document.querySelectorAll("nextjs-portal").forEach((e) => e.remove());
  await document.fonts.ready;
  // Photos (`&photos=real`) decode async: without this the rows below the fold screenshot blank.
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
});
await page.waitForTimeout(800);

const rows = await page.evaluate(() =>
  [...document.querySelectorAll("[data-text-panel] p, [data-caption-area] p")].map((p) => {
    const box = p.parentElement;
    const cs = getComputedStyle(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    const rects = [...range.getClientRects()];
    const turned = !!p.closest("[data-text-turn]");
    const lines = new Set(rects.map((r) => Math.round(turned ? r.left : r.top))).size;
    // + the ink headroom padding of Arabic headings (render.ts panelLeading)
    const need = lines * parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const have = box.clientHeight;
    const panel = p.closest("[data-text-panel]");
    return {
      layout: p.closest("[data-layout]")?.dataset.layout ?? "?",
      bind: panel ? panel.dataset.textPanel : "pageCaption",
      font: cs.fontFamily.split(",")[0].replace(/"/g, ""),
      px: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      lines,
      need: Math.round(need * 10) / 10,
      have,
      over: need > have + 0.5 || p.scrollWidth > box.clientWidth + 1,
    };
  }),
);
for (const r of rows) {
  console.log(`${r.over ? "OVER" : "ok  "} ${r.layout} ${r.bind} ${r.font} ${r.px}px lines=${r.lines} need=${r.need} have=${r.have}`);
}
const bad = rows.filter((r) => r.over).length;
console.log(`${rows.length} text panels, ${bad} overflowing`);
if (out) {
  await page.locator("main").screenshot({ path: out });
  console.log(`saved ${out}`);
}
await browser.close();
process.exit(bad ? 1 : 0);
