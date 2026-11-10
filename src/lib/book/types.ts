// TS types for the book document and layouts, inferred from the zod schemas (single source).

import type { z } from "zod";
import type {
  BackgroundSchema,
  BackgroundSourceSchema,
  BookDocSchema,
  BookDocV1Schema,
  BookFormatSchema,
  DesignStyleSchema,
  PageBackgroundSchema,
  PageSchemaV1,
  CaptionSchema,
  ChapterSchema,
  CoverSchema,
  CropSchema,
  DocMetaSchema,
  GeneratorSchema,
  LayoutSchema,
  LayoutSlotSchema,
  PageSchema,
  RectSchema,
  SlotSchema,
  StyleSchema,
  StyleSchemaV1,
} from "./schema";

/** In-memory doc (v2). parseBookDoc always returns this; write it back with serializeDoc. */
export type BookDoc = z.infer<typeof BookDocSchema>;
/** Stored M1–M9 shape (read by parseBookDoc, written by serializeDoc when possible). */
export type BookDocV1 = z.infer<typeof BookDocV1Schema>;
export type BookPageV1 = z.infer<typeof PageSchemaV1>;
export type StyleV1 = z.infer<typeof StyleSchemaV1>;
export type BookFormat = z.infer<typeof BookFormatSchema>;
export type DesignStyle = z.infer<typeof DesignStyleSchema>;
/** Book default / page background (doc v2). Schema in schema.ts, catalogue in lib/design. */
export type Background = z.infer<typeof BackgroundSchema>;
export type BackgroundSource = z.infer<typeof BackgroundSourceSchema>;
/** page.background: a Background plus who chose it. */
export type PageBackground = z.infer<typeof PageBackgroundSchema>;
export type BookPage = z.infer<typeof PageSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type Crop = z.infer<typeof CropSchema>;
export type Caption = z.infer<typeof CaptionSchema>;
export type CaptionSource = Caption["source"];
export type Chapter = z.infer<typeof ChapterSchema>;
export type Cover = z.infer<typeof CoverSchema>;
export type DocMeta = z.infer<typeof DocMetaSchema>;
export type Generator = z.infer<typeof GeneratorSchema>;
export type Style = z.infer<typeof StyleSchema>;
export type Rect = z.infer<typeof RectSchema>;
export type LayoutSlot = z.infer<typeof LayoutSlotSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type LayoutRole = Layout["role"];
export type Orientation = Layout["prefers"][number];

export type { CaptionLang, Occasion, Tone } from "./options";
