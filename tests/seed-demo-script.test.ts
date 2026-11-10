import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DemoVideo } from "@/components/marketing/DemoVideo";
import { LIMITS } from "@/lib/ai/limits";
import { CAPTION_LANGS, DEFAULT_TONE, OCCASIONS, TONES } from "@/lib/book/options";
import { TITLE_MAX_CHARS } from "@/app/books/form-state";
import { getDemoVideo } from "@/lib/marketing/demo";
import * as seed from "../scripts/seed-demo-books.mjs";
import * as record from "../scripts/record-demo.mjs";
import { normaliseAppUrl, parseAdminIds } from "../scripts/lib/demo-common.mjs";

const OWNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "99999999-2222-4333-8444-555555555555";
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ADMIN_USER_IDS: ` x, ${OWNER} `,
};
const SECRET_EMAIL = "owner-secret@example.org";

let root = "";
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "seed-demo-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function book(folder: string, photos: string[], json?: unknown) {
  const d = path.join(root, folder);
  mkdirSync(d, { recursive: true });
  for (const p of photos) writeFileSync(path.join(d, p), "x");
  if (json !== undefined) writeFileSync(path.join(d, "book.json"), typeof json === "string" ? json : JSON.stringify(json));
  return d;
}

/** Minimal supabase-js admin stand-in: answers only what preflight asks. */
function fakeAdmin(opts: { user?: boolean; profile?: boolean; m1700?: boolean; email?: string | null } = {}) {
  const { user = true, profile = true, m1700 = true, email = SECRET_EMAIL } = opts;
  const calls: string[] = [];
  const query = (table: string) => {
    const q = {
      select: (cols: string) => {
        calls.push(`select ${table}(${cols})`);
        return q;
      },
      eq: () => q,
      limit: async () =>
        table === "orders" && !m1700 ? { data: null, error: { code: "42703" } } : { data: [], error: null },
      maybeSingle: async () =>
        table === "profiles"
          ? profile
            ? { data: { id: OWNER }, error: null }
            : { data: null, error: null }
          : { data: { id: "b" }, error: null },
    };
    return q;
  };
  return {
    calls,
    from: (t: string) => query(t),
    rpc: vi.fn(),
    auth: {
      admin: {
        getUserById: vi.fn(async () => (user ? { data: { user: { id: OWNER, email } }, error: null } : { data: { user: null }, error: { code: "user_not_found" } })),
        generateLink: vi.fn(),
      },
    },
  };
}

function deps(over: Partial<{ admin: ReturnType<typeof fakeAdmin>; status: number; env: Record<string, string> }> = {}) {
  const admin = over.admin ?? fakeAdmin();
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = vi.fn(async () => ({ status: over.status ?? 200 }));
  const launchBrowser = vi.fn(async () => {
    throw new Error("browser must not be launched in a dry run");
  });
  return {
    admin,
    out,
    err,
    fetchFn,
    launchBrowser,
    d: {
      env: over.env ?? ENV,
      fetch: fetchFn,
      createAdmin: vi.fn(async () => admin),
      launchBrowser,
      log: (s: string) => out.push(s),
      error: (s: string) => err.push(s),
    },
  };
}

describe("scripts/seed-demo-books.mjs — arguments", () => {
  it("parses flags", () => {
    expect(seed.parseArgs(["--owner", OWNER, "--dir", "/x", "--app", "http://h:3000", "--dry-run", "--headed"])).toEqual({
      owner: OWNER,
      dir: "/x",
      app: "http://h:3000",
      dryRun: true,
      headed: true,
    });
    expect(seed.parseArgs(["--owner", OWNER, "--update", "eid-2026-abcdefghjk"]).update).toBe("eid-2026-abcdefghjk");
  });

  it.each([[["--owner"]], [["--owner", "--dir", "x"]], [["--email", "a"]], [["stray"]]])("rejects %j", (argv) => {
    expect(() => seed.parseArgs(argv)).toThrow(seed.UsageError);
  });

  it("validates owner, admin list, dir/update exclusivity, slug, app url and env", () => {
    const ok = seed.validateArgs({ owner: OWNER.toUpperCase(), dir: "/tmp/x" }, ENV);
    expect(ok).toMatchObject({ owner: OWNER, app: "http://localhost:3000", dir: "/tmp/x", update: null, dryRun: false });
    expect(() => seed.validateArgs({ owner: OTHER, dir: "/x" }, ENV)).toThrow(/ADMIN_USER_IDS/);
    expect(() => seed.validateArgs({ owner: "nope", dir: "/x" }, ENV)).toThrow(/uuid/);
    expect(() => seed.validateArgs({ owner: OWNER }, ENV)).toThrow(/exactly one/);
    expect(() => seed.validateArgs({ owner: OWNER, dir: "/x", update: "abcdefghjk" }, ENV)).toThrow(/exactly one/);
    expect(() => seed.validateArgs({ owner: OWNER, update: "../etc" }, ENV)).toThrow(/slug/);
    expect(() => seed.validateArgs({ owner: OWNER, dir: "/x", app: "ftp://h" }, ENV)).toThrow(/http/);
    expect(() => seed.validateArgs({ owner: OWNER, dir: "/x" }, { ...ENV, SUPABASE_SECRET_KEY: " " })).toThrow(/SUPABASE_SECRET_KEY/);
  });

  it("common helpers", () => {
    expect(parseAdminIds(`${OWNER.toUpperCase()}, bad,`)).toEqual([OWNER]);
    expect(normaliseAppUrl("https://app.example.com/")).toBe("https://app.example.com");
    expect(() => normaliseAppUrl("http://u:p@h")).toThrow();
  });

  it("mirrors the app's option lists and limits", () => {
    expect(seed.OCCASIONS).toEqual([...OCCASIONS]);
    expect(seed.TONES).toEqual([...TONES]);
    expect(seed.CAPTION_LANGS).toEqual([...CAPTION_LANGS]);
    expect(seed.DEFAULT_TONE).toEqual(DEFAULT_TONE);
    expect(seed.TITLE_MAX_CHARS).toBe(TITLE_MAX_CHARS);
    expect(seed.MAX_PHOTOS_PER_BOOK).toBe(LIMITS.paid.maxUploadPhotos);
  });
});

describe("scripts/seed-demo-books.mjs — folder scan", () => {
  it("reads books, defaults and book.json; ignores hidden/underscore folders and non-photos", () => {
    book("wedding-sara_2026", ["b.JPG", "a.heic", "notes.txt", ".DS_Store"]);
    book("eid", ["1.png"], { title: "عيد ٢٠٢٦", captionLang: "ar", occasion: "family" });
    book("_unused", ["x.jpg"]);
    book(".hidden", ["x.jpg"]);
    const { books, errors, warnings } = seed.scanBooksDir(root);
    expect(errors).toEqual([]);
    expect(warnings).toEqual(["wedding-sara_2026/notes.txt: not a photo, ignored"]);
    expect(books.map((b: { folder: string }) => b.folder)).toEqual(["eid", "wedding-sara_2026"]);
    expect(books[0].options).toEqual({ title: "عيد ٢٠٢٦", captionLang: "ar", occasion: "family", tone: "nostalgic" });
    expect(books[1].options).toEqual({ title: "Wedding Sara 2026", captionLang: "en", occasion: "other", tone: "minimal" });
    expect(books[1].photos.map((p: string) => path.basename(p))).toEqual(["a.heic", "b.JPG"]);
    expect(books[1].state).toBeNull();
  });

  it("reports structural errors", () => {
    book("empty", ["readme.md"]);
    book("badjson", ["1.jpg"], "{nope");
    book("badfields", ["1.jpg"], { captionLang: "fr", extra: 1, title: "x".repeat(121) });
    const { errors } = seed.scanBooksDir(root);
    expect(errors.some((e: string) => e.startsWith("empty: no photos"))).toBe(true);
    expect(errors).toContain("badjson/book.json: not valid JSON");
    const bad = errors.find((e: string) => e.startsWith("badfields/book.json"));
    expect(bad).toMatch(/captionLang/);
    expect(bad).toMatch(/title/);
    expect(bad).toMatch(/extra|Unrecognized/i);
    expect(seed.scanBooksDir(path.join(root, "missing")).errors[0]).toMatch(/not a folder/);
  });

  it("errors with no subfolders and with too many photos", () => {
    expect(seed.scanBooksDir(root).errors[0]).toMatch(/no book folders/);
    book("big", Array.from({ length: 501 }, (_, i) => `${i}.jpg`));
    expect(seed.scanBooksDir(root).errors[0]).toMatch(/501 photos, max 500/);
  });

  it("picks up the resume state file", () => {
    const d = book("trip", ["1.jpg"]);
    seed.writeState(d, { bookId: OTHER, slug: null });
    expect(seed.scanBooksDir(root).books[0].state).toEqual({ bookId: OTHER, slug: null });
    seed.writeState(d, { bookId: OTHER, slug: "trip-abcdefghjk" });
    expect(seed.scanBooksDir(root).books[0].state.slug).toBe("trip-abcdefghjk");
    writeFileSync(path.join(d, ".seeded.json"), '{"bookId":"x"}');
    expect(seed.scanBooksDir(root).books[0].state).toBeNull();
  });
});

describe("scripts/seed-demo-books.mjs — dry run (network mocked)", () => {
  it("validates folders + env + owner + app + migration and creates nothing", async () => {
    book("trip", ["1.jpg", "2.jpg"], { captionLang: "ar" });
    const t = deps();
    const code = await seed.runSeed(["--owner", OWNER, "--dir", root, "--dry-run", "--app", "http://localhost:3999"], t.d);
    expect(code).toBe(0);
    expect(t.err).toEqual([]);
    expect(t.fetchFn).toHaveBeenCalledWith("http://localhost:3999/login", { redirect: "manual" });
    expect(t.admin.auth.admin.getUserById).toHaveBeenCalledWith(OWNER);
    expect(t.admin.calls).toContain("select orders(note, comped_by)");
    expect(t.admin.auth.admin.generateLink).not.toHaveBeenCalled();
    expect(t.admin.rpc).not.toHaveBeenCalled();
    expect(t.launchBrowser).not.toHaveBeenCalled();
    expect(t.out.join("\n")).toMatch(/ok: trip: 2 photos, lang ar/);
    expect(t.out.at(-1)).toMatch(/dry run ok: 1 book folder/);
    const all = [...t.out, ...t.err].join("\n");
    expect(all).not.toContain(SECRET_EMAIL);
    expect(all).not.toContain(ENV.SUPABASE_SECRET_KEY);
  });

  it.each([
    ["app down", { status: 502 }, /app not reachable/],
    ["owner missing", { admin: fakeAdmin({ user: false }) }, /--owner not found/],
    ["owner without email", { admin: fakeAdmin({ email: null }) }, /no email/],
    ["no profile", { admin: fakeAdmin({ profile: false }) }, /no profile/],
    ["migration 1700 missing", { admin: fakeAdmin({ m1700: false }) }, /migration 1700/],
  ])("fails preflight: %s", async (_name, over, re) => {
    book("trip", ["1.jpg"]);
    const t = deps(over as Parameters<typeof deps>[0]);
    expect(await seed.runSeed(["--owner", OWNER, "--dir", root, "--dry-run"], t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(re);
    expect(t.launchBrowser).not.toHaveBeenCalled();
  });

  it("exits 2 on folder errors before touching the network", async () => {
    book("empty", []);
    const t = deps();
    expect(await seed.runSeed(["--owner", OWNER, "--dir", root, "--dry-run"], t.d)).toBe(2);
    expect(t.d.createAdmin).not.toHaveBeenCalled();
    expect(t.fetchFn).not.toHaveBeenCalled();
  });

  it("exits 2 on bad args / env", async () => {
    const t = deps({ env: { ...ENV, ADMIN_USER_IDS: OTHER } });
    expect(await seed.runSeed(["--owner", OWNER, "--dir", root, "--dry-run"], t.d)).toBe(2);
    expect(t.err[0]).toMatch(/ADMIN_USER_IDS/);
  });

  it("--update dry run looks the book up by slug and owner", async () => {
    const t = deps();
    expect(await seed.runSeed(["--owner", OWNER, "--update", "eid-abcdefghjk", "--dry-run"], t.d)).toBe(0);
    expect(t.out.at(-1)).toMatch(/--update would republish/);
  });
});

describe("scripts/seed-demo-books.mjs — snippet", () => {
  it("writes a valid EXAMPLE_BOOKS literal with escaped titles", () => {
    const s = seed.examplesSnippet([
      { slug: "eid-abcdefghjk", title: 'Eid "2026"' },
      { slug: "abcdefghjk", title: "رحلة" },
    ]);
    expect(s).toContain("export const EXAMPLE_BOOKS: readonly ExampleBook[] = [");
    expect(s).toContain('{ slug: "eid-abcdefghjk", title: "Eid \\"2026\\"", coverSrc: "/examples/eid-abcdefghjk.jpg" },');
    expect(s).toContain('title: "رحلة"');
    // Evaluates to the expected array.
    const body = s.slice(s.indexOf("= [") + 2, s.lastIndexOf("]") + 1);
    expect(new Function(`return ${body}`)()).toEqual([
      { slug: "eid-abcdefghjk", title: 'Eid "2026"', coverSrc: "/examples/eid-abcdefghjk.jpg" },
      { slug: "abcdefghjk", title: "رحلة", coverSrc: "/examples/abcdefghjk.jpg" },
    ]);
  });
});

describe("scripts/record-demo.mjs — pure helpers", () => {
  it("parses flags", () => {
    expect(record.parseArgs(["--photos", "/p", "--draft", "--app", "http://x"])).toEqual({ photos: "/p", draft: true, headed: false, app: "http://x" });
    expect(() => record.parseArgs(["--size", "1"])).toThrow();
  });

  it("names outputs (drafts never match the landing page's files)", () => {
    expect(record.outputNames("/o", "mp4", false)).toEqual({ video: "/o/demo.mp4", poster: "/o/poster.jpg", otherExt: "webm" });
    expect(record.outputNames("/o", "webm", true)).toEqual({ video: "/o/demo.draft.webm", poster: "/o/poster.draft.jpg", otherExt: "mp4" });
  });

  it("encode plans step quality down and trim to the flow", () => {
    const h = record.encodePlans(true, 1.234, 60);
    expect(h.map((p: { ext: string }) => p.ext)).toEqual(["mp4", "mp4", "mp4", "mp4"]);
    const a = h[0].args("in.webm", "out.mp4");
    expect(a).toEqual(expect.arrayContaining(["-ss", "1.23", "-t", "60.00", "libx264", "+faststart", "yuv420p", "-an"]));
    const v = record.encodePlans(false, 0, 10);
    expect(v[0].args("i", "o")).toEqual(expect.arrayContaining(["libvpx-vp9", "-crf", "36"]));
    expect(v.at(-1)!.args("i", "o")).toEqual(expect.arrayContaining(["-crf", "54"]));
  });

  it("fails fast without env, before any network", async () => {
    const fetchFn = vi.fn();
    const err: string[] = [];
    const code = await record.runRecord([], { env: {}, fetch: fetchFn, createAdmin: vi.fn(), launchBrowser: vi.fn(), log: () => {}, error: (s: string) => err.push(s) });
    expect(code).toBe(2);
    expect(err[0]).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("demo video selection (src/lib/marketing/demo.ts)", () => {
  const has = (...names: string[]) => (f: string) => names.some((n) => f.endsWith(path.join("public", "demo", n)));

  it("needs a poster and prefers mp4 over webm", () => {
    expect(getDemoVideo(has("demo.mp4"))).toBeNull();
    expect(getDemoVideo(has("poster.jpg"))).toBeNull();
    expect(getDemoVideo(has("poster.jpg", "demo.webm"))).toEqual({ src: "/demo/demo.webm", type: "video/webm", poster: "/demo/poster.jpg" });
    expect(getDemoVideo(has("poster.jpg", "demo.webm", "demo.mp4"))?.src).toBe("/demo/demo.mp4");
    expect(getDemoVideo(has("poster.jpg", "demo.draft.webm", "poster.draft.jpg"))).toBeNull();
  });

  it("renders a <source> with the right type", () => {
    const html = renderToStaticMarkup(DemoVideo({ video: { src: "/demo/demo.webm", type: "video/webm", poster: "/demo/poster.jpg" } }));
    expect(html).toContain('<source src="/demo/demo.webm" type="video/webm"/>');
    expect(html).toContain('poster="/demo/poster.jpg"');
    expect(html).toContain('preload="none"');
  });

  it("the committed public/demo has no draft files tracked by .gitignore rules", () => {
    expect(readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8")).toContain("public/demo/*.draft.*");
  });
});
