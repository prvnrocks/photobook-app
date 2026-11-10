// Keyboard helpers for editor widgets (M10a N5/N6). Pure index maths; the DOM glue lives in
// src/components/editor/useRovingRadio.ts and SpreadPreviewSheet.tsx.
//
// Radio groups (ARIA radio pattern): one tab stop per group (the checked radio, else the first
// enabled one); arrow keys move to the next/previous enabled radio, wrapping; Home/End jump.

/** Index of the radio that gets tabIndex 0: the checked one if enabled, else the first enabled; -1 if none. */
export function rovingTabStop(items: readonly { checked: boolean; disabled?: boolean }[]): number {
  const checked = items.findIndex((i) => i.checked && !i.disabled);
  if (checked >= 0) return checked;
  return items.findIndex((i) => !i.disabled);
}

const STEP: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Radio to move to for `key` from index `from` (-1 = focus not on a radio), skipping disabled
 * radios and wrapping. null = the key is not a radio-group key or nothing is enabled.
 */
export function nextRadioIndex(from: number, disabled: readonly boolean[], key: string): number | null {
  const n = disabled.length;
  const enabled = disabled.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
  if (enabled.length === 0) return null;
  if (key === "Home") return enabled[0];
  if (key === "End") return enabled[enabled.length - 1];
  const step = STEP[key];
  if (step === undefined) return null;
  if (from < 0 || from >= n) return step > 0 ? enabled[0] : enabled[enabled.length - 1];
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return null;
}

/**
 * Focus trap (modal sheets): the element index Tab / Shift+Tab should focus next among `count`
 * focusables, wrapping at both ends; focus outside the list (-1) goes to the first / last.
 */
export function trapFocusIndex(from: number, count: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (from < 0 || from >= count) return shift ? count - 1 : 0;
  return shift ? (from - 1 + count) % count : (from + 1) % count;
}
