// Background textures (M10a A5): scripts/gen-textures.mjs is deterministic, the committed files
// match the catalogue in src/lib/design/backgrounds.ts, stay within the size budget, tile
// seamlessly and are sharp enough for print.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  TEXTURE_IDS,
  TEXTURE_TILE_MM,
  TEXTURES,
  textureSrc,
  type Orientation,
} from "@/lib/design/backgrounds";

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "gen-textures.mjs");
const PUBLIC = path.join(ROOT, "public");
const TEX_DIR = path.join(PUBLIC, "design", "textures");
/** Committed manifest — outside public/ (review N8), so it is never served. */
const MANIFEST = path.join(ROOT, "scripts", "textures-manifest.json");
const BUDGET_BYTES = 2.5 * 1024 * 1024;
const ORIENTATIONS: Orientation[] = ["portrait", "landscape"];
// Full A5 sheet incl. 3 mm bleed per side.
const SHEET_MM: Record<Orientation, [number, number]> = { portrait: [154, 216], landscape: [216, 154] };

interface ManifestFile {
  name: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}
interface Manifest {
  sharp: string;
  vips: string;
  files: ManifestFile[];
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const readManifest = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Manifest;
const runManifest = (out: string) => path.join(out, "manifest.json");
const gen = (out: string) =>
  execFileSync(process.execPath, [SCRIPT, "--out", out, "--manifest", runManifest(out)], { cwd: ROOT, stdio: "pipe" });
const dpi = (px: number, mm: number) => px / (mm / 25.4);

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "gen-textures-"));
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("scripts/gen-textures.mjs", () => {
  it("is deterministic: a fresh run reproduces the committed files byte for byte", { timeout: 120_000 }, async () => {
    const committed = readManifest(MANIFEST);
    const a = path.join(tmp, "a");
    gen(a);
    const run = readManifest(runManifest(a));
    const names = run.files.map((f) => f.name).sort();
    expect(names).toEqual(committed.files.map((f) => f.name).sort());
    // Hashes on disk equal the manifest.
    for (const f of committed.files) expect(sha(path.join(TEX_DIR, f.name)), f.name).toBe(f.sha256);

    const sharpMod = (await import("sharp")).default;
    const sameBuild = sharpMod.versions.sharp === committed.sharp && sharpMod.versions.vips === committed.vips;
    if (sameBuild) {
      for (const f of run.files) expect(sha(path.join(a, f.name)), f.name).toBe(f.sha256);
      expect(run.files).toEqual(committed.files);
    } else {
      // Different sharp/libvips build: encoders may differ from the committed bytes, but two runs
      // on this build must still agree.
      const b = path.join(tmp, "b");
      gen(b);
      expect(readManifest(runManifest(b)).files).toEqual(run.files);
    }
  });
});

describe("committed textures", () => {
  it("every TEXTURES entry has its files on disk, and nothing else is committed", () => {
    expect(TEXTURES.map((t) => t.id)).toEqual([...TEXTURE_IDS]);
    const expected = new Set<string>();
    for (const t of TEXTURES) {
      for (const o of ORIENTATIONS) {
        for (const target of ["screen", "print"] as const) {
          const src = textureSrc(t, o, target);
          expect(src.startsWith("/design/textures/"), src).toBe(true);
          expect(src).toMatch(target === "print" ? /\.jpg$/ : /\.webp$/);
          expect(existsSync(path.join(PUBLIC, src)), src).toBe(true);
          expect(src).not.toMatch(/[A-Z\s]/);
          expect(src.slice(1)).toMatch(/^[a-z0-9/.-]+$/);
          expected.add(path.basename(src));
        }
      }
    }
    expect(new Set(readdirSync(TEX_DIR))).toEqual(expected);
    // The manifest lives in scripts/, not public/ (not served), and lists exactly these files.
    expect(existsSync(path.join(TEX_DIR, "manifest.json"))).toBe(false);
    expect(new Set(readManifest(MANIFEST).files.map((f) => f.name))).toEqual(expected);
  });

  it(`stays within the ${BUDGET_BYTES / 1024 / 1024} MB budget (incl. LICENSE.md)`, () => {
    let total = statSync(path.join(PUBLIC, "design", "LICENSE.md")).size;
    for (const f of readdirSync(TEX_DIR)) total += statSync(path.join(TEX_DIR, f)).size;
    expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("print tiles are ≥ 300 dpi at their tile size; washes ≥ 150 dpi over the full sheet", async () => {
    for (const t of TEXTURES) {
      for (const o of ORIENTATIONS) {
        const meta = await sharp(path.join(PUBLIC, textureSrc(t, o, "print"))).metadata();
        expect(meta.format).toBe("jpeg");
        expect(meta.channels).toBe(3);
        if (t.kind === "tile") {
          expect(t.tileMm).toBe(TEXTURE_TILE_MM);
          expect(meta.width).toBe(meta.height);
          expect(dpi(meta.width!, t.tileMm!)).toBeGreaterThanOrEqual(300);
        } else {
          const [wMm, hMm] = SHEET_MM[o];
          expect(dpi(meta.width!, wMm)).toBeGreaterThanOrEqual(150);
          expect(dpi(meta.height!, hMm)).toBeGreaterThanOrEqual(150);
          // Same aspect as the sheet, so background-size: cover crops nothing meaningful.
          expect(Math.abs(meta.width! / meta.height! - wMm / hMm)).toBeLessThan(0.005);
        }
      }
    }
  });

  it("screen files: 512 px webp tiles, ~1200 px webp washes", async () => {
    for (const t of TEXTURES) {
      for (const o of ORIENTATIONS) {
        const meta = await sharp(path.join(PUBLIC, textureSrc(t, o, "screen"))).metadata();
        expect(meta.format).toBe("webp");
        if (t.kind === "tile") expect([meta.width, meta.height]).toEqual([512, 512]);
        else expect(Math.max(meta.width!, meta.height!)).toBe(1200);
        if (t.kind === "wash") expect(meta.width! > meta.height!).toBe(o === "landscape");
      }
    }
  });

  it("tiles wrap seamlessly (the wrap seam is no stronger than an interior step)", async () => {
    for (const t of TEXTURES.filter((x) => x.kind === "tile")) {
      const { data, info } = await sharp(path.join(PUBLIC, textureSrc(t, "portrait", "print")))
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const S = info.width;
      const px = (x: number, y: number) => data[((y + S) % S) * S + ((x + S) % S)];
      // Mean |difference| between 6-px bands either side of column x (row y): low-pass, so it
      // catches the mottle discontinuity that a 1-px diff would hide under the fine grain.
      const stepX = (x: number) => {
        let s = 0;
        for (let y = 0; y < S; y++) {
          let a = 0;
          let b = 0;
          for (let k = 0; k < 6; k++) {
            a += px(x - 6 + k, y);
            b += px(x + k, y);
          }
          s += Math.abs(a - b) / 6;
        }
        return s / S;
      };
      const stepY = (y: number) => {
        let s = 0;
        for (let x = 0; x < S; x++) {
          let a = 0;
          let b = 0;
          for (let k = 0; k < 6; k++) {
            a += px(x, y - 6 + k);
            b += px(x, y + k);
          }
          s += Math.abs(a - b) / 6;
        }
        return s / S;
      };
      let ix = 0;
      let iy = 0;
      let n = 0;
      for (let i = 20; i < S - 20; i += 7) {
        ix += stepX(i);
        iy += stepY(i);
        n++;
      }
      expect(stepX(0), `${t.id} x seam`).toBeLessThanOrEqual((ix / n) * 1.25);
      expect(stepY(0), `${t.id} y seam`).toBeLessThanOrEqual((iy / n) * 1.25);
    }
  });

  it("baseHex is the texture's mean colour (fallback matches the file)", async () => {
    for (const t of TEXTURES) {
      const stats = await sharp(path.join(PUBLIC, textureSrc(t, "portrait", "print"))).stats();
      const mean = stats.channels.slice(0, 3).map((c) => c.mean);
      const n = parseInt(t.baseHex.slice(1), 16);
      const base = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      base.forEach((v, i) => expect(Math.abs(v - mean[i]), `${t.id} channel ${i}`).toBeLessThanOrEqual(6));
    }
  });
});

describe("serving", () => {
  it("/design/* is cacheable but not immutable (file names aren't content-hashed)", async () => {
    const { default: nextConfig, DESIGN_ASSET_HEADERS } = await import("../next.config");
    const rules = await nextConfig.headers!();
    expect(rules.find((r) => r.source === "/design/:path*")?.headers).toEqual(DESIGN_ASSET_HEADERS);
    expect(DESIGN_ASSET_HEADERS).toEqual([
      { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
    ]);
  });

  it("texture files skip the auth middleware (static, cacheable, reachable by the print renderer)", async () => {
    const { config } = await import("@/middleware");
    for (const t of TEXTURES) {
      for (const o of ORIENTATIONS) {
        for (const target of ["screen", "print"] as const) {
          const url = textureSrc(t, o, target);
          expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false);
        }
      }
    }
  });
});

describe("public/design/LICENSE.md", () => {
  it("declares CC0 and points at the generator", () => {
    const text = readFileSync(path.join(PUBLIC, "design", "LICENSE.md"), "utf8");
    expect(text).toContain("CC0 1.0");
    expect(text).toContain("scripts/gen-textures.mjs");
    expect(text).toMatch(/no third-party/i);
  });
});
