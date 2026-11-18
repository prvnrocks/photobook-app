# M30 layout builders' brief (from the T3 handoff)

## Your files
`src/lib/layouts/<style>/<format>/index.ts` (+ sibling files in that directory only, e.g. `layouts.ts`, `covers-m30.ts`, your own `geometry.ts`). Do NOT edit `../geometry.ts`, other directories, shared tests, schema or renderer — if you believe one of those must change, stop and report it in your HANDOFF instead.
index.ts exports exactly `<STYLE>_<FORMAT>_LAYOUTS` (the ONE auto cover first, then pages by photo count, then spreads with `twin: [leftId, rightId]` from the same list) and `<STYLE>_<FORMAT>_COVERS` (user cover styles: role "cover", `autoPick: false`, id contains "-cover-", name starts "Cover: "). Already registered in `src/lib/layouts/index.ts`. Order is append-only. Import only types and your own files (never `src/lib/book/dev-m30.ts`).
Id prefixes: magazine portrait `mg-p-`, magazine landscape `mg-l-`, editorial portrait `ed-p-`, editorial landscape `ed-l-`.
Worked examples of every primitive: `src/lib/book/dev-m30.ts` (rendered at `/dev-book-page?sheet=demo`, screenshot `docs/design/m30-demo.png`). Existing style to imitate for file structure, twins, covers: `src/lib/layouts/geometric/`.

## Rules checked by tests
- Covers: one photo slot; exactly one coverTitle and one coverSubtitle; coverLine allowed, each `n` once (0..5); every text ≥ 4 mm inside the trim; landscape ≥ 10 mm from the left (spine) edge; text over the photo allowed.
- Plain rect slots must not overlap; a page/spread `caption` rect must not overlap a slot. Shaped/framed/rotated slots, polygon blocks and plated/rotated text may not cross a spread fold (x = 100). Spreads: x runs 0..200.
- `chapterDescription` not on covers; `coverLine` only on covers.

## Primitives
- Paint order: background, under blocks, photos, over blocks, caption, text panels. Max 8 blocks, 8 texts.
- Block fill: `panel` = dark charcoal of the colourway · `accent` = vivid accent (INVISIBLE on white in the editorial default colourway — use `ink` for rules on white) · `paper` = white · `ink` = near-black.
- Text ink: `ink` near-black · `muted` grey · `accent` deepened accent for white pages · `accentOnDark` vivid accent for panels/photos · `paper` white. On dark surfaces/photos always set ink.
- G0: more fills — `accentOnLight` = accent deepened for white pages (editorial rules, hairlines, bars: use this, not `ink`) · `scrim` = flat 50 % black `over` a photo. Text never sits straight on a photo: put it on a solid block or a scrim (white text only on a scrim; accent text only on `panel` / `ink`). A block may carry `n` with `when: "coverLine"` (tab per cover line). Geometry helpers now live in `src/lib/layouts/page-mm.ts` + `<style>/geometry.ts` (no per-format geometry.ts).
- `when: <binding>` on a block hides it when that binding is empty. Text on a `when` block must bind the SAME binding (else white text lands on a white page when the block collapses). Panels for the description must still look right with no description (rule-built books have none): check `&desc=0`.
- Blocks on a trim edge bleed automatically; a diagonal polygon ending on a trim edge needs ~1 % slack in its box beyond the end vertices.
- `rotate: 90 | -90` on a text: box = the strip as seen on the page (-90 reads bottom-to-top). No plate on rotated text.
- Styles are side-locked: `start` = left, `end` = right, also for Arabic.

## Type (mm on the page; the fitter picks the largest size that fits, shrinks to min, then clips)
- 1 % of width = 1.48 mm portrait / 2.10 mm landscape; 1 % of height = 2.10 mm portrait / 1.48 mm landscape.
- masthead: 40 max / 7 min, line-height 1.0, breaks at words only. Magazine = Archivo Black CAPS (≈ size × 0.748 per char); editorial = Poppins 700 sentence case (≈ size × 0.572 per char). The 31-char fixture title sets 3 lines at ~14.6 mm in an 88 % × 24 % portrait box.
- body (description): 3.2 max / 2.8 min, line-height 1.45 (line pitch 4.64 mm). 45 words ≈ 275 chars: a 56 mm column needs ~10–11 lines (≥ 50 mm tall); an 83 mm column ~7 lines (≥ 34 mm).
- chapter 8 / 3.5 (Poppins 700); title 15 / 5; subtitle and year 4.6 / 2.8 (magazine tracked); page caption fixed 3.85 mm.

## Check your work (required)
- `npm run dev` (port 3000 may be in use by another builder — reuse the running server, do not kill it; AI is replay-only, never call live AI).
- `node scripts/sheet-probe.mjs "sheet=<style>-<format>" <scratch>/out.png` — run plain, `&ar=1`, `&desc=0`, and `--width 375`; it exits 1 on any text overflow. Write screenshots to your scratch/tmp dir, not into docs/design.
- LOOK at the screenshot (Read the PNG) and compare with the reference image: fix clipped/tiny text, unreadable text on photos, awkward gaps, layouts that look like plain grids.
- Tests: `npx vitest run tests/layouts.test.ts tests/layouts-covers.test.ts tests/m30-schema.test.ts tests/m30-render.test.tsx` + `npm run lint` + `npm run typecheck`. Three other builders are editing sibling directories at the same time: a failure that is clearly in another directory is not yours — mention it, don't fix it.
- Commit only your directory with explicit pathspecs.
