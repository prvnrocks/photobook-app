import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M8 review S3 (Vercel Hobby): one function budget constant shared by the PDF route, vercel.json
// and the job deadline/lease; the poll route stays free of the renderer.

import { PDF_DEADLINE_MS, PDF_MAX_DURATION_SECONDS } from "@/lib/pdf/rules";

const ROOT = process.cwd();
const PDF_ROUTE = "src/app/api/books/[id]/pdf/route.ts";
const STATUS_ROUTE = "src/app/api/books/[id]/pdf/status/route.ts";

/** vercel.json function keys are globs: `*` = one path segment (brackets would be a char class). */
function globMatches(glob: string, path: string): boolean {
  const re = new RegExp(
    "^" + glob.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+") + "$",
  );
  return re.test(path);
}

describe("function budget (one constant)", () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
  const routeSrc = readFileSync(join(ROOT, PDF_ROUTE), "utf8");

  it("Hobby + Fluid compute: 300 s, deadline = budget − 30 s; job lease = budget", async () => {
    expect(PDF_MAX_DURATION_SECONDS).toBe(300);
    expect(PDF_DEADLINE_MS).toBe((PDF_MAX_DURATION_SECONDS - 30) * 1000);
    vi.doMock("@/lib/db/books", () => ({ getMyBook: vi.fn() }));
    const job = await import("@/lib/pdf/job");
    expect(job.EXPORT_DEADLINE_MS).toBe(PDF_DEADLINE_MS);
    expect(job.EXPORT_LEASE_SECONDS).toBe(PDF_MAX_DURATION_SECONDS);
  });

  it("the route's literal maxDuration matches the constant", () => {
    const m = routeSrc.match(/export const maxDuration = (\d+);/);
    expect(m && Number(m[1])).toBe(PDF_MAX_DURATION_SECONDS);
  });

  it("vercel.json: fluid on, the PDF route (only) gets maxDuration = the constant, no memory key (Hobby can't set it)", () => {
    expect(vercel.fluid).toBe(true);
    const keys = Object.keys(vercel.functions ?? {});
    expect(keys).toHaveLength(1);
    expect(globMatches(keys[0], PDF_ROUTE)).toBe(true);
    expect(globMatches(keys[0], STATUS_ROUTE)).toBe(false);
    expect(keys[0]).not.toMatch(/[[\]]/);
    expect(vercel.functions[keys[0]]).toEqual({ maxDuration: PDF_MAX_DURATION_SECONDS });
  });
});

describe("lightweight status route import graph", () => {
  const HEAVY = ["puppeteer-core", "@sparticuz/chromium", "sharp", "pdf-lib"];
  const HEAVY_LOCAL = ["src/lib/pdf/render-pdf.ts", "src/lib/pdf/images.ts", "src/lib/pdf/browser.ts", "src/lib/pdf/job.ts", "src/lib/pdf/finalize.ts"];

  function resolveLocal(from: string, spec: string): string | null {
    const base = spec.startsWith("@/") ? join(ROOT, "src", spec.slice(2)) : resolve(dirname(from), spec);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
      if (existsSync(c) && c.match(/\.tsx?$/)) return c;
    }
    return null;
  }

  function walk(entry: string): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const stack = [join(ROOT, entry)];
    while (stack.length) {
      const f = stack.pop()!;
      if (files.has(f)) continue;
      files.add(f);
      const src = readFileSync(f, "utf8");
      // value imports only (`import type` is erased)
      for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
        const spec = m[1];
        if (spec.startsWith(".") || spec.startsWith("@/")) {
          const r = resolveLocal(f, spec);
          if (r) stack.push(r);
        } else {
          packages.add(spec);
        }
      }
      for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) packages.add(m[1]);
    }
    return { files, packages };
  }

  it("never reaches puppeteer, Chromium, sharp, pdf-lib or the renderer modules", () => {
    const { files, packages } = walk(STATUS_ROUTE);
    expect(files.size).toBeGreaterThan(3);
    for (const p of HEAVY) expect([...packages], p).not.toContain(p);
    for (const h of HEAVY_LOCAL) expect([...files], h).not.toContain(join(ROOT, h));
  });

  it("sanity: the heavy route does reach the renderer", () => {
    const { files } = walk(PDF_ROUTE);
    expect([...files]).toContain(join(ROOT, "src/lib/pdf/render-pdf.ts"));
  });
});
