# Design assets — licence

Everything under `public/design/` is original work made for this project. No third-party
artwork, photos, scans, fonts or samples were used or traced.

## Textures (`public/design/textures/`)

Generated procedurally by [`scripts/gen-textures.mjs`](../../scripts/gen-textures.mjs) from
SVG filter primitives (feTurbulence, feColorMatrix, feComposite, feDisplacementMap) with fixed
seeds, rasterised and encoded with sharp. Re-running the script reproduces the files
(`scripts/textures-manifest.json` records sizes, SHA-256 hashes and the sharp/libvips versions used).

- paper-cream, paper-white, linen, kraft — seamless 512 px tiles (webp for screen, JPEG for print)
- watercolour-blush, watercolour-sky — full-sheet washes, one per orientation

## Licence

Released under **CC0 1.0 Universal** (public domain dedication):
https://creativecommons.org/publicdomain/zero/1.0/

To the extent possible under law, the authors have waived all copyright and related or
neighbouring rights to these assets. You may copy, modify and use them for any purpose,
commercial or not, without asking permission or giving attribution.
