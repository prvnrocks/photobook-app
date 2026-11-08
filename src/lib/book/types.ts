// TS types for the book document and layouts, inferred from the zod schemas (single source).

import type { z } from "zod";
import type {
  BookDocSchema,
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
} from "./schema";

export type BookDoc = z.infer<typeof BookDocSchema>;
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
