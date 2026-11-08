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
  it("no file under src/app or src/components imports the secret-key admin client", () => {
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
    "src/lib/photos/finalize.ts",
  ])(
    '%s starts with import "server-only"',
    (file) => {
      const first = readFileSync(join(ROOT, file), "utf8")
        .split(/\r?\n/)
        .find((l) => l.trim() !== "");
      expect(first?.trim()).toMatch(/^import ["']server-only["'];?$/);
    },
  );

  it('every src/lib/db/*.ts file starts with import "server-only"', () => {
    const dir = join(SRC, "lib", "db");
    const files = readdirSync(dir).filter((n) => n.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((name) => {
      const first = readFileSync(join(dir, name), "utf8")
        .split(/\r?\n/)
        .find((l) => l.trim() !== "");
      return !/^import ["']server-only["'];?$/.test(first?.trim() ?? "");
    });
    expect(offenders).toEqual([]);
  });

  it("SUPABASE_SECRET_KEY is only referenced in src/lib/supabase/admin.ts", () => {
    const matches = walk(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("SUPABASE_SECRET_KEY"))
      .map(rel);
    expect(matches).toEqual(["src/lib/supabase/admin.ts"]);
  });
});

// --- T11 additions -----------------------------------------------------------

function hasUseClientDirective(source: string): boolean {
  // Directive must be the first statement: skip blank lines and comments.
  const stripped = source.replace(/^﻿/, "").replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return /^["']use client["']\s*;?/.test(stripped);
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(re)) specs.push(m[1] ?? m[2] ?? m[3]);
  return specs;
}

const FORBIDDEN_IN_CLIENT: RegExp[] = [
  /^@\/lib\/supabase\/server$/,
  /^@\/lib\/supabase\/admin$/,
  /^@\/lib\/db(\/|$)/,
  /(^|\/)lib\/supabase\/(server|admin)$/,
  /(^|\/)lib\/db(\/|$)/,
  /^next\/headers$/,
  /^server-only$/,
];

describe("client component boundaries (T11)", () => {
  it("helpers detect directives and imports", () => {
    expect(hasUseClientDirective('"use client";\nimport x from "y";')).toBe(true);
    expect(hasUseClientDirective("// c\n'use client'\n")).toBe(true);
    expect(hasUseClientDirective('const a = "use client";')).toBe(false);
    expect(importSpecifiers('import { a } from "@/lib/db/books";\nimport "server-only";')).toEqual([
      "@/lib/db/books",
      "server-only",
    ]);
  });

  it('no "use client" file under src imports server-only modules', () => {
    const clientFiles = walk(SRC).filter((f) => hasUseClientDirective(readFileSync(f, "utf8")));
    expect(clientFiles.length).toBeGreaterThan(0);
    const offenders = clientFiles.flatMap((f) =>
      importSpecifiers(readFileSync(f, "utf8"))
        .filter((s) => FORBIDDEN_IN_CLIENT.some((re) => re.test(s)))
        .map((s) => `${rel(f)} -> ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it.each(["src/middleware.ts", "src/lib/supabase/middleware.ts"])(
    "%s does not import the admin client",
    (file) => {
      const specs = importSpecifiers(readFileSync(join(ROOT, file), "utf8"));
      expect(specs.length).toBeGreaterThan(0);
      expect(specs.filter((s) => /(^|\/)(lib\/supabase\/)?admin$/.test(s))).toEqual([]);
    },
  );

  it("legacy Supabase key names are not referenced anywhere", () => {
    const legacy = [
      "NEXT_PUBLIC_" + "SUPABASE_" + "ANON_KEY",
      "SUPABASE_" + "SERVICE_" + "ROLE_KEY",
    ];
    const dirs = ["src", "tests", "e2e"].map((d) => join(ROOT, d));
    const files = [
      ...dirs.flatMap((d) => walk(d)),
      join(ROOT, ".env.example"),
      join(ROOT, "README.md"),
    ];
    const offenders = files.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return legacy.filter((k) => text.includes(k)).map((k) => `${rel(f)}: ${k}`);
    });
    expect(offenders).toEqual([]);
  });
});

// --- T7 additions -----------------------------------------------------------

describe("geocoding boundaries (T7)", () => {
  it("MAPBOX_TOKEN is only referenced in src/lib/geo/reverse-geocode.ts", () => {
    const matches = walk(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("MAPBOX_TOKEN"))
      .map(rel);
    expect(matches).toEqual(["src/lib/geo/reverse-geocode.ts"]);
  });

  it('src/lib/geo/reverse-geocode.ts starts with import "server-only"', () => {
    const first = readFileSync(join(SRC, "lib", "geo", "reverse-geocode.ts"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim() !== "");
    expect(first?.trim()).toMatch(/^import ["']server-only["'];?$/);
  });

  it('no "use client" file imports src/lib/geo/*', () => {
    const offenders = walk(SRC)
      .filter((f) => hasUseClientDirective(readFileSync(f, "utf8")))
      .flatMap((f) =>
        importSpecifiers(readFileSync(f, "utf8"))
          .filter((s) => /^@\/lib\/geo(\/|$)|(^|\/)lib\/geo(\/|$)/.test(s))
          .map((s) => `${rel(f)} -> ${s}`),
      );
    expect(offenders).toEqual([]);
  });
});
