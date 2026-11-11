// Print guard helper (A7): CSS filter rasterises the whole subtree in Chromium PDFs.

/**
 * Tailwind utilities that compile to `filter` / `backdrop-filter` (blur, drop-shadow, grayscale,
 * sepia, brightness, contrast, saturate, hue-rotate, invert, backdrop-*), found in class
 * attributes — the CSS itself isn't in static markup, so `/filter/` alone can't see them.
 */
export function tailwindFilterClasses(html: string): string[] {
  const FILTER_UTILITY = /^-?(blur|drop-shadow|grayscale|sepia|brightness|contrast|saturate|hue-rotate|invert|backdrop)(-|$)/;
  const found: string[] = [];
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of m[1].split(/\s+/)) {
      const utility = token.slice(token.lastIndexOf(":") + 1).replace(/^!/, "");
      if (FILTER_UTILITY.test(utility)) found.push(token);
    }
  }
  return found;
}
