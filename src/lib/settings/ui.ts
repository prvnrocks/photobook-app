// Pure helpers for /settings ("What the AI has learned", D-032) and the new-book prefill.
// Safe on client and server: no imports from src/lib/ai or src/lib/db (server-only); the
// caption-length values mirror CAPTION_LENGTHS in src/lib/ai/schemas.ts.
import {
  CAPTION_LANG_LABELS,
  CAPTION_LANGS,
  DEFAULT_TONE,
  TONE_LABELS,
  TONES,
  type CaptionLang,
  type Occasion,
  type Tone,
} from "@/lib/book/options";

/** Mirrors CAPTION_LENGTHS in src/lib/ai/schemas.ts (asserted in tests/settings-ui.test.ts). */
export const SETTINGS_CAPTION_LENGTHS = ["short", "medium", "long"] as const;
export type SettingsCaptionLength = (typeof SETTINGS_CAPTION_LENGTHS)[number];

export const CAPTION_LENGTH_LABELS: Record<SettingsCaptionLength, string> = {
  short: "Short",
  medium: "Medium",
  long: "Long",
};

/** Structural subset of OwnMemoryView (src/lib/db/memory.ts) that the settings UI reads. */
export type MemoryViewLike = {
  tone?: string;
  captionLength?: string;
  language?: string;
  knownNames?: readonly string[];
  avoid?: readonly string[];
  updatedAt?: string;
};

export type MemoryRow =
  | { key: "tone" | "captionLength"; label: string; value: string }
  | { key: "language"; label: string; value: string; lang: CaptionLang }
  | { key: "knownNames" | "avoid"; label: string; values: string[] };

export const SETTINGS_COPY = {
  heading: "Settings",
  memoryHeading: "What the AI has learned",
  empty: "Nothing yet — we learn from your choices when you finish reviewing a book.",
  privacy:
    "We only remember choices you made (tone, language, how long your captions are). We never store face data or guess who is in your photos.",
  loadError: "Couldn't load this right now. Please refresh the page to try again.",
  clear: "Clear what the AI learned",
  confirmQuestion: "Clear what the AI learned?",
  confirmDetail: "Your books stay as they are. New books will start from the default settings.",
  confirm: "Clear",
  cancel: "Cancel",
  clearing: "Clearing…",
  done: "Cleared. We'll start learning again from your next book.",
  fromMemory: "From your last book",
} as const;

const isTone = (v: unknown): v is Tone => typeof v === "string" && (TONES as readonly string[]).includes(v);
const isLang = (v: unknown): v is CaptionLang =>
  typeof v === "string" && (CAPTION_LANGS as readonly string[]).includes(v);
const isLength = (v: unknown): v is SettingsCaptionLength =>
  typeof v === "string" && (SETTINGS_CAPTION_LENGTHS as readonly string[]).includes(v);

function cleanList(list: readonly string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => typeof s === "string" && s.trim() !== "");
}

/** Friendly rows to show, in display order. Unknown enum values are skipped, never shown raw. */
export function memoryRows(view: MemoryViewLike | null | undefined): MemoryRow[] {
  if (!view) return [];
  const rows: MemoryRow[] = [];
  if (isTone(view.tone)) rows.push({ key: "tone", label: "Preferred tone", value: TONE_LABELS[view.tone] });
  if (isLength(view.captionLength)) {
    rows.push({ key: "captionLength", label: "Caption length", value: CAPTION_LENGTH_LABELS[view.captionLength] });
  }
  if (isLang(view.language)) {
    rows.push({ key: "language", label: "Caption language", value: CAPTION_LANG_LABELS[view.language], lang: view.language });
  }
  const names = cleanList(view.knownNames);
  if (names.length > 0) rows.push({ key: "knownNames", label: "Names you use", values: names });
  const avoid = cleanList(view.avoid);
  if (avoid.length > 0) rows.push({ key: "avoid", label: "Things to avoid", values: avoid });
  return rows;
}

/** True when there is nothing worth showing (→ empty state, no Clear button). */
export function isMemoryViewEmpty(view: MemoryViewLike | null | undefined): boolean {
  return memoryRows(view).length === 0;
}

/** "Last updated 9 Nov 2026" (UAE calendar day); null for a missing/invalid timestamp. */
export function lastUpdatedLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const text = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Dubai",
  }).format(date);
  return `Last updated ${text}`;
}

/** Mirrors ClearMemoryResult in src/app/settings/actions.ts. */
export type ClearResultLike = { ok: true; cleared: boolean } | { ok: false; error: string };

export type ClearOutcome = { kind: "done" } | { kind: "error"; message: string };

export function clearOutcome(result: ClearResultLike | null | undefined): ClearOutcome {
  if (result && result.ok) return { kind: "done" };
  if (result && !result.ok && result.error === "signed_out") {
    return { kind: "error", message: "Your session has ended. Please sign in again." };
  }
  return { kind: "error", message: "Couldn't clear this right now. Please try again." };
}

/** Initial NewBookForm state from memory (D-032). A remembered tone counts as a manual choice. */
export function newBookInitialState(props: { initialTone?: unknown; initialLang?: unknown }): {
  manualTone: Tone | null;
  captionLang: CaptionLang;
} {
  return {
    manualTone: isTone(props.initialTone) ? props.initialTone : null,
    captionLang: isLang(props.initialLang) ? props.initialLang : "en",
  };
}

/** Tone shown in the form: manual choice (incl. remembered) wins over the occasion default. */
export function effectiveTone(manualTone: Tone | null, occasion: Occasion | null): Tone {
  return manualTone ?? (occasion ? DEFAULT_TONE[occasion] : DEFAULT_TONE.other);
}

/**
 * Show "From your last book" only when a remembered value is still selected AND differs from what
 * the form would show anyway (tone ≠ the current occasion's default — DEFAULT_TONE.other while no
 * occasion is picked — or language ≠ 'en'). Seeding is unaffected (newBookInitialState).
 */
export function showFromMemoryHint(input: {
  fromMemory: boolean;
  rememberedTone: Tone | null;
  rememberedLang: CaptionLang | null;
  occasion: Occasion | null;
  tone: Tone;
  captionLang: CaptionLang;
}): boolean {
  if (!input.fromMemory) return false;
  const defaultTone = input.occasion ? DEFAULT_TONE[input.occasion] : DEFAULT_TONE.other;
  const toneHint = input.rememberedTone !== null && input.tone === input.rememberedTone && input.rememberedTone !== defaultTone;
  const langHint = input.rememberedLang !== null && input.captionLang === input.rememberedLang && input.rememberedLang !== "en";
  return toneHint || langHint;
}
