/**
 * Milestone 11 — app UX polish gate at 375 px (T18).
 *
 * For every screen it checks the M11 rollout rules:
 *   - no horizontal scroll (documentElement.scrollWidth <= innerWidth);
 *   - every visible button / link / form control is at least 44×44 px (justified exceptions are
 *     listed in the test annotations, never silently ignored — see `EXCEPTION_REASONS`);
 *   - pressing Tab moves focus to a control that shows a visible focus indicator (outline or ring
 *     box-shadow on the control, its label or a close ancestor) — first TAB_STOPS stops;
 *   - exactly one visible <h1>.
 *
 * Part 1 (any `next dev` server, no auth / no Supabase writes): landing, login, privacy, terms,
 * app not-found, /b/<unknown> not-found, /dev-style, and the dev fixtures (/dev-publish draft +
 * live, /dev-editor, /dev-viewer, /dev-upgrade). Dev fixtures 404 under `next start` → those
 * tests skip themselves there.
 *
 * Part 2 (opt-in, E2E_AUTH=1, LIVE hosted Supabase; server with AI_MODE=replay and no
 * ANTHROPIC_API_KEY): ONE throwaway user `e2e+m11-<random>@example.com` (admin createUser +
 * generateLink, no email). Serial flow at 375 px: dashboard empty → new book → upload 6 synthetic
 * JPEGs → AI build (a fresh load of /build starts a run — done exactly once, deliberately) with the
 * stage checklist recorded (steps only move forward, never "done" before the server reported a
 * later state) → review → editor → publish draft → live (WhatsApp button green rgb(15,122,64)) →
 * /b/ viewer → password gate → expired → unavailable → dashboard with the book → settings + account
 * menu open → sign out from the account menu. afterAll (always): storage objects under `<uid>/` in
 * photos + exports, exports/orders rows, the user (books/photos cascade) and the agent_runs this
 * user created (their ids are nulled by the cascade, so they are captured before the delete).
 * Per-test timeouts only (no --global-timeout, so afterAll runs). Logs: counts / booleans only.
 *
 * Screenshots: M11_SHOT_DIR=<dir> saves m11-after-<screen>-375.png there (docs/design holds the
 * committed set); otherwise they go to the test output folder.
 *
 * Example:
 *   (dev, part 1)  npx playwright test -c <config: baseURL of a next dev server> e2e/m11.spec.ts
 *   (live, part 2) E2E_AUTH=1 npx playwright test -c <config: baseURL of next start, AI_MODE=replay> e2e/m11.spec.ts
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const VIEWPORT = { width: 375, height: 812 };
const TAB_STOPS = 6;
const LIVE = process.env.E2E_AUTH === "1";

if (LIVE && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

/** Why a small target is allowed. Anything else under 44×44 fails. */
const EXCEPTION_REASONS = {
  inline: "inline link inside a sentence (WCAG 2.5.8 inline exception)",
  book: "inside a book page ([data-page]) — book render is frozen by the goldens/pixel gate",
} as const;

type Target = { desc: string; w: number; h: number; reason?: keyof typeof EXCEPTION_REASONS };
type Audit = {
  scrollWidth: number;
  innerWidth: number;
  h1: number;
  small: Target[];
  excepted: Target[];
  focus: { desc: string; visible: boolean }[];
};

const shotPath = (info: TestInfo, name: string) =>
  process.env.M11_SHOT_DIR ? path.join(process.env.M11_SHOT_DIR, name) : info.outputPath(name);

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  // The Next dev overlay badge is not part of the app.
  await page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()));
  await page.waitForTimeout(300);
}

async function measure(page: Page): Promise<Omit<Audit, "focus">> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false; // sr-only
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
    const sel = [
      "a[href]",
      "button",
      "[role=button]",
      "[role=tab]",
      "[role=menuitem]",
      "[role=link]",
      "summary",
      "select",
      "textarea",
      "input:not([type=hidden])",
    ].join(",");
    const small: { desc: string; w: number; h: number; reason?: "inline" | "book" }[] = [];
    const excepted: typeof small = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      let box: Element = el;
      if (el.tagName === "INPUT" && /^(radio|checkbox)$/.test((el as HTMLInputElement).type)) {
        // Custom radio/checkbox cards: the hit area is the label.
        const lab = el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
        if (lab) box = lab;
      }
      if (!visible(box)) continue;
      const r = box.getBoundingClientRect();
      // Below 44 by more than a rounding hair.
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      const t = { desc: desc(el), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
      if (el.closest("[data-page]")) excepted.push({ ...t, reason: "book" });
      else if (isInline(el)) excepted.push({ ...t, reason: "inline" });
      else small.push(t);
    }
    const h1 = Array.from(document.querySelectorAll("h1")).filter((h) => {
      const r = h.getBoundingClientRect();
      // sr-only h1s (1×1 clip) still count — they are the page's heading for screen readers.
      return (h as HTMLElement).checkVisibility?.() ?? r.width > 0;
    }).length;
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, h1, small, excepted };
  });
}

async function focusStops(page: Page, n = TAB_STOPS) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.scrollTo(0, 0);
  });
  // Start from the document, like a keyboard user arriving on the page.
  await page.locator("body").focus().catch(() => {});
  const out: { desc: string; visible: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(120); // ring transitions
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const has = (e: Element) => {
        const s = getComputedStyle(e);
        const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
        const ring = s.boxShadow !== "none" && s.boxShadow !== "";
        return outline || ring;
      };
      let ok = has(el);
      const label = el.closest("label");
      if (!ok && label) ok = has(label);
      let p = el.parentElement;
      for (let k = 0; !ok && p && k < 3; k++, p = p.parentElement) ok = has(p) && p.matches(":focus-within");
      const tid = el.getAttribute("data-testid");
      const name = (el.getAttribute("aria-label") ?? el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
      return { desc: `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""} "${name}"`, visible: ok };
    });
    if (!r) break;
    out.push(r);
  }
  return out;
}

/** Runs every check as soft assertions so one run reports all screens; returns the raw audit. */
async function audit(
  page: Page,
  name: string,
  opts: { tab?: boolean; shot?: string; h1?: { count: number; why: string } } = {},
): Promise<Audit> {
  // Route loading.tsx skeletons have no h1 — wait for the real screen first.
  await page.locator("h1").first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
  await settle(page);
  const m = await measure(page);
  // A screen with nothing focusable (e.g. a polling spinner) has no Tab stop to check.
  const tabbable = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>("a[href],button,input,select,textarea,summary,[tabindex]")).filter(
        (e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled && e.getBoundingClientRect().width > 0 && e.checkVisibility(),
      ).length,
  );
  const focus = opts.tab === false || tabbable === 0 ? [] : await focusStops(page);
  const info = test.info();
  if (opts.shot) {
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: shotPath(info, `m11-after-${opts.shot}-375.png`), fullPage: true });
  }
  for (const e of m.excepted) {
    const description = `${name}: ${e.desc} ${e.w}×${e.h} — ${EXCEPTION_REASONS[e.reason!]}`;
    info.annotations.push({ type: "target-exception", description });
    console.log(`  [exception] ${description}`);
  }
  console.log(
    `[${name}] sw=${m.scrollWidth}/${m.innerWidth} h1=${m.h1} small=${m.small.length} excepted=${m.excepted.length} tabbable=${tabbable} focus=${focus.filter((f) => f.visible).length}/${focus.length}`,
  );
  expect.soft(m.scrollWidth, `${name}: horizontal scroll`).toBeLessThanOrEqual(m.innerWidth);
  if (opts.h1) info.annotations.push({ type: "h1-exception", description: `${name}: ${opts.h1.count} h1 — ${opts.h1.why}` });
  expect.soft(m.h1, `${name}: exactly one h1`).toBe(opts.h1?.count ?? 1);
  expect.soft(m.small, `${name}: targets under 44×44`).toEqual([]);
  if (opts.tab !== false && tabbable > 0) {
    expect.soft(focus.length, `${name}: Tab reaches a control`).toBeGreaterThan(0);
    expect.soft(focus.filter((f) => !f.visible), `${name}: focus without a visible ring`).toEqual([]);
  }
  return { ...m, focus };
}

async function isDevServer(page: Page): Promise<boolean> {
  const r = await page.request.get("/dev-style");
  return r.status() === 200;
}

// ─────────────────────────────── Part 1: public + dev fixtures ───────────────────────────────

test.describe("M11 public screens at 375 px", () => {
  test.use({ viewport: VIEWPORT, hasTouch: true, isMobile: true });
  test.setTimeout(120_000);

  const PUBLIC: Array<[string, string, string?]> = [
    ["landing", "/", "landing"],
    ["login", "/login", "login"],
    ["privacy", "/privacy"],
    ["terms", "/terms"],
    ["app not-found", "/this-route-does-not-exist-m11", "not-found"],
    ["/b not-found", "/b/zzzz-no-such-book-m11", "viewer-not-found"],
  ];
  for (const [name, url, shot] of PUBLIC) {
    test(`${name} (${url})`, async ({ page }) => {
      await page.goto(url);
      await audit(page, name, { shot });
    });
  }
});

test.describe("M11 dev fixtures at 375 px", () => {
  test.use({ viewport: VIEWPORT, hasTouch: true, isMobile: true });
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    test.skip(!(await isDevServer(page)), "dev-* fixtures 404 under next start — run this block on next dev");
    await page.addInitScript(() => {
      try {
        localStorage.setItem("pb.editor.coach.v1", "1");
      } catch {
        /* ignore */
      }
    });
  });

  test("dev-style (/dev-style)", async ({ page }) => {
    await page.goto("/dev-style");
    // The style board shows a real <PageHeader> sample, which renders its own h1 (dev-only page).
    await audit(page, "dev-style", { h1: { count: 2, why: "style board page h1 + the PageHeader sample's h1 (dev-only)" } });
  });

  const FIXTURES: Array<[string, string, string?]> = [
    ["dev-publish draft", "/dev-publish?state=draft", "publish-draft-fixture"],
    ["dev-publish live", "/dev-publish?state=live", "publish-live-fixture"],
    ["dev-upgrade paid", "/dev-upgrade?state=paid"],
    ["dev-upgrade polling", "/dev-upgrade?state=polling"],
  ];
  for (const [name, url, shot] of FIXTURES) {
    test(`${name} (${url})`, async ({ page }) => {
      await page.goto(url);
      await audit(page, name, { shot });
    });
  }

  test("dev-editor (/dev-editor)", async ({ page }) => {
    await page.goto("/dev-editor");
    await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
    await audit(page, "dev-editor");
  });

  test("dev-viewer (/dev-viewer)", async ({ page }) => {
    await page.goto("/dev-viewer");
    await expect(page.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await audit(page, "dev-viewer");
  });
});

// ─────────────────────────────── Part 2: live signed-in flow ───────────────────────────────

const BUCKETS = ["photos", "exports"] as const;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

test.describe("M11 signed-in flow at 375 px (live)", () => {
  test.skip(!LIVE, "set E2E_AUTH=1 to run the live signed-in M11 flow");

  let admin: SupabaseClient;
  let uid = "";
  let email = "";
  let bookId = "";
  let slug = "";
  let context: BrowserContext;
  let page: Page;
  const runIds = new Set<string>();

  async function signInHash(): Promise<string> {
    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
    return data.properties.hashed_token;
  }

  async function listAllUserObjects(bucket: string): Promise<string[]> {
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

  async function makeSynthetic(p: Page, n: number) {
    const list = await p.evaluate(async (count) => {
      function rng(seed: number) {
        let s = seed >>> 0;
        return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      }
      async function draw(seed: number): Promise<string> {
        const r = rng(seed * 7919 + 17);
        const c = document.createElement("canvas");
        c.width = 900;
        c.height = 1200;
        const g = c.getContext("2d")!;
        for (let y = 0; y < 12; y++) {
          for (let x = 0; x < 9; x++) {
            g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
            g.fillRect(x * 100, y * 100, 100, 100);
          }
        }
        const img = g.getImageData(0, 0, 900, 1200);
        for (let i = 0; i < img.data.length; i += 4) {
          const d = Math.floor((r() - 0.5) * 60);
          img.data[i] += d;
          img.data[i + 1] += d;
          img.data[i + 2] += d;
        }
        g.putImageData(img, 0, 0);
        return new Promise((resolve) =>
          c.toBlob(
            (blob) => {
              const fr = new FileReader();
              fr.onload = () => resolve(String(fr.result).split(",")[1]);
              fr.readAsDataURL(blob!);
            },
            "image/jpeg",
            0.92,
          ),
        );
      }
      const out: string[] = [];
      for (let i = 0; i < count; i++) out.push(await draw(i + 1101));
      return out;
    }, n);
    return list.map((b64, i) => ({ name: `m11-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
  }

  async function anon(browser: Browser, baseURL: string, url: string) {
    const ctx = await browser.newContext({ viewport: VIEWPORT, baseURL, hasTouch: true, isMobile: true });
    const v = await ctx.newPage();
    const res = await v.goto(url);
    return { ctx, v, status: res?.status() ?? 0 };
  }

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(120_000);
    admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    email = `e2e+m11-${randomBytes(6).toString("hex")}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
    uid = data.user.id;
    context = await browser.newContext({ viewport: VIEWPORT, baseURL: String(info.project.use.baseURL ?? ""), hasTouch: true, isMobile: true });
    await context.addInitScript(() => {
      try {
        localStorage.setItem("pb.editor.coach.v1", "1");
      } catch {
        /* ignore */
      }
    });
    page = await context.newPage();
    page.on("dialog", (d) => void d.accept());
    await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/dashboard`);
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test.afterAll(async () => {
    test.setTimeout(150_000);
    if (!uid) return;
    await context?.close().catch(() => {});
    const runs = await admin.from("agent_runs").select("id").eq("user_id", uid);
    for (const r of (runs.data ?? []) as { id: string }[]) runIds.add(r.id);
    let removed = 0;
    for (const bucket of BUCKETS) {
      const objs = await listAllUserObjects(bucket).catch(() => [] as string[]);
      for (let i = 0; i < objs.length; i += 100) {
        const res = await admin.storage.from(bucket).remove(objs.slice(i, i + 100));
        removed += res.data?.length ?? 0;
      }
    }
    await admin.from("orders").delete().eq("user_id", uid);
    await admin.from("exports").delete().eq("user_id", uid);
    const { error } = await admin.auth.admin.deleteUser(uid);
    let runsDeleted = 0;
    if (runIds.size) runsDeleted = (await admin.from("agent_runs").delete().in("id", [...runIds]).select("id")).data?.length ?? 0;
    let left = 0;
    for (const bucket of BUCKETS) left += (await listAllUserObjects(bucket).catch(() => [] as string[])).length;
    const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
    console.log(`[cleanup] objects removed=${removed} left=${left} books=${books.count} runsDeleted=${runsDeleted}/${runIds.size} userDeleted=${!error}`);
    expect(error).toBeNull();
    expect(left).toBe(0);
    expect(books.count ?? 0).toBe(0);
  });

  const stepA = async () => {
    await expect(page.getByTestId("dashboard-empty")).toBeVisible();
    await audit(page, "dashboard empty", { shot: "dashboard-empty" });
    await page.getByTestId("account-menu-button").click();
    await expect(page.getByTestId("account-menu")).toBeVisible();
    await expect(page.getByTestId("sign-out")).toBeVisible();
    await audit(page, "dashboard account menu open", { tab: false, shot: "account-menu" });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("account-menu")).toBeHidden();

    // "Choose style first" (/books/new) is kept; the main start is photos first (M13 T5).
    await page.goto("/books/new");
    await expect(page.getByTestId("create-book")).toBeVisible();
    await audit(page, "books/new", { shot: "new-book" });
    await page.goto("/books/start");
    await expect(page.getByTestId("start-pick")).toBeVisible();
    await audit(page, "books/start", { shot: "start" });
  };

  // Replay ticks take ~0 ms, so the build screen would jump straight to review. Every run API
  // response is held for STEP_DELAY ms (server work is already done) so each reported state
  // renders; both sides are timestamped so the checklist can be checked against what the
  // server had reported at that moment. M13 T6: the build starts by itself from the upload screen,
  // so the route is installed before the photos are picked, and the automatic start request is
  // held until step c releases it (step b audits the upload screen meanwhile).
  const STEP_DELAY = 1_500;
  const delivered: { t: number; state: string }[] = [];
  let releaseAuto: () => void = () => {};
  const autoHeld = new Promise<void>((resolve) => {
    releaseAuto = resolve;
  });

  const stepB = async () => {
    await page.route(/\/api\/ai\/runs(\/|\?|$)/, async (route) => {
      const req = route.request();
      if (req.method() === "POST" && /\/api\/ai\/runs$/.test(new URL(req.url()).pathname) && (req.postData() ?? "").includes('"auto":true')) {
        await autoHeld;
      }
      const res = await route.fetch();
      const body = await res.text();
      let state = "";
      try {
        const j = JSON.parse(body) as { state?: string; run?: { state?: string; id?: string }; id?: string; runId?: string };
        state = j.state ?? j.run?.state ?? "";
        const id = j.runId ?? j.run?.id ?? j.id;
        if (typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) runIds.add(id);
      } catch {
        /* not json */
      }
      await new Promise((r) => setTimeout(r, STEP_DELAY));
      try {
        await route.fulfill({ response: res, body });
      } catch {
        return; // the page already navigated away from this request
      }
      if (state) delivered.push({ t: Date.now(), state });
    });
    await page.getByTestId("start-pick-input").setInputFiles(await makeSynthetic(page, 6));
    await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
    bookId = new URL(page.url()).pathname.split("/")[2];
    // D-068: travel defaults to Geometric; this spec covers Modern.
    await page.locator("label", { has: page.getByTestId("setup-occasion-travel") }).click();
    await page.getByTestId("setup-change").click();
    await page.locator("label", { has: page.getByTestId("setup-style-modern") }).click();
    await expect(page.getByTestId("setup-status")).toHaveText("Saved", { timeout: 15_000 });
    await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId("upload-auto-starting")).toBeVisible();
    await audit(page, "upload summary (starting)", { shot: "upload-summary" });
  };

  const stepC = async () => {
    // Record every checklist state the page renders (client navigation keeps this document alive
    // from upload → build → review).
    await page.evaluate(() => {
      const w = window as unknown as { __m11Steps: { t: number; s: string }[] };
      w.__m11Steps = [];
      const snap = () => {
        const items = Array.from(document.querySelectorAll('[data-testid^="build-step-"]'));
        if (!items.length) return;
        const s = items.map((i) => `${i.getAttribute("data-testid")!.slice(11)}=${i.getAttribute("data-state")}`).join(",");
        if (w.__m11Steps[w.__m11Steps.length - 1]?.s !== s) w.__m11Steps.push({ t: Date.now(), s });
      };
      new MutationObserver(snap).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
    });
    // The one automatic first build of this run (a replay run), released from the hold.
    releaseAuto();
    await page.waitForURL(/\/build\?auto=1$/, { timeout: 60_000 });
    await expect(page.getByTestId("build-checklist")).toBeVisible({ timeout: 30_000 });
    await audit(page, "build", { tab: false, shot: "build" });
    await page.waitForURL(/\/review$/, { timeout: 420_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const steps = await page.evaluate(() => (window as unknown as { __m11Steps?: { t: number; s: string }[] }).__m11Steps ?? []);
    console.log(`[build] server states delivered: ${delivered.map((d) => d.state).join(">")}`);
    console.log(`[build] checklist: ${steps.map((x) => x.s.replace(/=(\w)\w+/g, "=$1")).join(" | ")}`);

    const ORDER = ["queued", "curating", "storytelling", "captioning", "critiquing", "repairing", "validating", "done"];
    const COVERS: Record<string, string[]> = {
      photos: ["curating"],
      moments: ["storytelling"],
      captions: ["captioning"],
      check: ["critiquing", "repairing", "validating"],
    };
    const rankOf = (st: string) => ORDER.indexOf(st);
    const order = { todo: 0, current: 1, done: 2 } as Record<string, number>;
    const last: Record<string, number> = {};
    let progressed = 0;
    for (const snap of steps) {
      // What the server had told the page when this checklist rendered (+ small render slack).
      const known = delivered.filter((d) => d.t <= snap.t + 50).map((d) => rankOf(d.state));
      const r = known.length ? Math.max(...known) : -1;
      for (const part of snap.s.split(",")) {
        const [id, st] = part.split("=");
        expect.soft(order[st], `step ${id} went backwards (${st})`).toBeGreaterThanOrEqual(last[id] ?? 0);
        last[id] = order[st];
        const lastCovered = Math.max(...COVERS[id].map(rankOf));
        if (st === "done") expect.soft(r, `step ${id} ticked before the server reported a later state`).toBeGreaterThan(lastCovered);
        if (st === "current") expect.soft(COVERS[id].map(rankOf), `step ${id} current without the server in that state`).toContain(r);
        if (st !== "todo") progressed++;
      }
    }
    expect.soft(steps.length, "checklist rendered more than its first state").toBeGreaterThan(1);
    expect.soft(progressed, "checklist showed progress").toBeGreaterThan(0);
    await expect(page.getByTestId("review-continue")).toBeVisible({ timeout: 30_000 });
    await audit(page, "review", { shot: "review" });
  };

  const stepD = async () => {
    await page.getByTestId("review-continue").click();
    await page.waitForURL(new RegExp(`/books/${bookId}/edit$`), { timeout: 30_000 });
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await page.waitForTimeout(800);
    await audit(page, "editor", { shot: "editor" });
  };

  const stepE = async () => {
    // M13 T9: editor Share publishes and opens the share screen (no separate draft step).
    await page.getByTestId("editor-done").click();
    await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`), { timeout: 30_000 });
    const wa = page.getByTestId("share-whatsapp").first();
    await expect(wa).toBeVisible();
    const bg = await wa.evaluate((e) => getComputedStyle(e).backgroundColor);
    console.log(`[publish] whatsapp bg=${bg}`);
    expect(bg).toBe("rgb(15, 122, 64)");
    await audit(page, "publish live", { shot: "publish-live" });
    const { data } = await admin.from("books").select("slug").eq("id", bookId).single();
    slug = (data as { slug: string | null } | null)?.slug ?? "";
    expect(slug).not.toBe("");
  };

  const stepF = async (browser: Browser, baseURL: string) => {
    {
      const { ctx, v, status } = await anon(browser, baseURL, `/b/${slug}`);
      expect(status).toBe(200);
      await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
      await audit(v, "/b viewer", { shot: "viewer" });
      await ctx.close();
    }
    // Password via the owner's publish screen (needs BOOK_ACCESS_SECRET on the server).
    await page.getByTestId("password-edit").click();
    await page.getByTestId("password-input").fill("m11-gate-password");
    await page.getByTestId("password-save").click();
    await expect(page.getByTestId("password-status")).toContainText("On", { timeout: 15_000 });
    {
      const { ctx, v } = await anon(browser, baseURL, `/b/${slug}`);
      await expect(v.getByTestId("password-gate")).toBeVisible();
      await audit(v, "/b password gate", { shot: "viewer-password" });
      await ctx.close();
    }
    await admin.from("books").update({ password_hash: null }).eq("id", bookId);
    // Expired: the free link's expiry moved into the past (service role; the column guard allows it).
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect((await admin.from("books").update({ expires_at: past }).eq("id", bookId)).error).toBeNull();
    {
      const { ctx, v } = await anon(browser, baseURL, `/b/${slug}`);
      await audit(v, "/b expired", { shot: "viewer-expired" });
      await ctx.close();
    }
    // Unavailable: a live snapshot that fails the strict public schema.
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect((await admin.from("books").update({ expires_at: future, published_doc: { broken: true } }).eq("id", bookId)).error).toBeNull();
    {
      const { ctx, v, status } = await anon(browser, baseURL, `/b/${slug}`);
      console.log(`[unavailable] status=${status}`);
      await audit(v, "/b unavailable", { shot: "viewer-unavailable" });
      await ctx.close();
    }
  };

  const stepG = async () => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("book-card")).toHaveCount(1);
    await audit(page, "dashboard with book", { shot: "dashboard" });
    await page.goto("/settings");
    await audit(page, "settings", { shot: "settings" });
    await page.getByTestId("account-menu-button").click();
    await expect(page.getByTestId("account-menu")).toBeVisible();
    await audit(page, "settings account menu open", { tab: false });
    await page.getByTestId("sign-out").click();
    await page.waitForURL((u) => !/\/settings$/.test(u.pathname), { timeout: 30_000 });
    const res = await page.request.get("/dashboard", { maxRedirects: 0 });
    console.log(`[signout] landed=${new URL(page.url()).pathname} dashboard status=${res.status()}`);
    expect([302, 303, 307, 308]).toContain(res.status());
  };
  // One test with steps: a soft failure on one screen must not skip the rest of the flow.
  test("dashboard → new → upload → build → review → edit → publish → /b states → settings → sign out", async ({ browser }, info) => {
    test.setTimeout(1_200_000);
    const baseURL = String(info.project.use.baseURL ?? "");
    await test.step("a. dashboard (empty) + account menu open + new book form + photos-first start", stepA);
    await test.step("b. choose 6 photos → upload screen (setup card) → summary, auto start held", stepB);
    await test.step("c. AI build (replay): checklist only ticks as the server reports states → review", stepC);
    await test.step("d. editor", stepD);
    await test.step("e. publish draft → live (WhatsApp green)", stepE);
    await test.step("f. /b viewer, password gate, expired, unavailable", () => stepF(browser, baseURL));
    await test.step("g. dashboard with a book, settings, sign out from the account menu", stepG);
  });
});
