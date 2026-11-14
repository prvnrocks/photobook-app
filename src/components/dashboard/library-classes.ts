// Shared class strings for the books screen (M18). Plain module (no "use client", no cn): the server
// page, the loading skeleton and the client island all import it at zero runtime cost.

/** Full desktop width (max-w-library = 100rem) with gutters that grow on larger screens. */
export const LIBRARY_CONTAINER = "mx-auto w-full max-w-library px-gutter sm:px-6 lg:px-10";

/**
 * The collection grid: auto-fill columns — 1 on very small phones, 2 on phones, 3 on tablets,
 * 4–5 on laptops, 6 at 1600 px.
 */
export const LIBRARY_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-3 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] sm:gap-x-5 sm:gap-y-7 lg:grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))] lg:gap-x-6 lg:gap-y-8";

/** The cover stage behind each book: warm ivory with a soft top light (the "product photo" tile). */
export const LIBRARY_STAGE =
  "bg-[radial-gradient(120%_85%_at_50%_22%,#fdfaf3_0%,#f3ecdd_58%,#e9dfca_100%)]";
