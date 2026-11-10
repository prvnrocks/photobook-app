// Example flipbooks shown on the landing page (M9 T11). Filled by the demo seed (T15, D-061
// comped demo books). Empty → the section is hidden.

export interface ExampleBook {
  /** Public share slug: links to /b/[slug]. */
  slug: string;
  title: string;
  /** Static cover image under /public (e.g. /examples/wedding.jpg) — never a signed URL. */
  coverSrc: string;
}

export const EXAMPLE_BOOKS: readonly ExampleBook[] = [];
