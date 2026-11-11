// TEST-ONLY: simulate a design style that has no layouts yet (M10c T10). Since geometric +
// scrapbook shipped, every DESIGN_STYLES value is supported, but the unsupported_design machinery
// (typed UnsupportedDesignError at layout entry points, clean refusals in each writer) stays for
// future styles and rolled-back code. Tests keep exercising it by marking a real style as
// "without layouts" for the duration of a test:
//
//   vi.mock("@/lib/book/book-design", async (orig) =>
//     (await import("./fixtures/simulated-unsupported-style")).withSimulatedUnsupported(await orig()));
//   import { simulateUnsupported } from "./fixtures/simulated-unsupported-style";
//   beforeEach(() => simulateUnsupported(["scrapbook"]));  afterEach(() => simulateUnsupported([]));
//
// Every module importing isSupportedDesign / assertSupportedDesign from book-design (autolayout,
// fit, relayout, finalize, orchestrator, review actions, validateEditorDoc) sees the simulation.

import type * as BookDesignModule from "@/lib/book/book-design";

const simulated = new Set<string>();

/** Styles treated as "no layouts" until the next call (empty = real behaviour). */
export function simulateUnsupported(styles: readonly string[]): void {
  simulated.clear();
  for (const s of styles) simulated.add(s);
}

export function withSimulatedUnsupported(real: typeof BookDesignModule): typeof BookDesignModule {
  const isSupportedDesign: typeof real.isSupportedDesign = (design) =>
    !simulated.has(design.designStyle) && real.isSupportedDesign(design);
  const assertSupportedDesign: typeof real.assertSupportedDesign = (design) => {
    if (!isSupportedDesign(design)) throw new real.UnsupportedDesignError(design);
  };
  return { ...real, isSupportedDesign, assertSupportedDesign };
}
