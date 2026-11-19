// Print spec registry (Task 10). The digital spec is the one the app checks against today; the
// provider entries are placeholders so a UAE / India print-on-demand integration only has to fill
// one spec + write an order adapter — no renderer change is assumed (see docs/STORYBOOK-RELEASE.md).

import { GENERIC_A5_DIGITAL } from "./generic-a5-digital";
import { INDIA_POD_PLACEHOLDER } from "./india-pod-placeholder";
import type { PrintSpec } from "./types";
import { UAE_POD_PLACEHOLDER } from "./uae-pod-placeholder";

export type { PrintSpec, PrintSpecKind, PrintSpecTrim } from "./types";
export { isSpecComplete } from "./types";
export { GENERIC_A5_DIGITAL, RENDER_TARGET_DPI } from "./generic-a5-digital";
export { UAE_POD_PLACEHOLDER } from "./uae-pod-placeholder";
export { INDIA_POD_PLACEHOLDER } from "./india-pod-placeholder";

export const PRINT_SPECS: readonly PrintSpec[] = [GENERIC_A5_DIGITAL, UAE_POD_PLACEHOLDER, INDIA_POD_PLACEHOLDER];

/** The spec every export is checked against today. */
export const DEFAULT_PRINT_SPEC_ID = GENERIC_A5_DIGITAL.id;

export function getPrintSpec(id: string): PrintSpec | undefined {
  return PRINT_SPECS.find((s) => s.id === id);
}
