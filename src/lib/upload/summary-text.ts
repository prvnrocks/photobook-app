// Plain-words text for the upload summary. Pure — safe in client components.
import type { SkipReason } from "./queue";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

type SkipGroup = "already" | "not_photo" | "too_small" | "too_large" | "unreadable" | "limit";

const GROUP_OF: Record<SkipReason, SkipGroup> = {
  already_uploaded: "already",
  duplicate_in_selection: "already",
  unsupported_type: "not_photo",
  too_small: "too_small",
  too_large: "too_large",
  decode_failed: "unreadable",
  limit: "limit",
};

const GROUP_TEXT: Record<SkipGroup, string> = {
  already: "already added",
  not_photo: "not a photo",
  too_small: "too small",
  too_large: "too large to open",
  unreadable: "couldn't be read",
  limit: "over the photo limit",
};

const ORDER: SkipGroup[] = ["already", "not_photo", "too_small", "too_large", "unreadable", "limit"];

/** e.g. [{ key: "already", text: "3 already added" }, …] — only non-zero groups, fixed order. */
export function skippedLines(
  skippedBy: Partial<Record<SkipReason, number>>,
): { key: SkipGroup; text: string }[] {
  const counts = new Map<SkipGroup, number>();
  for (const [reason, n] of Object.entries(skippedBy) as [SkipReason, number | undefined][]) {
    const group = GROUP_OF[reason];
    if (!group || !n) continue;
    counts.set(group, (counts.get(group) ?? 0) + n);
  }
  return ORDER.filter((g) => (counts.get(g) ?? 0) > 0).map((g) => ({
    key: g,
    text: `${counts.get(g)} ${GROUP_TEXT[g]}`,
  }));
}
