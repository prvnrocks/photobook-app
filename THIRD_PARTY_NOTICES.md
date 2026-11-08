# Third-party notices

Photobook ships the following third-party code to browsers. This file must be kept in sync with
`package.json` and linked from the privacy/legal page before launch (M9).

## heic2any (0.0.4) — MIT
- Source: https://github.com/alexcorvi/heic2any
- Used only in a lazily loaded chunk, to convert iPhone HEIC photos to JPEG in the user's own browser
  when the browser cannot decode HEIC natively (D-012).
- **Bundled components under LGPL-3.0:** the heic2any distribution includes Emscripten-compiled
  **libheif** (https://github.com/strukturag/libheif) and **libde265** (https://github.com/strukturag/libde265),
  both licensed under the GNU Lesser General Public License v3.0. The corresponding source code is
  available from those repositories; we will also provide it on request (contact: see privacy page).
  The library is loaded as a separate, replaceable script chunk and is not modified.
- Also bundles **gifshot** (MIT).

## exifr — MIT
- Source: https://github.com/MikeKovarik/exifr — reads photo date/GPS/orientation in the browser.

## zod — MIT
- Source: https://github.com/colinhacks/zod

## Other runtime dependencies
Next.js, React, @supabase/*, @base-ui/react, lucide-react, class-variance-authority, cn, tw-animate-css —
all MIT or similarly permissive; see each package's `LICENSE` in `node_modules/`.

## Follow-up
- Consider replacing heic2any (unmaintained since 0.0.4; old libheif) with a maintained libheif-js wrapper.
