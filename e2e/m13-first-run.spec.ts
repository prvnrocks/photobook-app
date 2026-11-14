/**
 * Milestone 13 T10 — first-time-user walkthrough on the NEW flow, LIVE Supabase, 375 px.
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic (server: AI_MODE=replay, empty ANTHROPIC_API_KEY),
 * never calls Stripe (dummy key). Same 40 canvas fixtures as e2e/m13-baseline.spec.ts.
 *
 * Main test (timed, fresh user): landing "Make my book" → login (simulated: admin generateLink →
 * /auth/confirm, no email) → /books/start "Choose photos" (native picker = filechooser, excluded) →
 * NO setup taps → upload + finalize → automatic first build (replay) with the draft strip → editor →
 * Share → share screen → Send on WhatsApp (wa.me stubbed). Asserts:
 *   - ≤ 3 app taps after the photos are chosen (every tap/click in that window goes through tap());
 *   - logs time from photos chosen to the first [data-page] visible (build draft strip and editor page,
 *     each reported) and to the WhatsApp intent; asserts first preview < 60 s (M13 Done when);
 *   - per screen: no horizontal scroll, ≥ 44 px targets, exactly one h1, visible focus ring on Tab
 *     (audits run outside the timed window or after it, so they don't skew the numbers);
 *   - with E2E_ANALYTICS=1 (server built + started with NEXT_PUBLIC_POSTHOG_KEY=phc_e2e_fake and
 *     NEXT_PUBLIC_POSTHOG_HOST=https://ph.e2e.invalid, intercepted here — nothing leaves the machine):
 *     book_created, upload_done, ai_build_done{auto:true} and published each fire exactly once.
 * Variant "setup": opens the setup card on the upload screen, changes occasion (Wedding) and style
 *   (Classic) before the automatic build; the book row + built doc use them.
 * Variant "arabic": Accept-Language ar → the draft's caption language defaults to Arabic (setup card
 *   shows it), replay writes Arabic captions, the editor shows them with dir="auto".
 *
 * Screenshots: docs/design/m13-after-<nn>-<name>-375.png (dir override: M13_SHOT_DIR).
 * One throwaway user per test `e2e+m13run-<random>@example.com`. afterAll (always): storage under
 * `<uid>/` (photos + exports), the users (books/photos cascade), then the replay agent_runs they
 * created (replay = $0). Per-test timeouts only. Logs: counts / timings / booleans only.
 *
 * Example (pinned scratch copy, see .agentos/runs/m13-brief.md):
 *   NEXT_PUBLIC_APP_URL=http://localhost:3713 AI_MODE=replay ANTHROPIC_API_KEY= next build
 *   AI_MODE=replay ANTHROPIC_API_KEY= STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_<random> \
 *     CRON_SECRET= NEXT_PUBLIC_APP_URL=http://localhost:3713 next start -p 3713
 *   E2E_AUTH=1 npx playwright test -c <config: baseURL :3713, no webServer> e2e/m13-first-run.spec.ts
 *   (analytics) build + start a second copy with the fake PostHog key/host, then
 *   E2E_AUTH=1 E2E_ANALYTICS=1 M13_SHOT_DIR=<tmp> npx playwright test -c <config :3714> \
 *     e2e/m13-first-run.spec.ts -g "first run"
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type Request } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENABLED = process.env.E2E_AUTH === "1";
const ANALYTICS = process.env.E2E_ANALYTICS === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live M13 first-run walkthrough");

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const BUCKETS = ["photos", "exports"];
const VIEWPORT = { width: 375, height: 812 };
const SHOT_DIR = process.env.M13_SHOT_DIR || path.join(__dirname, "..", "docs", "design");
const PHOTO_COUNT = 40;
const VARIANT_PHOTOS = 12;
const TAB_STOPS = 6;
const PH_HOST = process.env.E2E_POSTHOG_HOST ?? "https://ph.e2e.invalid";
// posthog-js drops events from headless/bot user agents — present as a normal phone browser.
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UUID = "[0-9a-f-]{36}";
const ARABIC_RE = /[؀-ۿ]/;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let admin: SupabaseClient;
let baseURL = "";
let photoPaths: string[] = [];
const users: { uid: string; email: string; bookIds: Set<string> }[] = [];
const runIds = new Set<string>();

// ---- per-test session ----------------------------------------------------------------------------

type Session = {
  uid: string;
  email: string;
  context: BrowserContext;
  page: Page;
  bookId: string;
  /** First time (Date.now()) a visible [data-page] was seen, per where it was (build-draft / editor / other). */
  firstPage: Record<string, number>;
  events: { event: string; properties: Record<string, unknown> }[];
};

async function newSession(browser: Browser, opts: { locale?: string; analytics?: boolean } = {}): Promise<Session> {
  const email = `e2e+m13run-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  const rec = { uid: data.user.id, email, bookIds: new Set<string>() };
  users.push(rec);

  const context = await browser.newContext({
    viewport: VIEWPORT,
    baseURL,
    hasTouch: true,
    isMobile: true,
    ...(opts.locale ? { locale: opts.locale, extraHTTPHeaders: { "Accept-Language": `${opts.locale},${opts.locale.split("-")[0]};q=0.9` } } : {}),
    ...(opts.analytics ? { userAgent: PHONE_UA } : {}),
  });
  await context.route(/^https:\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\//, (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp (stub)</title>" }),
  );
  const s: Session = { uid: rec.uid, email, context, page: null as unknown as Page, bookId: "", firstPage: {}, events: [] };
  if (opts.analytics) {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
      Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
    });
    await context.route(`${PH_HOST}/**`, async (route) => {
      try {
        for (const e of decodeBody(route.request())) {
          const ev = e as { event?: unknown; properties?: Record<string, unknown> };
          if (ev && typeof ev.event === "string") s.events.push({ event: ev.event, properties: ev.properties ?? {} });
        }
      } catch {
        /* undecodable batch: counted as missing events below */
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' });
    });
    await context.route(/posthog\.com/, (r) => r.abort());
  }
  // First visible book page, per container, reported from a rAF loop in every document.
  await context.exposeBinding("__m13FirstPage", (_src, where: string, at: number) => {
    if (s.firstPage[where] === undefined) s.firstPage[where] = at;
  });
  await context.addInitScript(() => {
    const seen = new Set<string>();
    const tick = () => {
      for (const el of Array.from(document.querySelectorAll("[data-page]"))) {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) continue;
        const where = el.closest('[data-testid="build-draft"]')
          ? "build-draft"
          : el.closest('[data-testid="editor-shell"]')
            ? "editor"
            : `other:${location.pathname.replace(/[0-9a-f-]{36}/, ":id")}`;
        if (!seen.has(where)) {
          seen.add(where);
          (window as unknown as { __m13FirstPage?: (w: string, t: number) => void }).__m13FirstPage?.(where, Date.now());
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  s.page = await context.newPage();
  s.page.on("dialog", (d) => void d.accept());
  return s;
}

function decodeBody(req: Request): unknown[] {
  const buf = req.postDataBuffer();
  if (!buf || buf.length === 0) return [];
  const url = new URL(req.url());
  let text: string;
  if (url.searchParams.get("compression") === "gzip-js" || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    text = gunzipSync(buf).toString("utf8");
  } else {
    text = buf.toString("utf8");
    if (text.startsWith("data=")) text = Buffer.from(decodeURIComponent(text.slice(5)), "base64").toString("utf8");
  }
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { batch?: unknown[] }).batch)) {
    return (parsed as { batch: unknown[] }).batch;
  }
  return [parsed];
}

async function signIn(s: Session, next: string) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: s.email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
  await s.page.goto(`/auth/confirm?token_hash=${data.properties.hashed_token}&type=magiclink&next=${encodeURIComponent(next)}`);
}

function route(p: Page) {
  return new URL(p.url()).pathname.replace(/[0-9a-f-]{36}/, ":id");
}

// ---- measurement -------------------------------------------------------------------------------

type Decisions = { radioGroups: number; textInputs: number; buttons: number; links: number };

/** Visible choices inside <main> (header nav excluded) — same rule as the T1 baseline. */
async function decisions(p: Page): Promise<Decisions> {
  return p.evaluate(() => {
    const root = document.querySelector("main") ?? document.body;
    const vis = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const cs = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const radios = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    const groups = new Set(radios.filter((r) => vis(r.closest("label") ?? r)).map((r) => r.name));
    const textInputs = Array.from(
      root.querySelectorAll<HTMLElement>('input[type="text"], input[type="email"], input:not([type]), textarea'),
    ).filter((el) => vis(el) && !(el as HTMLInputElement).readOnly).length;
    const buttons = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], [role="tab"]')).filter(
      (el) => vis(el) && !(el as HTMLButtonElement).disabled,
    ).length;
    const links = Array.from(root.querySelectorAll<HTMLElement>("a[href]")).filter(vis).length;
    return { radioGroups: groups.size, textInputs, buttons, links };
  });
}

async function shot(p: Page, name: string) {
  mkdirSync(SHOT_DIR, { recursive: true });
  await p
    .evaluate(() => {
      document.querySelectorAll("nextjs-portal").forEach((n) => n.remove());
      window.scrollTo(0, 0); // a sticky header otherwise lands mid-image in a full-page shot
    })
    .catch(() => {});
  // animations "disabled": finish CSS transitions first (a mid-fade card / chevron is not what users see).
  await p.screenshot({ path: path.join(SHOT_DIR, `m13-after-${name}-375.png`), fullPage: true, animations: "disabled" });
}

/** Waits (≤ 10 s) for in-viewport images so a screenshot shows what a user sees. */
async function imagesSettled(p: Page) {
  await expect
    .poll(
      () =>
        p.evaluate(() =>
          Array.from(document.images).every((img) => {
            const r = img.getBoundingClientRect();
            const inView = r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
            return !inView || (img.complete && img.naturalWidth > 0);
          }),
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
    .catch(() => console.log("[m13-run] some in-view images still loading"));
}

// ---- a11y audit (same rules as e2e/m11.spec.ts) --------------------------------------------------

type Target = { desc: string; w: number; h: number; reason?: "inline" | "book" };

async function measure(p: Page) {
  return p.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      return (el as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true;
    };
    const desc = (el: Element) => {
      const tid = el.getAttribute("data-testid");
      const label = (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""} "${label}"`;
    };
    const isInline = (el: Element) => {
      if (el.tagName !== "A") return false;
      if (getComputedStyle(el).display !== "inline") return false;
      let block = el.parentElement;
      while (block && getComputedStyle(block).display === "inline") block = block.parentElement;
      const own = ((el as HTMLElement).innerText ?? "").trim().length;
      const all = ((block as HTMLElement | null)?.innerText ?? "").trim().length;
      return all > own + 10;
    };
    const sel = "a[href],button,[role=button],[role=tab],[role=menuitem],[role=link],summary,select,textarea,input:not([type=hidden])";
    const small: Target[] = [];
    const excepted: Target[] = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      let box: Element = el;
      if (el.tagName === "INPUT" && /^(radio|checkbox|file)$/.test((el as HTMLInputElement).type)) {
        const lab = el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
        if (lab) box = lab;
      }
      if (!visible(box)) continue;
      const r = box.getBoundingClientRect();
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      const t = { desc: desc(el), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
      if (el.closest("[data-page]")) excepted.push({ ...t, reason: "book" });
      else if (isInline(el)) excepted.push({ ...t, reason: "inline" });
      else small.push(t);
    }
    const h1 = Array.from(document.querySelectorAll("h1")).filter((h) => (h as HTMLElement).checkVisibility?.() ?? true).length;
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, h1, small, excepted };
  });
}

async function focusStops(p: Page) {
  // Start the walk from the top of the document, like a keyboard user arriving on the page: the
  // sequential-focus start point would otherwise stay on the last tapped control.
  await p.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.scrollTo(0, 0);
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.id = "m13-focus-start";
    document.body.prepend(start);
    start.focus({ preventScroll: true });
  });
  const out: { desc: string; visible: boolean }[] = [];
  for (let i = 0; i < TAB_STOPS; i++) {
    await p.keyboard.press("Tab");
    await p.waitForTimeout(120);
    const r = await p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const has = (e: Element) => {
        const s = getComputedStyle(e);
        return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow !== "none" && s.boxShadow !== "");
      };
      let ok = has(el);
      const label = el.closest("label");
      if (!ok && label) ok = has(label);
      let q = el.parentElement;
      for (let k = 0; !ok && q && k < 3; k++, q = q.parentElement) ok = has(q) && q.matches(":focus-within");
      const tid = el.getAttribute("data-testid");
      const name = (el.getAttribute("aria-label") ?? el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
      return { desc: `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""} "${name}"`, visible: ok };
    });
    if (!r) break;
    out.push(r);
  }
  await p.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.getElementById("m13-focus-start")?.remove();
  });
  return out;
}

const auditLog: string[] = [];

/** Soft assertions so one run reports every screen. `tab: false` on screens that move on by themselves. */
async function audit(p: Page, name: string, opts: { tab?: boolean } = {}) {
  await p.locator("h1").first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()));
  const m = await measure(p);
  const focus = opts.tab === false ? [] : await focusStops(p);
  const line = `[a11y ${name}] sw=${m.scrollWidth}/${m.innerWidth} h1=${m.h1} small=${m.small.length} excepted=${m.excepted.length} focus=${focus.filter((f) => f.visible).length}/${focus.length}`;
  auditLog.push(line);
  console.log(line);
  for (const e of m.excepted) console.log(`  [exception ${name}] ${e.desc} ${e.w}×${e.h} (${e.reason})`);
  expect.soft(m.scrollWidth, `${name}: horizontal scroll`).toBeLessThanOrEqual(m.innerWidth);
  expect.soft(m.h1, `${name}: exactly one h1`).toBe(1);
  expect.soft(m.small, `${name}: targets under 44×44`).toEqual([]);
  if (opts.tab !== false) {
    expect.soft(focus.length, `${name}: Tab reaches a control`).toBeGreaterThan(0);
    expect.soft(focus.filter((f) => !f.visible), `${name}: focus without a visible ring`).toEqual([]);
  }
}

// ---- fixtures (identical generator to e2e/m13-baseline.spec.ts) ----------------------------------

async function makeFixtures(p: Page, dir: string): Promise<string[]> {
  const list = await p.evaluate(async (count) => {
    function rng(seed: number) {
      let s = seed >>> 0;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    }
    function toB64(c: HTMLCanvasElement, q: number): Promise<string> {
      return new Promise((resolve) =>
        c.toBlob(
          (blob) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(",")[1]);
            fr.readAsDataURL(blob!);
          },
          "image/jpeg",
          q,
        ),
      );
    }
    function draw(seed: number, landscape: boolean): HTMLCanvasElement {
      const r = rng(seed * 7919 + 31);
      const c = document.createElement("canvas");
      c.width = landscape ? 1600 : 1200;
      c.height = landscape ? 1200 : 1600;
      const g = c.getContext("2d")!;
      const cols = landscape ? 8 : 6;
      const rows = landscape ? 6 : 8;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
          g.fillRect(x * 200, y * 200, 200, 200);
        }
      }
      for (let i = 0; i < 12; i++) {
        g.fillStyle = `hsla(${Math.floor(r() * 360)}, 70%, ${20 + Math.floor(r() * 60)}%, 0.85)`;
        g.beginPath();
        g.arc(r() * c.width, r() * c.height, 40 + r() * 220, 0, Math.PI * 2);
        g.fill();
      }
      const img = g.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < img.data.length; i += 4) {
        const d = Math.floor((r() - 0.5) * 50);
        img.data[i] += d;
        img.data[i + 1] += d;
        img.data[i + 2] += d;
      }
      g.putImageData(img, 0, 0);
      return c;
    }
    function blurred(src: HTMLCanvasElement): HTMLCanvasElement {
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      const g = c.getContext("2d")!;
      g.filter = "blur(14px)";
      g.drawImage(src, 0, 0);
      return c;
    }
    function nearCopy(src: HTMLCanvasElement): HTMLCanvasElement {
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      const g = c.getContext("2d")!;
      g.filter = "brightness(1.04)";
      g.drawImage(src, 0, 0);
      return c;
    }
    const out: { name: string; b64: string }[] = [];
    const uniques: { c: HTMLCanvasElement; b64: string; land: boolean }[] = [];
    for (let i = 0; i < 33; i++) {
      const land = i % 5 !== 1 && i % 5 !== 3;
      const c = draw(1300 + i, land);
      const b64 = await toB64(c, 0.9);
      uniques.push({ c, b64, land });
      out.push({ name: `trip-${String(i + 1).padStart(2, "0")}.jpg`, b64 });
    }
    out.push({ name: "trip-03-copy.jpg", b64: uniques[2].b64 });
    out.push({ name: "trip-10-copy.jpg", b64: uniques[9].b64 });
    out.push({ name: "trip-05-again.jpg", b64: await toB64(nearCopy(uniques[4].c), 0.82) });
    out.push({ name: "trip-18-again.jpg", b64: await toB64(nearCopy(uniques[17].c), 0.82) });
    for (const k of [6, 13, 21]) {
      const src = draw(9000 + k, k % 2 === 0);
      out.push({ name: `blurry-${k}.jpg`, b64: await toB64(blurred(src), 0.9) });
    }
    return out.slice(0, count);
  }, PHOTO_COUNT);
  mkdirSync(dir, { recursive: true });
  return list.map(({ name, b64 }) => {
    const file = path.join(dir, name);
    writeFileSync(file, Buffer.from(b64, "base64"));
    return file;
  });
}

// ---- shared flow steps ---------------------------------------------------------------------------

/** /books/start → tap "Choose photos" → picker → files. Returns the time the files were chosen. */
async function choosePhotos(s: Session, files: string[], onTap?: () => void): Promise<number> {
  const pick = s.page.getByTestId("start-pick");
  await expect(pick).toBeVisible({ timeout: 30_000 });
  const chooserP = s.page.waitForEvent("filechooser");
  await pick.tap();
  onTap?.();
  const chooser = await chooserP;
  const at = Date.now();
  await chooser.setFiles(files);
  await s.page.waitForURL(new RegExp(`/books/${UUID}/upload`), { timeout: 60_000 });
  s.bookId = new URL(s.page.url()).pathname.split("/")[2];
  users.find((u) => u.uid === s.uid)?.bookIds.add(s.bookId);
  return at;
}

async function waitForEditor(s: Session, timeout: number) {
  await s.page.waitForURL(new RegExp(`/books/${s.bookId}/edit`), { timeout });
  await expect(s.page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
}

async function collectRuns() {
  for (const u of users) {
    const byUser = await admin.from("agent_runs").select("id").eq("user_id", u.uid);
    for (const r of byUser.data ?? []) runIds.add(r.id);
    for (const b of u.bookIds) {
      const byBook = await admin.from("agent_runs").select("id").eq("book_id", b);
      for (const r of byBook.data ?? []) runIds.add(r.id);
    }
  }
}

async function listUserObjects(bucket: string, uid: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (prefix: string, depth: number) => {
    const res = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
    if (res.error) throw new Error(`storage list failed (${res.error.message})`);
    for (const e of res.data ?? []) {
      if (e.id || depth >= 3) out.push(`${prefix}/${e.name}`);
      else await walk(`${prefix}/${e.name}`, depth + 1);
    }
  };
  await walk(uid, 0);
  return out;
}

// ---- spec --------------------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  photoPaths = await makeFixtures(p, info.outputPath("m13-fixtures"));
  await ctx.close();
  console.log(`[m13-run] fixtures=${photoPaths.length}`);
});

test.afterAll(async () => {
  test.setTimeout(240_000);
  if (users.length === 0) return;
  await collectRuns().catch(() => {});
  let removed = 0;
  let left = 0;
  let booksLeft = 0;
  let deleted = 0;
  for (const u of users) {
    for (const bucket of BUCKETS) {
      for (let round = 0; round < 3; round++) {
        const paths = await listUserObjects(bucket, u.uid).catch(() => [] as string[]);
        if (paths.length === 0) break;
        for (let i = 0; i < paths.length; i += 100) await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
        removed += paths.length;
      }
    }
    await admin.from("orders").delete().eq("user_id", u.uid);
    for (const b of u.bookIds) await admin.from("exports").delete().eq("book_id", b);
    const { error } = await admin.auth.admin.deleteUser(u.uid);
    if (!error) deleted++;
    for (const bucket of BUCKETS) left += (await listUserObjects(bucket, u.uid).catch(() => [] as string[])).length;
    booksLeft += (await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", u.uid)).count ?? 0;
  }
  const ids = [...runIds];
  let runsDeleted = 0;
  let runsLeft = 0;
  if (ids.length) {
    runsDeleted = (await admin.from("agent_runs").delete().in("id", ids).select("id")).data?.length ?? 0;
    runsLeft = (await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", ids)).count ?? 0;
  }
  console.log(
    `[cleanup] users=${users.length} deleted=${deleted} objects removed=${removed} left=${left} books=${booksLeft} runsFound=${ids.length} runsDeleted=${runsDeleted} runsLeft=${runsLeft}`,
  );
  if (runsLeft) console.log(`[cleanup] runs left: ${ids.join(",")}`);
  expect(deleted).toBe(users.length);
  expect(left).toBe(0);
  expect(booksLeft).toBe(0);
  expect(runsLeft).toBe(0);
});

test("first run: landing → login → choose photos → auto build → editor → Share → WhatsApp (≤ 3 taps)", async ({ browser }) => {
  test.setTimeout(900_000);
  const s = await newSession(browser, { analytics: ANALYTICS });
  const page = s.page;
  const screens: { name: string; route: string; decisions: Decisions }[] = [];
  const screen = async (n: number, name: string) => {
    const d = await decisions(page);
    screens.push({ name, route: route(page), decisions: d });
    console.log(
      `[m13-run] screen ${screens.length}: ${name} (${route(page)}) radioGroups=${d.radioGroups} textInputs=${d.textInputs} buttons=${d.buttons} links=${d.links}`,
    );
    await shot(page, `${String(n).padStart(2, "0")}-${name}`);
  };

  // Taps before the photos are chosen (landing CTA, Choose photos) are reported, not limited.
  const preTaps: string[] = [];
  const taps: { label: string; route: string; at: number }[] = [];
  let counting = false;
  const tap = async (target: Locator, label: string) => {
    await target.scrollIntoViewIfNeeded();
    await target.tap();
    if (counting) taps.push({ label, route: route(page), at: Date.now() });
    else preTaps.push(label);
    console.log(`[m13-run] ${counting ? `tap ${taps.length}` : "pre-tap"}: ${label} (${route(page)})`);
  };

  // 1. Landing.
  await page.goto("/");
  const cta = page.getByTestId("cta-create");
  await expect(cta).toBeVisible();
  await expect(cta).toContainText("Make my book");
  await screen(1, "landing");
  await audit(page, "landing");
  await tap(cta, "Make my book (landing)");

  // 2. Login (typing excluded; magic link simulated) → next=/books/start.
  await page.waitForURL(/\/login\?/, { timeout: 30_000 });
  expect(new URL(page.url()).searchParams.get("next")).toBe("/books/start");
  await expect(page.getByTestId("login-email")).toBeVisible();
  await screen(2, "login");
  await audit(page, "login");
  await signIn(s, "/books/start");
  await expect(page).toHaveURL(/\/books\/start/, { timeout: 30_000 });

  // 3. Start: one big "Choose photos".
  await expect(page.getByTestId("start-pick")).toBeVisible({ timeout: 30_000 });
  await screen(3, "start");
  await audit(page, "start");
  const photosChosen = await choosePhotos(s, photoPaths, () => preTaps.push("Choose photos (start)"));
  counting = true;
  const since = (t: number | undefined) => (t === undefined ? null : t - photosChosen);
  console.log(`[m13-run] photos chosen; upload screen after ${Date.now() - photosChosen} ms`);

  // 4. Upload: zero setup taps; the setup card defaults; progress → auto build.
  await expect(page.getByTestId("setup-card")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("upload-pick")).toHaveCount(0); // no second picker
  await expect(page.getByTestId("upload-progress")).toBeVisible({ timeout: 60_000 });
  await screen(4, "upload");
  await expect(page.getByTestId("setup-occasion-other")).toBeChecked();

  // 5. Build screen (replay) with the draft strip, then straight to the editor.
  await page.waitForURL(new RegExp(`/books/${s.bookId}/build`), { timeout: 420_000 });
  const buildUrlAt = Date.now();
  expect(new URL(page.url()).searchParams.get("auto")).toBe("1");
  let buildShot = false;
  const strip = page.getByTestId("build-draft-strip");
  if (await strip.waitFor({ state: "visible", timeout: 20_000 }).then(() => true, () => false)) {
    await imagesSettled(page);
    if (/\/build/.test(page.url())) {
      await screen(5, "build");
      buildShot = true;
    }
  }
  console.log(`[m13-run] build screen shot=${buildShot}`);
  await waitForEditor(s, 420_000);
  const editorAt = Date.now();
  await expect.poll(() => s.firstPage.editor !== undefined, { timeout: 60_000 }).toBe(true);
  await imagesSettled(page);
  await screen(6, "editor");
  const chip = page.getByTestId("ai-summary-chip");
  const chipText = (await chip.isVisible().catch(() => false)) ? ((await page.getByTestId("ai-summary-label").textContent()) ?? "") : "";
  console.log(`[m13-run] AI chip visible=${chipText !== ""} text="${chipText.replace(/\d+/g, "N")}"`);
  expect(chipText).toMatch(/kept \d+ of \d+/i);

  // 6. Share (publishes) → share screen.
  await expect(page.getByTestId("editor-share-note")).toContainText(/30 days/);
  await tap(page.getByTestId("editor-done"), "Share (editor)");
  await expect(page).toHaveURL(new RegExp(`/books/${s.bookId}/publish`), { timeout: 60_000 });
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 60_000 });
  const wa = page.getByTestId("share-whatsapp");
  await expect(wa).toBeVisible();
  const sharedAt = Date.now();
  await imagesSettled(page);
  await screen(7, "share");

  // 7. WhatsApp intent.
  expect((await wa.getAttribute("href")) ?? "").toMatch(/^https:\/\/wa\.me\/\?text=/);
  const popupP = page.waitForEvent("popup", { timeout: 15_000 });
  await tap(wa, "Send on WhatsApp");
  const popup = await popupP;
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  expect(popup.url()).toMatch(/^https:\/\/wa\.me\//);
  const whatsappAt = Date.now();
  await popup.close();
  counting = false;

  // Analytics, checked while still on the share screen (a full page load drops posthog's queue).
  if (ANALYTICS) {
    const want = ["book_created", "upload_done", "ai_build_done", "published"] as const;
    const count = (e: string) => s.events.filter((x) => x.event === e).length;
    await expect
      .poll(() => want.every((e) => count(e) >= 1), { timeout: 30_000 })
      .toBe(true)
      .catch(() => console.log("[m13-run] analytics: not every expected event arrived (counts below)"));
    await page.waitForTimeout(4000); // let any duplicate batch arrive (still on the share screen)
    const counts = Object.fromEntries(want.map((e) => [e, count(e)]));
    console.log(`[m13-run] analytics counts ${JSON.stringify(counts)} all=${JSON.stringify([...new Set(s.events.map((e) => e.event))])}`);
    for (const e of want) expect.soft(count(e), `${e} fires once`).toBe(1);
    const build = s.events.find((x) => x.event === "ai_build_done");
    expect.soft(build?.properties.auto, "ai_build_done.auto").toBe(true);
    const published = s.events.find((x) => x.event === "published");
    console.log(`[m13-run] ai_build_done props=${JSON.stringify(Object.keys(build?.properties ?? {}).filter((k) => !k.startsWith("$")))} published first=${String(published?.properties.first)}`);
  }

  // ≤ 3 app taps after the photos were chosen.
  expect(taps.length, taps.map((t) => t.label).join(" | ")).toBeLessThanOrEqual(3);

  const firstPreview = Math.min(...[s.firstPage["build-draft"], s.firstPage.editor].filter((v): v is number => v !== undefined));
  const summary = {
    viewport: "375x812",
    photosSelected: photoPaths.length,
    preTaps,
    appTapsAfterPhotos: taps.length,
    taps: taps.map((t, i) => `${i + 1}. ${t.label}`),
    routes: [...new Set(screens.map((x) => x.route)), "wa.me (WhatsApp)"],
    screens: screens.map((x) => ({ name: x.name, route: x.route, ...x.decisions })),
    ms: {
      photosChosenToBuildScreen: since(buildUrlAt),
      photosChosenToFirstDraftPage: since(s.firstPage["build-draft"]),
      photosChosenToEditor: since(editorAt),
      photosChosenToFirstEditorPage: since(s.firstPage.editor),
      photosChosenToFirstPreview: since(firstPreview),
      photosChosenToSharedLink: since(sharedAt),
      photosChosenToWhatsapp: since(whatsappAt),
      otherFirstPages: Object.fromEntries(Object.entries(s.firstPage).filter(([k]) => k.startsWith("other:")).map(([k, v]) => [k, since(v)])),
    },
    analytics: ANALYTICS,
  };
  console.log(`[m13-run] SUMMARY ${JSON.stringify(summary)}`);
  expect(summary.ms.photosChosenToFirstPreview).not.toBeNull();
  expect(summary.ms.photosChosenToFirstPreview!).toBeLessThan(60_000);

  // a11y on the stable screens reached in the timed run (after the clock stopped).
  await audit(page, "share");
  const { data: row } = await admin.from("books").select("occasion, caption_lang, design_style, format, slug").eq("id", s.bookId).single();
  const r = row as { occasion: string | null; caption_lang: string; design_style: string; format: string; slug: string | null } | null;
  console.log(`[m13-run] defaults occasion=${r?.occasion} lang=${r?.caption_lang} style=${r?.design_style} format=${r?.format} published=${Boolean(r?.slug)}`);
  expect(r?.caption_lang).toBe("en");
  await page.goto(`/books/${s.bookId}/edit`);
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
  await audit(page, "editor");
  // The chip still leads to review (not counted: outside the timed flow).
  await expect(page.getByTestId("ai-summary-link")).toHaveAttribute("href", new RegExp(`/books/${s.bookId}/review`));

  await s.context.close();
});

test("setup variant: open the setup card, change occasion + style before the automatic build", async ({ browser }) => {
  test.setTimeout(600_000);
  const s = await newSession(browser);
  const page = s.page;
  await signIn(s, "/books/start");
  await expect(page).toHaveURL(/\/books\/start/, { timeout: 30_000 });
  await choosePhotos(s, photoPaths.slice(0, VARIANT_PHOTOS));

  await expect(page.getByTestId("setup-card")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("setup-occasion-wedding").locator("xpath=ancestor::label[1]").tap();
  await page.getByTestId("setup-change").tap();
  await expect(page.getByTestId("setup-panel")).toBeVisible();
  // Wedding → the style follows it (Modern) until picked; then pick Classic.
  await expect(page.getByTestId("setup-style-modern")).toBeChecked();
  await page.getByTestId("setup-style-classic").locator("xpath=ancestor::label[1]").tap();
  await expect(page.getByTestId("setup-style-classic")).toBeChecked();
  await shot(page, "upload-setup-open");
  // The automatic build may navigate away mid-walk; a walk cut short is reported, not failed.
  await audit(page, "upload-setup-open").catch((e: Error) => console.log(`[m13-run setup] upload audit cut short: ${e.message.split("\n")[0]}`));

  await page.waitForURL(new RegExp(`/books/${s.bookId}/build`), { timeout: 300_000 });
  if (await page.getByTestId("build-draft-strip").waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false)) {
    // The build screen moves on by itself: no Tab walk (it has no controls while running).
    await audit(page, "build", { tab: false });
  } else console.log("[m13-run setup] build draft strip not seen");
  await waitForEditor(s, 300_000);
  const { data: row } = await admin.from("books").select("occasion, design_style, tone, doc").eq("id", s.bookId).single();
  const r = row as { occasion: string; design_style: string; tone: string | null; doc: { style?: { designStyle?: string } } | null };
  console.log(`[m13-run setup] occasion=${r.occasion} style=${r.design_style} tone=${r.tone} docStyle=${r.doc?.style?.designStyle ?? "(v1 default)"}`);
  expect(r.occasion).toBe("wedding");
  expect(r.design_style).toBe("classic");
  expect(r.doc?.style?.designStyle ?? "classic").toBe("classic");
  await imagesSettled(page);
  await shot(page, "setup-variant-editor");
  await s.context.close();
});

test("arabic variant: Accept-Language ar → Arabic captions by default", async ({ browser }) => {
  test.setTimeout(600_000);
  const s = await newSession(browser, { locale: "ar-AE" });
  const page = s.page;
  await signIn(s, "/books/start");
  await expect(page).toHaveURL(/\/books\/start/, { timeout: 30_000 });
  await choosePhotos(s, photoPaths.slice(0, VARIANT_PHOTOS));

  await expect(page.getByTestId("setup-card")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("setup-change").tap();
  await expect(page.getByTestId("setup-lang-ar")).toBeChecked();
  await shot(page, "upload-arabic");
  const { data: start } = await admin.from("books").select("caption_lang").eq("id", s.bookId).single();
  expect((start as { caption_lang: string }).caption_lang).toBe("ar");

  await waitForEditor(s, 300_000);
  // Arabic captions on book pages, with dir="auto".
  const captions = page.locator('[data-page] [dir="auto"]');
  await expect.poll(async () => (await captions.allTextContents()).filter((t) => ARABIC_RE.test(t)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const { data: row } = await admin.from("books").select("caption_lang, doc").eq("id", s.bookId).single();
  const doc = (row as { doc: { pages?: { caption?: { text?: string } | null }[] } }).doc;
  const caps = (doc.pages ?? []).map((p) => p.caption?.text ?? "").filter(Boolean);
  const arabic = caps.filter((t) => ARABIC_RE.test(t)).length;
  console.log(`[m13-run arabic] captions=${caps.length} arabic=${arabic}`);
  expect(caps.length).toBeGreaterThan(0);
  expect(arabic).toBe(caps.length);
  await imagesSettled(page);
  await shot(page, "editor-arabic");
  // Find a page with a visible caption for the screenshot (carousel steps, not part of any flow).
  for (let i = 0; i < 6; i++) {
    const vis = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-page] [dir="auto"]')).some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.left >= 0 && r.right <= innerWidth && /[؀-ۿ]/.test(el.textContent ?? "");
      }),
    );
    if (vis) break;
    const next = page.getByTestId("carousel-next");
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
    await page.waitForTimeout(500);
  }
  await imagesSettled(page);
  await shot(page, "editor-arabic-caption");
  await s.context.close();
});
