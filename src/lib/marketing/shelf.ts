// Home page bookshelf (M14): sample books shown as spines, the selected one pulled out to its cover.
// Pure data + pure helpers — safe in client and server code, unit-tested in tests/shelf.test.ts.
//
// Assets live in public/home/books. Spines are 386 px tall transparent PNGs; only "The Day We Said
// Yes" has a real cover image (and no spine image — its spine is drawn in CSS). The other covers are
// built from their spine: cloth in the spine colour, the spine's photo shown through a window, the
// title and the spine glyph. Photo / glyph boxes below were measured on the PNGs (source pixels).

export type ShelfCategory = "family" | "travel" | "weddings" | "kids";
export type ShelfFilter = "all" | ShelfCategory;

/** A rectangle in source pixels of the spine PNG. */
export interface SpineBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShelfBook {
  id: string;
  title: string;
  category: ShelfCategory;
  /** Dominant cloth colour (sampled from the spine PNG). */
  color: string;
  /** Text colour family on that cloth: "light" cloth gets ink text, "dark" cloth gets cream text. */
  tone: "light" | "dark";
  /** Spine PNG (natural size). Missing → spine drawn in CSS from colour + title. */
  spine?: { src: string; w: number; h: number; photo: SpineBox; glyph: SpineBox };
  /** Real front cover image (transparent PNG incl. its own soft edge). */
  cover?: { src: string; w: number; h: number };
  /** One short line about this kind of book (preview card). */
  blurb: string;
}

/** Natural spine height of every spine PNG; sizes on screen are ratios of the CSS --spine-h. */
export const SPINE_NATURAL_H = 386;
/** Cover aspect (w / h) — the real cover's, reused for built covers. */
export const COVER_ASPECT = 362 / 419;
/** Width (source px) of the CSS-drawn spine used when a book has no spine PNG. */
export const DRAWN_SPINE_W = 100;

const DIR = "/home/books";

/** Decorative partial spines at the two ends of the shelf. */
export const SHELF_EDGES = {
  left: { src: `${DIR}/00-left-edge-partial.png`, w: 40, h: SPINE_NATURAL_H },
  right: { src: `${DIR}/15-right-edge-partial.png`, w: 24, h: SPINE_NATURAL_H },
} as const;

// Photo window: measured frame inset 2 px so the window shows photo only (no frame edge).
function spine(file: string, w: number, x0: number, x1: number, y1: number, glyphCx = w / 2) {
  const y0 = 44;
  return {
    src: `${DIR}/${file}`,
    w,
    h: SPINE_NATURAL_H,
    photo: { x: x0 + 2, y: y0 + 2, w: x1 - x0 - 4, h: y1 - y0 - 4 },
    glyph: { x: Math.round(glyphCx - 22), y: 309, w: 44, h: 44 },
  };
}

export const SHELF_BOOKS: readonly ShelfBook[] = [
  {
    id: "our-family",
    title: "Our Family",
    category: "family",
    color: "#343729",
    tone: "dark",
    spine: spine("01-our-family.png", 107, 18, 86, 131),
    blurb: "Birthdays, Sunday lunches and the ordinary days you'll want back.",
  },
  {
    id: "little-years",
    title: "Little Years",
    category: "kids",
    color: "#ddc5ae",
    tone: "light",
    spine: spine("02-little-years.png", 97, 16, 80, 135),
    blurb: "First words, messy faces and how fast they grew — one book a year.",
  },
  {
    id: "summer-abroad",
    title: "Summer Abroad",
    category: "travel",
    color: "#863f26",
    tone: "dark",
    spine: spine("03-summer-abroad.png", 100, 16, 81, 145),
    blurb: "A summer trip, day by day, with the places named for you.",
  },
  {
    id: "mountain-days",
    title: "Mountain Days",
    category: "travel",
    color: "#323b46",
    tone: "dark",
    spine: spine("04-mountain-days.png", 98, 15, 80, 145),
    blurb: "Trails, peaks and the views that didn't fit in one photo.",
  },
  {
    id: "sunday-walks",
    title: "Sunday Walks",
    category: "family",
    color: "#564f2b",
    tone: "dark",
    spine: spine("05-sunday-walks.png", 92, 14, 75, 142),
    blurb: "Slow weekends, the park and the dog who stole every shot.",
  },
  {
    id: "desert-days",
    title: "Desert Days",
    category: "travel",
    color: "#d6bea8",
    tone: "light",
    spine: spine("06-desert-days.png", 89, 13, 74, 144),
    blurb: "Dunes at sunset, camp nights and long drives through the sand.",
  },
  {
    id: "first-steps",
    title: "First Steps",
    category: "kids",
    color: "#586876",
    tone: "dark",
    spine: spine("07-first-steps.png", 92, 13, 73, 145),
    blurb: "The wobbly first year, from the first smile to the first steps.",
  },
  {
    id: "the-day-we-said-yes",
    title: "The Day We Said Yes",
    category: "weddings",
    color: "#e6d2bf",
    tone: "light",
    cover: { src: `${DIR}/08-the-day-we-said-yes-cover.png`, w: 362, h: 419 },
    blurb: "Your engagement or wedding day, told in order — with captions in English or Arabic.",
  },
  {
    id: "the-wedding",
    title: "The Wedding",
    category: "weddings",
    color: "#d1b9a1",
    tone: "light",
    spine: spine("09-the-wedding.png", 105, 30, 91, 130, 61),
    blurb: "Henna night to the last dance, ready to share with every guest.",
  },
  {
    id: "forest-retreat",
    title: "Forest Retreat",
    category: "travel",
    color: "#363d2f",
    tone: "dark",
    spine: spine("10-forest-retreat.png", 109, 23, 94, 145),
    blurb: "A quiet escape among the trees, grouped by day and place.",
  },
  {
    id: "island-escape",
    title: "Island Escape",
    category: "travel",
    color: "#823e29",
    tone: "dark",
    spine: spine("11-island-escape.png", 90, 17, 81, 145),
    blurb: "Beach days and sunsets, minus the blurry shots and duplicates.",
  },
  {
    id: "a-year-abroad",
    title: "A Year Abroad",
    category: "travel",
    color: "#33383d",
    tone: "dark",
    spine: spine("12-a-year-abroad.png", 108, 21, 91, 145),
    blurb: "A whole year in a new city, month by month.",
  },
  {
    id: "new-beginnings",
    title: "New Beginnings",
    category: "kids",
    color: "#dcc4ad",
    tone: "light",
    spine: spine("13-new-beginnings.png", 99, 17, 85, 145),
    blurb: "Welcome home, little one — the first weeks, gently laid out.",
  },
  {
    id: "family-reunion",
    title: "Family Reunion",
    category: "family",
    color: "#504726",
    tone: "dark",
    spine: spine("14-family-reunion.png", 99, 19, 84, 145),
    blurb: "Everyone together for once — every cousin, every table.",
  },
];

export const SHELF_DEFAULT_ID = "the-day-we-said-yes";

export const SHELF_FILTERS: readonly { id: ShelfFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "family", label: "Family" },
  { id: "travel", label: "Travel" },
  { id: "weddings", label: "Weddings" },
  { id: "kids", label: "Kids" },
];

export function filterShelf(books: readonly ShelfBook[], filter: ShelfFilter): ShelfBook[] {
  return filter === "all" ? [...books] : books.filter((b) => b.category === filter);
}

/** Selection kept when still visible; else the default book; else the middle visible book. */
export function selectionAfterFilter(visible: readonly ShelfBook[], currentId: string, defaultId = SHELF_DEFAULT_ID): string | null {
  if (visible.length === 0) return null;
  if (visible.some((b) => b.id === currentId)) return currentId;
  if (visible.some((b) => b.id === defaultId)) return defaultId;
  return visible[Math.floor((visible.length - 1) / 2)].id;
}

/** Move the selection by `delta` within the visible books, clamped at the ends (no wrap). */
export function stepSelection(visible: readonly ShelfBook[], currentId: string, delta: number): string {
  const i = visible.findIndex((b) => b.id === currentId);
  if (i < 0) return visible[0]?.id ?? currentId;
  const next = Math.min(visible.length - 1, Math.max(0, i + delta));
  return visible[next].id;
}

/** Spine width as a ratio of the on-screen spine height. */
export function spineRatio(book: ShelfBook): number {
  return (book.spine?.w ?? DRAWN_SPINE_W) / SPINE_NATURAL_H;
}

/**
 * Where the selected book's slot starts on the track, as `ratio × --spine-h + gaps × --gap`
 * (left edge + one gap, then every visible spine before it with its gap). The component centres it:
 * translateX(-(that + --slot-w / 2)) from a track anchored at 50 %.
 */
export function trackShift(visible: readonly ShelfBook[], selectedId: string): { ratio: number; gaps: number } {
  const i = Math.max(
    0,
    visible.findIndex((b) => b.id === selectedId),
  );
  let ratio = SHELF_EDGES.left.w / SPINE_NATURAL_H;
  for (const b of visible.slice(0, i)) ratio += spineRatio(b);
  return { ratio: Math.round(ratio * 10000) / 10000, gaps: i + 1 };
}

const pct = (n: number) => `${Math.round(n * 100) / 100}%`;

/** CSS that shows one box of the spine PNG as a background filling an element of the box's aspect. */
export function spineCropStyle(book: ShelfBook, box: "photo" | "glyph") {
  const s = book.spine;
  if (!s) return null;
  const b = s[box];
  return {
    aspectRatio: `${b.w} / ${b.h}`,
    backgroundImage: `url(${s.src})`,
    backgroundSize: `${pct((s.w / b.w) * 100)} ${pct((s.h / b.h) * 100)}`,
    backgroundPosition: `${pct((b.x / (s.w - b.w)) * 100)} ${pct((b.y / (s.h - b.h)) * 100)}`,
    backgroundRepeat: "no-repeat",
  } as const;
}
