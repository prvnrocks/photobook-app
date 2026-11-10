// DOM glue for ARIA radio groups (M10a N5): put onKeyDown={onRadioGroupKeyDown} on the element
// with role="radiogroup" and give each radio tabIndex from rovingTabStop (src/lib/editor/roving.ts).
// Arrow keys / Home / End move focus to the next enabled radio of THIS group and select it.

import type { KeyboardEvent } from "react";
import { nextRadioIndex } from "@/lib/editor/roving";

export function onRadioGroupKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const group = e.currentTarget;
  const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]')).filter(
    (r) => r.closest('[role="radiogroup"]') === group,
  );
  const from = radios.findIndex((r) => r === document.activeElement);
  const to = nextRadioIndex(from, radios.map((r) => r.disabled), e.key);
  if (to === null) return;
  e.preventDefault();
  // The editor's own arrow keys flip pages; keep them out of the group.
  e.stopPropagation();
  const target = radios[to];
  target.focus();
  if (target.getAttribute("aria-checked") !== "true") target.click();
}
