import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) ? [p] : [];
  });
}

const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

describe("server/client boundaries", () => {
  it("no file under src/app or src/components imports the service-role admin client", () => {
    const files = [...walk(join(SRC, "app")), ...walk(join(SRC, "components"))];
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) =>
      /from\s+["'](@\/lib\/supabase\/admin|(\.\.\/)+lib\/supabase\/admin)["']|import\(\s*["']@\/lib\/supabase\/admin["']\s*\)/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it.each([
    "src/lib/supabase/admin.ts",
    "src/lib/supabase/server.ts",
    "src/lib/ai/client.ts",
    "src/lib/stripe.ts",
  ])(
    '%s starts with import "server-only"',
    (file) => {
      const first = readFileSync(join(ROOT, file), "utf8")
        .split(/\r?\n/)
        .find((l) => l.trim() !== "");
      expect(first?.trim()).toMatch(/^import ["']server-only["'];?$/);
    },
  );

  it("SUPABASE_SERVICE_ROLE_KEY is only referenced in src/lib/supabase/admin.ts", () => {
    const matches = walk(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("SUPABASE_SERVICE_ROLE_KEY"))
      .map(rel);
    expect(matches).toEqual(["src/lib/supabase/admin.ts"]);
  });
});
