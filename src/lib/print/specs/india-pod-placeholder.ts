// Placeholder for a future India print-on-demand partner (Task 10, requirement 17). NO provider has
// been chosen and NO specification has been received: every number is null on purpose. Same rules
// as uae-pod-placeholder.ts — copy numbers only from the partner's written spec, proof, then verify.

import type { PrintSpec } from "./types";

export const INDIA_POD_PLACEHOLDER: PrintSpec = {
  id: "india-pod-placeholder",
  kind: "print_provider",
  label: "India print partner (not chosen yet)",
  source: "none — TODO fill from provider spec",
  providerVerified: false,
  region: "IN",
  trim: { A5_PORTRAIT: null, A5_LANDSCAPE: null },
  bleedMm: null,
  safeMarginMm: null,
  targetDpi: null,
  minEffectiveDpi: null,
  colour: "TODO fill from provider spec (colour space, ICC profile, total ink limit)",
  fontsEmbedded: true,
  pages: { min: null, max: null, multipleOf: null },
  cover: { layout: null, spineWidthMm: null },
  todo: [
    "TODO fill from provider spec: trim sizes offered (A5 portrait / landscape?)",
    "TODO fill from provider spec: bleed and safe margin",
    "TODO fill from provider spec: minimum image resolution",
    "TODO fill from provider spec: colour space / ICC profile / output intent",
    "TODO fill from provider spec: interior page count min / max / multiple",
    "TODO fill from provider spec: cover layout (front only or wrap) and spine width formula (paper stock)",
    "TODO: proof accepted by the provider before providerVerified = true",
  ],
};
