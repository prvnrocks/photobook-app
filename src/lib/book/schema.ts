// Zod schemas for the book document (`books.doc`) — the single source of truth rendered by
// editor, flipbook viewer and PDF. See docs/PLAN.md → "Book document format".
// Pure (no server-only): used by client editor, API routes and the AI pipeline.
//
// Two stored versions (M10, D-062): v1 (M1–M9: A5 portrait, hex background) and v2 (formats,
// Background union, design style, page backgrounds). parseBookDoc accepts both and ALWAYS returns
// v2 (src/lib/book/doc-version.ts upgrades v1 1:1); writers go through serializeDoc, which writes
// v1 whenever the doc uses no v2-only feature, so existing books stay byte-identical.

import { z } from "zod";
import { LIMITS } from "@/lib/ai/limits";
import { BACKGROUND_VEIL_MAX, BACKGROUND_VEIL_MIN, TEXTURE_IDS } from "@/lib/design/backgrounds";
import { getLayout, SAFE_MM } from "@/lib/layouts";
import { codePointLength, hasLoneSurrogate } from "@/lib/text/clip";
import { pageMm } from "./format";
import {
  CIRCLE_TOLERANCE_MM,
  EDGE_GAP_MM,
  frameInsetMm,
  MIN_PHOTO_MM,
  MM_EPS,
  rotatedBoundsPct,
  type BoundsPct,
} from "./slot-geometry";
import { spreadIssues, spreadIssueText } from "./spreads";
import { BOOK_TITLE_MAX_CODE_POINTS, CAPTION_LANGS, OCCASIONS, TONES } from "./options";

export const OccasionSchema = z.enum(OCCASIONS);
export const ToneSchema = z.enum(TONES);
export const CaptionLangSchema = z.enum(CAPTION_LANGS);

/**
 * Text that Postgres jsonb accepts: no unpaired UTF-16 surrogates (e.g. half an emoji from a bad
 * `slice`). Without this a doc passes validation and then fails on write, every time.
 */
const NO_LONE_SURROGATE = { message: "contains an unpaired UTF-16 surrogate" };
const wellFormed = (s: string) => !hasLoneSurrogate(s);
/** String of at most `maxUnits` UTF-16 units (zod .max counts `.length`), well-formed. */
const text = (maxUnits: number) => z.string().max(maxUnits).refine(wellFormed, NO_LONE_SURROGATE);

const IdSchema = z.string().min(1).max(64).refine(wellFormed, NO_LONE_SURROGATE);
const FontSchema = z.string().regex(/^[A-Za-z0-9 ]{1,40}$/);

/** Focal point (x, y as 0..1 of the photo) + zoom (1 = cover the slot exactly). */
export const CropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  zoom: z.number().min(1).max(4),
});

export const SlotSchema = z.object({
  photoId: IdSchema.nullable(),
  crop: CropSchema,
});

/**
 * `source` records who wrote the text: "ai" (pipeline), "user" (typed/edited in the editor —
 * must never be overwritten by AI), "auto" (rule-based fallback, e.g. date/place label).
 */
export const CaptionSchema = z.object({
  text: text(200),
  font: FontSchema,
  align: z.enum(["left", "center", "right"]),
  source: z.enum(["ai", "user", "auto"]),
});

export const ChapterSchema = z.object({
  id: IdSchema,
  title: text(80),
  dateLabel: text(40),
  place: text(80).nullable(),
});

export const CoverSchema = z.object({
  layout: IdSchema,
  photoId: IdSchema.nullable(),
  /**
   * The user's book title, never shortened: limit is BOOK_TITLE_MAX_CODE_POINTS (120) code points,
   * same unit as TITLE_MAX_CHARS / Postgres char_length. The zod .max(240) is the matching UTF-16
   * bound (each code point is ≤ 2 units); the refine enforces the real code-point limit.
   */
  title: text(BOOK_TITLE_MAX_CODE_POINTS * 2).refine(
    (s) => codePointLength(s) <= BOOK_TITLE_MAX_CODE_POINTS,
    { message: `more than ${BOOK_TITLE_MAX_CODE_POINTS} code points` },
  ),
  subtitle: text(120),
});

export const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

// --- Backgrounds (v2) ----------------------------------------------------------------------------
// The texture ids and veil range come from src/lib/design/backgrounds.ts (catalogue + rendering
// helpers); the zod schema — and the `Background` type inferred from it — live here. Strict:
// an unknown key inside a background rejects the doc (never silently dropped).

export const ColorBackgroundSchema = z.strictObject({ kind: z.literal("color"), hex: HexColorSchema });
export const TextureBackgroundSchema = z.strictObject({
  kind: z.literal("texture"),
  textureId: z.enum(TEXTURE_IDS),
  /** Optional #RRGGBB multiplied over the texture. */
  tint: HexColorSchema.optional(),
});
export const PhotoBackgroundSchema = z.strictObject({
  kind: z.literal("photo"),
  /** photos.id (uuid) of one of the book's photos. */
  photoId: z.uuid(),
  /** Veil opacity over the photo (faded photo look; no blur — D-062 / plan decision 10). */
  veil: z.number().min(BACKGROUND_VEIL_MIN).max(BACKGROUND_VEIL_MAX),
  veilColor: HexColorSchema,
});

export const BackgroundSchema = z.discriminatedUnion("kind", [
  ColorBackgroundSchema,
  TextureBackgroundSchema,
  PhotoBackgroundSchema,
]);

/** Who chose a page background: AI never overwrites a "user" background. Required. */
export const BackgroundSourceSchema = z.enum(["ai", "user"]);
const withSource = { source: BackgroundSourceSchema };
export const PageBackgroundSchema = z.discriminatedUnion("kind", [
  ColorBackgroundSchema.extend(withSource),
  TextureBackgroundSchema.extend(withSource),
  PhotoBackgroundSchema.extend(withSource),
]);

export const BOOK_FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const;
export const BookFormatSchema = z.enum(BOOK_FORMATS);
export const DESIGN_STYLES = ["classic", "modern", "geometric", "scrapbook"] as const;
export const DesignStyleSchema = z.enum(DESIGN_STYLES);
export const DEFAULT_DESIGN_STYLE = "classic" satisfies (typeof DESIGN_STYLES)[number];

/** Slots per page: v1 docs keep the M1–M9 cap; v2 allows dense grids (M10b). */
export const MAX_SLOTS_V1 = 8;
export const MAX_SLOTS_V2 = 12;

// --- Page + style, v1 (stored by M1–M9) ----------------------------------------------------------

export const PageSchemaV1 = z.object({
  id: IdSchema,
  chapterId: IdSchema.nullable(),
  layout: IdSchema,
  slots: z.array(SlotSchema).max(MAX_SLOTS_V1),
  caption: CaptionSchema.nullable(),
});

export const StyleSchemaV1 = z.object({
  background: HexColorSchema,
  font: FontSchema,
});

// --- Page + style, v2 (in-memory shape everywhere) -----------------------------------------------

export const PageSchema = z.object({
  id: IdSchema,
  chapterId: IdSchema.nullable(),
  layout: IdSchema,
  slots: z.array(SlotSchema).max(MAX_SLOTS_V2),
  caption: CaptionSchema.nullable(),
  /** Page override of style.background; absent/null = the book default. */
  background: PageBackgroundSchema.nullable().optional(),
  /** Half of a spread layout (M10b, plan decision 2). Accepted now, not used yet. */
  side: z.enum(["left", "right"]).optional(),
});

export const StyleSchema = z.object({
  /** Book default background. */
  background: BackgroundSchema,
  /** Absent = "classic". */
  designStyle: DesignStyleSchema.optional(),
  font: FontSchema,
});

export const GENERATORS = ["rule", "ai"] as const;
export const GeneratorSchema = z.enum(GENERATORS);

/**
 * Album origin marker (D-018). Optional on the doc: a doc without `meta` (written by M2) means
 * "rule-built, not edited". The AI may replace `books.doc` only when it is `{}` or
 * `meta.userEdited === false` (see src/lib/book/replaceable.ts).
 *
 * Strict: unknown keys inside `meta` are REJECTED (the whole doc fails to parse), not stripped.
 * `meta` drives an overwrite decision, so an unexpected shape must land on the safe side —
 * docOrigin() treats an unparsable doc as user-edited and it is never overwritten.
 */
export const DocMetaSchema = z
  .object({
    generator: GeneratorSchema,
    generatorVersion: z.number().int().min(1),
    /** agent_runs.id for AI-built docs; null for rule-built docs. */
    runId: z.uuid().nullable(),
    /** Set to true by the editor (M5) on the first user change; AI never overwrites it. */
    userEdited: z.boolean(),
  })
  .strict();

/** The stored M1–M9 shape. Only used to read old rows and by serializeDoc's v1 output. */
export const BookDocV1Schema = z.object({
  version: z.literal(1),
  format: z.literal("A5_PORTRAIT"),
  occasion: OccasionSchema,
  cover: CoverSchema,
  chapters: z.array(ChapterSchema).max(100),
  pages: z.array(PageSchemaV1).max(LIMITS.paid.maxPages),
  style: StyleSchemaV1,
  meta: DocMetaSchema.optional(),
});

/** v2 — what parseBookDoc returns and every renderer/editor/AI step works on. */
export const BookDocSchema = z.object({
  version: z.literal(2),
  format: BookFormatSchema,
  occasion: OccasionSchema,
  cover: CoverSchema,
  chapters: z.array(ChapterSchema).max(100),
  pages: z.array(PageSchema).max(LIMITS.paid.maxPages),
  style: StyleSchema,
  meta: DocMetaSchema.optional(),
});

/** Rectangle in % of the page (0..100). */
export const RectSchema = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  w: z.number().positive().max(100),
  h: z.number().positive().max(100),
});

export const LayoutSlotSchema = RectSchema;

// --- Layout definition v2 (M10b A2) --------------------------------------------------------------
// Layouts are pure data (src/lib/layouts). Every layout declares the book format and design style
// it belongs to; a doc may only use layouts of its own format (validateBookDoc).
//
// Coordinates: rects are % of ONE trim page for "page" and "cover" layouts (0..100), and % of a
// page width across BOTH facing pages for "spread" layouts — x runs 0..200 (0..100 = left page,
// 100..200 = right page), y stays 0..100. Storage of spreads: see src/lib/book/spreads.ts.

export const LAYOUT_ROLES = ["cover", "page", "spread"] as const;

/** Data a text panel shows. Only existing doc data — panels never hold their own text. */
export const TEXT_BINDINGS = ["chapterTitle", "dateLabel", "pageCaption", "coverTitle", "coverSubtitle"] as const;
/**
 * Font role of a text panel = TEXT_ROLES of src/lib/design/styles.ts (A3): the design style maps
 * each role to a face via roleFont(style, role, …). Duplicated as a literal list (schema stays
 * free of font imports); tests/book-spreads.test.ts asserts both lists are equal.
 */
export const TEXT_FONT_ROLES = ["title", "subtitle", "year", "chapter", "caption"] as const;

/** Rect for layout data: x/w may reach 200 (spreads); the per-role bound is checked on the layout. */
const LayoutRectSchema = z.object({
  x: z.number().min(0).max(200),
  y: z.number().min(0).max(100),
  w: z.number().positive().max(200),
  h: z.number().positive().max(100),
});

// --- Shaped / tilted / framed slots + decorations (M10c T1) --------------------------------------
// All optional: a slot without them is the M1–M10b plain rect (absent = rect, 0°, no frame, no
// shadow, z = slot index order). Geometry maths (photo rect, clip-path, hit test, rotated bounds)
// lives in ./slot-geometry — the single source for render, crop, low-res and the image plan.

/** Max slot / text tilt in degrees (either way). */
export const SLOT_ROTATE_MAX = 12;
/** Max decoration tilt in degrees (tape is often laid at ~45°). */
export const DECORATION_ROTATE_MAX = 45;
/**
 * Reserved decoration id: "the occasion accent" — the renderer picks the actual sticker from
 * doc.occasion (M10c D4). Same value as OCCASION_ACCENT in src/lib/design/stickers.ts (kept as a
 * literal so the schema stays free of artwork imports; tests assert they match). Always accepted
 * for kind "sticker" decorations.
 */
export const ACCENT_STICKER_ID = "occasion-accent";

const PolygonPointSchema = z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]);

/**
 * Clip shape of a slot. Points / radii are relative to the slot box: polygon points are [x, y] in %
 * of the slot (0..100); `rounded.r` is a corner radius in mm. circle = the ellipse inscribed in the
 * slot (the slot must be square in mm); hexagon (flat top) and diamond are fixed polygons
 * (slot-geometry SHAPE_POLYGONS).
 */
export const SlotShapeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("rect") }),
  z.strictObject({ kind: z.literal("rounded"), r: z.number().positive().max(30) }),
  z.strictObject({ kind: z.literal("circle") }),
  z.strictObject({ kind: z.literal("ellipse") }),
  z.strictObject({ kind: z.literal("hexagon") }),
  z.strictObject({ kind: z.literal("diamond") }),
  z.strictObject({ kind: z.literal("polygon"), points: z.array(PolygonPointSchema).min(3).max(16) }),
]);

/**
 * Frame drawn inside the slot box: the photo sits in the slot minus the frame inset
 * (slot-geometry photoRectOf). border = even `mm` band of `hex`; polaroid = white card with `side`
 * mm on left/top/right and `bottom` mm at the bottom (rect / rounded slots only).
 */
export const SlotFrameSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("border"), mm: z.number().positive().max(10), hex: HexColorSchema }),
  z.strictObject({
    kind: z.literal("polaroid"),
    side: z.number().positive().max(15),
    bottom: z.number().positive().max(30),
  }),
]);

export const SLOT_SHADOWS = ["none", "soft", "lifted"] as const;

/**
 * A layout slot: rect (% of the page; spreads x 0..200) + optional M10c fields. Strict, so a typo
 * in layout data ("rotation") fails the catalogue tests instead of being dropped.
 */
export const LayoutSlotDefSchema = z.strictObject({
  x: z.number().min(0).max(200),
  y: z.number().min(0).max(100),
  w: z.number().positive().max(200),
  h: z.number().positive().max(100),
  shape: SlotShapeSchema.optional(),
  /** Degrees clockwise about the slot centre; |rotate| ≤ SLOT_ROTATE_MAX. */
  rotate: z.number().min(-SLOT_ROTATE_MAX).max(SLOT_ROTATE_MAX).optional(),
  frame: SlotFrameSchema.optional(),
  /** box-shadow preset (never CSS filter — print rule D-062). */
  shadow: z.enum(SLOT_SHADOWS).optional(),
  /** Paint order: higher on top; ties keep slot order. Absent = 0. */
  z: z.number().int().min(0).max(20).optional(),
});

/** Sticker-catalogue id (src/lib/design/stickers.ts) — existence checked by layoutIssues(…, { stickerIds }). */
const StickerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const DECORATION_KINDS = ["sticker", "tape", "plate"] as const;

/**
 * Pure-decoration artwork from the sticker catalogue, positioned in layout units (% of the page;
 * spreads x 0..200). `under` paints between background and photos, `over` above photos (below
 * text). Never selectable, never holds a photo or text.
 */
export const LayoutDecorationSchema = z.strictObject({
  kind: z.enum(DECORATION_KINDS),
  id: StickerIdSchema,
  box: LayoutRectSchema,
  rotate: z.number().min(-DECORATION_ROTATE_MAX).max(DECORATION_ROTATE_MAX).optional(),
  layer: z.enum(["under", "over"]),
  tint: HexColorSchema.optional(),
});

/** Label plate behind a text panel (fills the panel box). `id` = a plate sticker id. */
export const TextPlateSchema = z.strictObject({
  id: StickerIdSchema,
  tint: HexColorSchema.optional(),
});

export const LayoutTextSchema = z.strictObject({
  bind: z.enum(TEXT_BINDINGS),
  box: LayoutRectSchema,
  align: z.enum(["start", "center", "end"]),
  font: z.enum(TEXT_FONT_ROLES),
  plate: TextPlateSchema.optional(),
  /** Degrees clockwise about the box centre (text stays live text). */
  rotate: z.number().min(-SLOT_ROTATE_MAX).max(SLOT_ROTATE_MAX).optional(),
});

const LayoutObjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /**
   * "cover" layouts are only valid for `doc.cover`, "page" layouts for single `doc.pages`
   * entries, "spread" layouts for a left/right page pair (spreads.ts).
   */
  role: z.enum(LAYOUT_ROLES),
  style: DesignStyleSchema,
  format: BookFormatSchema,
  photoCount: z.number().int().min(1).max(MAX_SLOTS_V2),
  prefers: z.array(z.enum(["portrait", "landscape", "any"])),
  slots: z.array(LayoutSlotDefSchema).max(MAX_SLOTS_V2),
  caption: LayoutRectSchema.nullable(),
  /** Spreads only (required there): the [left, right] single-page layouts it splits into (D-064). */
  twin: z.tuple([IdSchema, IdSchema]).optional(),
  /** Text panels bound to doc data (chapter title, date label, caption, cover title/subtitle). */
  texts: z.array(LayoutTextSchema).max(8).optional(),
  /**
   * Covers only (M10b A9): split-strip windows onto the ONE cover photo. The cover has exactly
   * one slot (photoCount 1) = the box the photo is laid out over (cover-fit, crop as usual); the
   * renderer draws it once, clipped to each slice — page background shows in the gaps. Slices
   * are % of the page and lie inside the slot box.
   */
  slices: z.array(LayoutRectSchema).min(2).max(8).optional(),
  /** M10c: stickers / tape / label plates (pure decoration, sticker-catalogue ids). */
  decorations: z.array(LayoutDecorationSchema).max(16).optional(),
});

type LayoutObject = z.infer<typeof LayoutObjectSchema>;

export interface LayoutCheckOptions {
  /**
   * Known sticker-catalogue ids (src/lib/design/stickers.ts). When given, every decoration id and
   * text plate id must be in it (ACCENT_STICKER_ID is always accepted for decorations). Absent =
   * id format is checked only (LayoutSchema); the catalogue test passes the real set.
   */
  stickerIds?: ReadonlySet<string>;
  /**
   * Optional sticker id → catalogue kind (StickerDef.kind). When given, a decoration's kind must
   * match its sticker's kind and a text plate must be a "plate" sticker (also implies existence).
   */
  stickerKinds?: ReadonlyMap<string, (typeof DECORATION_KINDS)[number]>;
}

/** Builds the layout schema; pass `stickerIds` to also check decoration ids against a catalogue. */
export function makeLayoutSchema(opts: LayoutCheckOptions = {}) {
  return LayoutObjectSchema.superRefine((l, ctx) => {
    for (const message of layoutIssues(l, opts)) ctx.addIssue({ code: "custom", message });
  });
}

/**
 * Semantic layout checks (messages contain no user data). M10b: slices, rects inside the role's
 * area, twin rules. M10c: shape/frame/rotation/decoration geometry — see m10cLayoutIssues.
 */
export function layoutIssues(l: LayoutObject, opts: LayoutCheckOptions = {}): string[] {
  const issues: string[] = [];
  if (l.slices) {
    const s = l.slots[0];
    if (l.role !== "cover" || l.photoCount !== 1 || l.slots.length !== 1 || !s) {
      issues.push("slices need a cover layout with exactly one slot");
    } else if (
      l.slices.some(
        (r) => r.x < s.x - 1e-6 || r.y < s.y - 1e-6 || r.x + r.w > s.x + s.w + 1e-6 || r.y + r.h > s.y + s.h + 1e-6,
      )
    ) {
      issues.push("slice outside the cover slot");
    }
  }
  const maxX = l.role === "spread" ? 200 : 100;
  const rects = [...l.slots, ...(l.caption ? [l.caption] : []), ...(l.texts ?? []).map((t) => t.box)];
  if (rects.some((r) => r.x + r.w > maxX + 1e-9 || r.y + r.h > 100 + 1e-9)) {
    issues.push(`rect outside the ${l.role} area`);
  }
  if (l.role === "spread" && !l.twin) issues.push("spread needs a twin");
  if (l.role !== "spread" && l.twin) issues.push("only spreads have a twin");
  issues.push(...m10cLayoutIssues(l, opts));
  return issues;
}

/** Layout definition. Sticker ids are format-checked only — see layoutIssues(…, { stickerIds }). */
export const LayoutSchema = makeLayoutSchema();

/**
 * M10c geometry rules (all in mm on the layout's own format; spreads: x 0..200 = both pages):
 * - framed or rotated slots: rotated bounding box ≥ SAFE_MM inside the trim (no bleed for objects);
 * - rounded / circle / ellipse slots never touch the trim (their bleed would change the shape);
 *   circle slots are square in mm; polaroid frames only on rect / rounded slots; the frame inset
 *   leaves a photo area;
 * - rotated / plated texts: rotated box ≥ SAFE_MM inside the trim;
 * - decorations: rotated box inside the trim;
 * - spreads: no shaped / framed / rotated slot, decoration or plated / rotated text crosses the
 *   fold (x = 100). Plain rect slots may (panoramas).
 * - stickerIds (when given): decoration and plate ids exist.
 */
function m10cLayoutIssues(l: LayoutObject, { stickerIds, stickerKinds }: LayoutCheckOptions): string[] {
  const issues: string[] = [];
  const page = pageMm(l.format);
  const maxX = l.role === "spread" ? 200 : 100;
  const eps = 1e-6;
  const insideTrim = (b: BoundsPct, marginMm: number) =>
    (b.x0 / 100) * page.w >= marginMm - MM_EPS &&
    (b.y0 / 100) * page.h >= marginMm - MM_EPS &&
    ((maxX - b.x1) / 100) * page.w >= marginMm - MM_EPS &&
    ((100 - b.y1) / 100) * page.h >= marginMm - MM_EPS;
  const crossesFold = (b: BoundsPct) => l.role === "spread" && b.x0 < 100 - eps && b.x1 > 100 + eps;

  l.slots.forEach((s, i) => {
    const at = `slot ${i}`;
    const shape = s.shape?.kind ?? "rect";
    const framed = (s.frame?.kind ?? "none") !== "none";
    const rotated = (s.rotate ?? 0) !== 0;
    const b = rotatedBoundsPct(s, s.rotate ?? 0, page);
    if ((framed || rotated) && !insideTrim(b, SAFE_MM)) issues.push(`${at}: framed/rotated slot outside the ${SAFE_MM} mm safe zone`);
    if ((shape === "rounded" || shape === "circle" || shape === "ellipse") && !insideTrim(b, EDGE_GAP_MM)) {
      issues.push(`${at}: ${shape} slot touches the trim`);
    }
    if (shape === "circle" && Math.abs((s.w / 100) * page.w - (s.h / 100) * page.h) > CIRCLE_TOLERANCE_MM) {
      issues.push(`${at}: circle slot is not square in mm`);
    }
    if (s.frame?.kind === "polaroid" && shape !== "rect" && shape !== "rounded") {
      issues.push(`${at}: polaroid frame needs a rect or rounded slot`);
    }
    if (framed) {
      const inset = frameInsetMm(s.frame);
      const wMm = (s.w / 100) * page.w - inset.left - inset.right;
      const hMm = (s.h / 100) * page.h - inset.top - inset.bottom;
      if (wMm < MIN_PHOTO_MM || hMm < MIN_PHOTO_MM) issues.push(`${at}: frame leaves no photo area`);
    }
    if ((shape !== "rect" || framed || rotated) && crossesFold(b)) issues.push(`${at}: shaped slot crosses the fold`);
  });

  (l.texts ?? []).forEach((t, i) => {
    if (!t.plate && !t.rotate) return;
    const b = rotatedBoundsPct(t.box, t.rotate ?? 0, page);
    if (!insideTrim(b, SAFE_MM)) issues.push(`text ${i}: rotated/plated text outside the ${SAFE_MM} mm safe zone`);
    if (crossesFold(b)) issues.push(`text ${i}: plated text crosses the fold`);
    if (t.plate && stickerIds && !stickerIds.has(t.plate.id)) issues.push(`text ${i}: unknown plate "${t.plate.id}"`);
    if (t.plate && stickerKinds && stickerKinds.get(t.plate.id) !== "plate") issues.push(`text ${i}: "${t.plate.id}" is not a plate`);
  });

  (l.decorations ?? []).forEach((d, i) => {
    const b = rotatedBoundsPct(d.box, d.rotate ?? 0, page);
    if (!insideTrim(b, 0)) issues.push(`decoration ${i}: outside the trim`);
    if (crossesFold(b)) issues.push(`decoration ${i}: crosses the fold`);
    const accent = d.id === ACCENT_STICKER_ID;
    if (accent && d.kind !== "sticker") issues.push(`decoration ${i}: the occasion accent must be kind sticker`);
    if (!accent && stickerIds && !stickerIds.has(d.id)) issues.push(`decoration ${i}: unknown sticker "${d.id}"`);
    if (!accent && stickerKinds && stickerKinds.get(d.id) !== d.kind) issues.push(`decoration ${i}: "${d.id}" is not a ${d.kind}`);
  });
  return issues;
}

export type ParseResult =
  | { ok: true; doc: z.infer<typeof BookDocSchema> }
  | { ok: false; issues: string[] };

/**
 * Shape check only. Accepts a stored v1 or v2 doc and ALWAYS returns v2 (v1 is upgraded 1:1, see
 * upgradeDocV1). `version` picks the schema; anything else (missing, 3, …) is checked against v2
 * so the issue list names the version. Issues contain paths + zod codes, never field values.
 */
export function parseBookDoc(input: unknown): ParseResult {
  const version = input !== null && typeof input === "object" ? (input as { version?: unknown }).version : undefined;
  if (version === 1) {
    const r = BookDocV1Schema.safeParse(input);
    if (r.success) return { ok: true, doc: upgradeV1(r.data) };
    return { ok: false, issues: zodIssues(r.error) };
  }
  const r = BookDocSchema.safeParse(input);
  if (r.success) return { ok: true, doc: r.data };
  return { ok: false, issues: zodIssues(r.error) };
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`);
}

/**
 * v1 → v2, 1:1 (re-exported as upgradeDocV1 from doc-version.ts). Lives here so parseBookDoc has
 * no import cycle. Only copies known keys: the result must serialize back to the same v1 JSON.
 */
export function upgradeV1(v1: z.infer<typeof BookDocV1Schema>): z.infer<typeof BookDocSchema> {
  const doc: z.infer<typeof BookDocSchema> = {
    version: 2,
    format: v1.format,
    occasion: v1.occasion,
    cover: { ...v1.cover },
    chapters: v1.chapters.map((c) => ({ ...c })),
    pages: v1.pages.map((p) => ({
      id: p.id,
      chapterId: p.chapterId,
      layout: p.layout,
      slots: p.slots.map((s) => ({ photoId: s.photoId, crop: { ...s.crop } })),
      caption: p.caption === null ? null : { ...p.caption },
    })),
    style: { background: { kind: "color", hex: v1.style.background }, designStyle: DEFAULT_DESIGN_STYLE, font: v1.style.font },
  };
  if (v1.meta !== undefined) doc.meta = { ...v1.meta };
  return doc;
}

export interface ValidateOptions {
  /** Ids of the book's photos that may be placed (e.g. status = ready, not excluded). */
  photoIds: Set<string>;
  /**
   * Ids a photo background (book default or page override) may use. Default = photoIds.
   * Wider than photoIds where a user may pick an AI-dropped photo as a faded background (D-062):
   * Update album passes every ready photo (kept + dropped) here and only kept ones in photoIds.
   * AI-built docs keep the default (AI background suggestions must use kept photos only).
   */
  backgroundPhotoIds?: ReadonlySet<string>;
  maxPages: number;
}

/**
 * Semantic checks on a shape-valid doc: layouts exist, match role and the doc's format, slot
 * count == photoCount (a spread's right half: 0 slots, no caption), spreads aligned (spreads.ts),
 * photos exist and are used at most once in pages (the cover photo may appear once more),
 * page count ≤ maxPages, chapter/page ids unique, chapterIds exist, photo backgrounds (book
 * default and page overrides) use a known photo (backgroundPhotoIds, default photoIds) — a
 * background photo may also be on a page.
 * Returns [] when valid. Issue strings contain indices and layout ids only — no user data.
 */
export function validateBookDoc(
  doc: z.infer<typeof BookDocSchema>,
  { photoIds, backgroundPhotoIds = photoIds, maxPages }: ValidateOptions,
): string[] {
  const issues: string[] = [];
  // M10b A6 (D-063): a book uses only layouts of its own design style — strict, no cross-style
  // fallback (classic books classic layouts, modern books modern layouts). Server writers stamp
  // doc.format / doc.style.designStyle from books.format / books.design_style first
  // (src/lib/book/book-design.ts), so both layout checks are checks against the book's columns.
  const bookStyle = doc.style.designStyle ?? DEFAULT_DESIGN_STYLE;

  const coverLayout = getLayout(doc.cover.layout);
  if (!coverLayout) issues.push(`cover: unknown layout "${safeId(doc.cover.layout)}"`);
  else if (coverLayout.role !== "cover") issues.push(`cover: layout "${coverLayout.id}" is not a cover layout`);
  else {
    if (coverLayout.format !== doc.format) {
      issues.push(`cover: layout "${coverLayout.id}" is for ${coverLayout.format}, book is ${doc.format}`);
    }
    if (coverLayout.style !== bookStyle) {
      issues.push(`cover: layout "${coverLayout.id}" is ${coverLayout.style}, book is ${bookStyle}`);
    }
  }
  if (doc.cover.photoId !== null && !photoIds.has(doc.cover.photoId)) {
    issues.push("cover: unknown photo");
  }

  if (doc.style.background.kind === "photo" && !backgroundPhotoIds.has(doc.style.background.photoId)) {
    issues.push("style.background: unknown photo");
  }

  if (doc.pages.length > maxPages) {
    issues.push(`pages: ${doc.pages.length} pages exceeds limit of ${maxPages}`);
  }

  const chapterIds = new Set<string>();
  doc.chapters.forEach((c, i) => {
    if (chapterIds.has(c.id)) issues.push(`chapters[${i}]: duplicate chapter id`);
    chapterIds.add(c.id);
  });

  const pageIds = new Set<string>();
  const used = new Set<string>();
  doc.pages.forEach((page, i) => {
    const at = `pages[${i}]`;
    if (pageIds.has(page.id)) issues.push(`${at}: duplicate page id`);
    pageIds.add(page.id);

    if (page.chapterId !== null && !chapterIds.has(page.chapterId)) {
      issues.push(`${at}: unknown chapter`);
    }
    if (page.background?.kind === "photo" && !backgroundPhotoIds.has(page.background.photoId)) {
      issues.push(`${at}.background: unknown photo`);
    }

    const layout = getLayout(page.layout);
    if (!layout) {
      issues.push(`${at}: unknown layout "${safeId(page.layout)}"`);
    } else if (layout.role === "cover") {
      issues.push(`${at}: layout "${layout.id}" is not a page layout`);
    } else {
      if (layout.format !== doc.format) {
        issues.push(`${at}: layout "${layout.id}" is for ${layout.format}, book is ${doc.format}`);
      }
      if (layout.style !== bookStyle) {
        issues.push(`${at}: layout "${layout.id}" is ${layout.style}, book is ${bookStyle}`);
      }
      // A spread's right half is an empty placeholder: the left half owns slots + caption.
      const rightHalf = layout.role === "spread" && page.side === "right";
      const slotCount = rightHalf ? 0 : layout.photoCount;
      if (page.slots.length !== slotCount) {
        issues.push(`${at}: layout "${layout.id}" needs ${slotCount} slots, got ${page.slots.length}`);
      }
      if (page.caption !== null && (rightHalf || layout.caption === null)) {
        issues.push(`${at}: layout "${layout.id}" has no caption area`);
      }
    }

    page.slots.forEach((slot, j) => {
      if (slot.photoId === null) return;
      if (!photoIds.has(slot.photoId)) issues.push(`${at}.slots[${j}]: unknown photo`);
      else if (used.has(slot.photoId)) issues.push(`${at}.slots[${j}]: photo used more than once`);
      used.add(slot.photoId);
    });
  });

  // Spreads (M10b, D-064): left half on an even index followed by its right half; no orphan halves.
  for (const issue of spreadIssues(doc)) issues.push(spreadIssueText(issue, safeId));

  return issues;
}

/** Layout ids come from code/AI, but cap and sanitise before echoing them in an issue. */
function safeId(id: string): string {
  return id.replace(/[^a-z0-9-]/gi, "?").slice(0, 32);
}
