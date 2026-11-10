// Print asset URLs (D-049, M8 T5/T6 contract). Every photo <img> on /print/[bookId] points at a
// reserved, never-resolvable origin; the headless-Chromium renderer intercepts these requests and
// answers with the in-memory print JPEG for that photo (src/lib/pdf/images.ts). All other external
// requests are blocked by the renderer, so this origin is the only one the print page may use.
// Plain module: no secrets, client-safe (also imported by the dev-print fixture).

/** Reserved origin (.invalid never resolves, RFC 6761) for print images. */
export const PRINT_ASSET_ORIGIN = "https://print-assets.invalid";

/** `https://print-assets.invalid/{photoId}.jpg` */
export function printAssetUrl(photoId: string): string {
  return `${PRINT_ASSET_ORIGIN}/${encodeURIComponent(photoId)}.jpg`;
}
