// Golden-file helper for tests/golden/*.test.tsx.
//
// Default run: compares `actual` byte-for-byte with tests/golden/fixtures/<name> and fails with a
// diff when they differ (or when the file is missing).
// Regenerate: `GOLDEN_UPDATE=1 npx vitest run tests/golden` rewrites every golden file from the
// current code. Only do that on purpose (an intended rendering change), then review the git diff
// of tests/golden/fixtures/ — that diff IS the visual/behavioural change.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const GOLDEN_UPDATE = process.env.GOLDEN_UPDATE === "1";

/** Compare (or, with GOLDEN_UPDATE=1, write) one golden file. `name` may contain sub-dirs. */
export function expectGolden(name: string, actual: string): void {
  const path = join(GOLDEN_DIR, name);
  if (GOLDEN_UPDATE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual, "utf8");
    return;
  }
  if (!existsSync(path)) {
    throw new Error(`golden file missing: ${name} — run GOLDEN_UPDATE=1 npx vitest run tests/golden`);
  }
  const expected = readFileSync(path, "utf8");
  expect(actual, `golden mismatch: ${name} (intended? GOLDEN_UPDATE=1 npx vitest run tests/golden)`).toBe(expected);
}

/** Stable pretty JSON (2-space, trailing newline). Maps become arrays of [key, value]. */
export function goldenJson(value: unknown): string {
  return `${JSON.stringify(value, (_k, v: unknown) => (v instanceof Map ? [...v.entries()] : v), 2)}\n`;
}

/** One tag per line so markup diffs are reviewable (pure text transform, no reformatting). */
export function splitTags(html: string): string {
  return html.replace(/></g, ">\n<");
}

/** Every file currently under the golden dir (relative, "/" separators), sorted. */
export function listGoldenFiles(dir: string = GOLDEN_DIR): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(GOLDEN_DIR, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}
