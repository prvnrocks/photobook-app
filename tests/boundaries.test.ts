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
    "src/lib/ai/transport-live.ts",
    "src/lib/ai/transport-factory.ts",
    "src/lib/ai/orchestrator.ts",
    "src/lib/ai/budget.ts",
    "src/lib/stripe.ts",
    "src/lib/photos/finalize.ts",
    "src/lib/publish/password.ts",
    "src/lib/publish/access-cookie.ts",
    "src/lib/pdf/print-token.ts",
    "src/lib/db/print.ts",
  ])(
    '%s starts with import "server-only"',
    (file) => {
      const first = readFileSync(join(ROOT, file), "utf8")
        .split(/\r?\n/)
        .find((l) => l.trim() !== "");
      expect(first?.trim()).toMatch(/^import ["']server-only["'];?$/);
    },
  );

  it.each([
    "src/lib/publish/slug.ts",
    "src/lib/publish/rules.ts",
    "src/lib/publish/public-doc.ts",
    "src/lib/brand.ts",
    "src/lib/pdf/rules.ts",
    "src/lib/pdf/print-assets.ts",
    "src/lib/pdf/print-doc.ts",
    "src/lib/pdf/print-ready.ts",
  ])(
    "%s stays isomorphic (no server-only, no node: imports)",
    (file) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).not.toMatch(/["']server-only["']|from\s+["']node:|process\.env/);
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

// --- M3 T3/T4 additions ------------------------------------------------------

describe("AI boundaries (M3)", () => {
  const SERVER_ONLY_AI = /(^|\/)lib\/ai\/(client|transport-live|transport-factory|transport-replay|run-step|cost)$/;

  it('no "use client" file imports @anthropic-ai/sdk or server-side AI modules', () => {
    const offenders = walk(SRC)
      .filter((f) => hasUseClientDirective(readFileSync(f, "utf8")))
      .flatMap((f) =>
        importSpecifiers(readFileSync(f, "utf8"))
          .filter((s) => /^@anthropic-ai\/sdk(\/|$)/.test(s) || SERVER_ONLY_AI.test(s))
          .map((s) => `${rel(f)} -> ${s}`),
      );
    expect(offenders).toEqual([]);
  });

  it("@anthropic-ai/sdk is imported only by src/lib/ai/client.ts and transport-live.ts", () => {
    const importers = walk(SRC)
      .filter((f) => importSpecifiers(readFileSync(f, "utf8")).some((s) => /^@anthropic-ai\/sdk(\/|$)/.test(s)))
      .map(rel)
      .sort();
    expect(importers).toEqual(["src/lib/ai/client.ts", "src/lib/ai/transport-live.ts"]);
  });

  it("ANTHROPIC_API_KEY is only referenced in src/lib/ai/client.ts", () => {
    const matches = walk(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("ANTHROPIC_API_KEY"))
      .map(rel);
    expect(matches).toEqual(["src/lib/ai/client.ts"]);
  });

  it("ADMIN_USER_IDS is never referenced by a client file or NEXT_PUBLIC_ var", () => {
    const offenders = walk(SRC)
      .filter((f) => {
        const t = readFileSync(f, "utf8");
        return (hasUseClientDirective(t) && t.includes("ADMIN_USER_IDS")) || t.includes("NEXT_PUBLIC_ADMIN");
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

// --- M7 T2 additions ---------------------------------------------------------

describe("payments boundaries (M7)", () => {
  it('no "use client" file imports stripe, src/lib/stripe or src/lib/payments/*', () => {
    const offenders = walk(SRC)
      .filter((f) => hasUseClientDirective(readFileSync(f, "utf8")))
      .flatMap((f) =>
        importSpecifiers(readFileSync(f, "utf8"))
          .filter((s) => /^stripe(\/|$)|(^|\/)lib\/stripe$|(^|\/)lib\/payments(\/|$)/.test(s))
          .map((s) => `${rel(f)} -> ${s}`),
      );
    expect(offenders).toEqual([]);
  });

  it("the stripe SDK is value-imported only by src/lib/stripe.ts (type-only imports allowed)", () => {
    const importers = walk(SRC)
      .filter((f) =>
        /^\s*import\s+(?!type\b)[^'";]*from\s+["']stripe["']|import\(\s*["']stripe["']\s*\)|require\(\s*["']stripe["']\s*\)/m.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map(rel);
    expect(importers).toEqual(["src/lib/stripe.ts"]);
    // session.ts imports stripe types only — and the regex must not mistake that for a value import.
    expect(readFileSync(join(SRC, "lib", "payments", "session.ts"), "utf8")).toMatch(/^import type Stripe from "stripe";$/m);
  });

  it("STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are only referenced in src/lib/stripe.ts", () => {
    const matches = walk(SRC)
      .filter((f) => /STRIPE_(SECRET_KEY|WEBHOOK_SECRET)/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(matches).toEqual(["src/lib/stripe.ts"]);
  });

  it.each(["src/lib/pricing.ts", "src/lib/payments/session.ts"])(
    "%s stays secret-free (no server-only, no process.env, no stripe client)",
    (file) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).not.toMatch(/["']server-only["']|process\.env|from\s+["']@\/lib\/stripe["']/);
      expect(src).not.toMatch(/^\s*import\s+(?!type\b)[^'";]*from\s+["']stripe["']/m);
    },
  );
});

// --- M8 T4 additions ---------------------------------------------------------

describe("print image boundaries (M8 T4)", () => {
  it('src/lib/pdf/images.ts starts with import "server-only"', () => {
    const first = readFileSync(join(SRC, "lib", "pdf", "images.ts"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim() !== "");
    expect(first?.trim()).toMatch(/^import ["']server-only["'];?$/);
  });

  it("src/lib/pdf/image-plan.ts stays pure (no server-only, sharp, node: or env)", () => {
    const src = readFileSync(join(SRC, "lib", "pdf", "image-plan.ts"), "utf8");
    expect(src).not.toMatch(/["']server-only["']|["']sharp["']|from\s+["']node:|process\.env/);
  });

  it("sharp is only imported from server-only modules, never from client code", () => {
    const importers = walk(SRC).filter((f) =>
      importSpecifiers(readFileSync(f, "utf8")).some((s) => /^sharp(\/|$)/.test(s)),
    );
    const offenders = importers
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        const first = src.split(/\r?\n/).find((l) => l.trim() !== "");
        return hasUseClientDirective(src) || !/^import ["']server-only["'];?$/.test(first?.trim() ?? "");
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no "use client" file imports src/lib/pdf/images', () => {
    const offenders = walk(SRC)
      .filter((f) => hasUseClientDirective(readFileSync(f, "utf8")))
      .flatMap((f) =>
        importSpecifiers(readFileSync(f, "utf8"))
          .filter((s) => /(^|\/)lib\/pdf\/images$/.test(s))
          .map((s) => `${rel(f)} -> ${s}`),
      );
    expect(offenders).toEqual([]);
  });
});

// --- M8 T6 additions ---------------------------------------------------------

describe("PDF renderer boundaries (M8 T6)", () => {
  it.each(["src/lib/pdf/browser.ts", "src/lib/pdf/render-pdf.ts", "src/lib/pdf/job.ts"])('%s starts with import "server-only"', (file) => {
    const first = readFileSync(join(ROOT, file), "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim() !== "");
    expect(first?.trim()).toMatch(/^import ["']server-only["'];?$/);
  });

  it.each(["src/lib/pdf/request-routing.ts", "src/lib/pdf/errors.ts", "src/lib/pdf/finalize.ts"])(
    "%s stays pure (no server-only, puppeteer, chromium, node: or env)",
    (file) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(importSpecifiers(src).filter((s) => /^(server-only|puppeteer|@sparticuz\/|node:|sharp$)/.test(s))).toEqual([]);
      expect(src).not.toMatch(/process\.env/);
    },
  );

  it("puppeteer-core / @sparticuz/chromium are imported only by src/lib/pdf/{browser,render-pdf}.ts", () => {
    const importers = walk(SRC)
      .filter((f) => importSpecifiers(readFileSync(f, "utf8")).some((s) => /^(puppeteer-core|puppeteer|@sparticuz\/chromium)(\/|$)/.test(s)))
      .map(rel)
      .sort();
    expect(importers).toEqual(["src/lib/pdf/browser.ts", "src/lib/pdf/render-pdf.ts"]);
  });

  it("app code never imports playwright", () => {
    const offenders = walk(SRC)
      .filter((f) => importSpecifiers(readFileSync(f, "utf8")).some((s) => /^(playwright|@playwright\/)/.test(s)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no "use client" file imports the PDF renderer modules', () => {
    const offenders = walk(SRC)
      .filter((f) => hasUseClientDirective(readFileSync(f, "utf8")))
      .flatMap((f) =>
        importSpecifiers(readFileSync(f, "utf8"))
          .filter((s) => /(^|\/)lib\/pdf\/(browser|render-pdf|finalize)$|^pdf-lib(\/|$)/.test(s))
          .map((s) => `${rel(f)} -> ${s}`),
      );
    expect(offenders).toEqual([]);
  });

  it("VERCEL_AUTOMATION_BYPASS_SECRET / PDF_CHROME_PATH are read only by the renderer", () => {
    const reads = (name: string) =>
      walk(SRC)
        .filter((f) => new RegExp(`\\benv\\??\\.${name}\\b|\\benv\\[["']${name}["']\\]`).test(readFileSync(f, "utf8")))
        .map(rel);
    expect(reads("VERCEL_AUTOMATION_BYPASS_SECRET")).toEqual(["src/lib/pdf/render-pdf.ts"]);
    const chrome = reads("PDF_CHROME_PATH");
    expect(chrome).toEqual(["src/lib/pdf/browser.ts"]);
  });
});

// --- M9 T13 additions (Sentry, D-058) -----------------------------------------

describe("Sentry boundaries (M9 T13)", () => {
  const SENTRY_CONFIGS = [
    "src/instrumentation-client.ts",
    "src/sentry.edge.config.ts",
    "src/sentry.server.config.ts",
  ];

  it("Sentry DSN env vars are only read in the three Sentry config files", () => {
    const matches = walk(SRC)
      .filter((f) => /SENTRY_DSN/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(matches).toEqual(SENTRY_CONFIGS);
  });

  it("SENTRY_AUTH_TOKEN is never referenced under src (build-time only, next.config.ts)", () => {
    const matches = walk(SRC)
      .filter((f) => /SENTRY_(AUTH_TOKEN|ORG|PROJECT)/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(matches).toEqual([]);
    expect(readFileSync(join(ROOT, "next.config.ts"), "utf8")).toMatch(/process\.env\.SENTRY_AUTH_TOKEN/);
  });

  it.each(SENTRY_CONFIGS)("%s routes events through the shared scrubbed options", (file) => {
    const src = readFileSync(join(ROOT, file), "utf8");
    expect(src).toMatch(/from "@\/lib\/observability\/sentry-options"/);
    expect(src).toMatch(/Sentry\.init\(\s*sentryOptions\(/);
    expect(src).not.toMatch(/replayIntegration|tracesSampleRate|profilesSampleRate|sendDefaultPii/);
  });

  it.each(["src/lib/observability/scrub.ts", "src/lib/observability/sentry-options.ts"])(
    "%s stays isomorphic (no server-only, no node: imports, no process.env)",
    (file) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).not.toMatch(/["']server-only["']|from\s+["']node:|process\.env/);
    },
  );

  it("no Sentry Replay or tunnel route anywhere in src or next.config.ts", () => {
    const files = [...walk(SRC), join(ROOT, "next.config.ts")];
    const offenders = files
      .filter((f) => /replayIntegration|tunnelRoute\s*:/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("instrumentation.ts exports onRequestError and loads the runtime configs", () => {
    const src = readFileSync(join(SRC, "instrumentation.ts"), "utf8");
    expect(src).toMatch(/export const onRequestError = Sentry\.captureRequestError/);
    expect(src).toMatch(/import\("\.\/sentry\.server\.config"\)/);
    expect(src).toMatch(/import\("\.\/sentry\.edge\.config"\)/);
  });

  it("the Stripe webhook route never imports Sentry (raw body stays untouched)", () => {
    const src = readFileSync(join(SRC, "app", "api", "stripe", "webhook", "route.ts"), "utf8");
    expect(src).not.toMatch(/@sentry\//);
  });
});
