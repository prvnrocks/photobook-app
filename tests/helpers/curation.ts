// Builders for CurationPhoto test data (tests/ai/fallback + curator).
import type { CurationPhoto } from "@/lib/ai/fallback";

export function photo(id: string, over: Partial<CurationPhoto> = {}): CurationPhoto {
  return {
    id,
    thumbPath: `u/b/${id}.jpg`,
    width: 4032,
    height: 3024,
    takenAt: "2026-10-12T18:00:00+04:00",
    dateSource: "exif",
    place: null,
    camera: "Apple iPhone 15",
    originalMime: "image/jpeg",
    blurScore: 400,
    dupGroup: null,
    status: "kept",
    dropReason: null,
    userOverride: false,
    ai: null,
    ...over,
  };
}

export const screenshot = (id: string, over: Partial<CurationPhoto> = {}) =>
  photo(id, { originalMime: "image/png", camera: null, width: 1179, height: 2556, ...over });
