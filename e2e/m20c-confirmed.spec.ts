/**
 * Milestone 20c — a generated book never reopens the wizard's Review (books.album_confirmed_at,
 * migration 20261115002000).
 *
 * LIVE only (E2E_AUTH=1, hosted Supabase; server: next start with AI_MODE=off or AI_MODE=replay, empty
 * ANTHROPIC_API_KEY, dummy Stripe / CRON, NEXT_PUBLIC_APP_URL = its own origin). ONE throwaway user
 * `e2e+m20c-<random>@example.com` (admin createUser + generateLink, no email). Serial, 375 px:
 *   a. wizard create → 6 photos → step 7 → Generate → editor; books.album_confirmed_at set (recent).
 *   c. /books/new?book=<id>&step=1..7 → the editor (HTTP: one redirect, no loop; browser: 7, 5, 2).
 *   d. dashboard: the card + Open link → /books/<id>/edit (never a wizard href); clicking opens the editor.
 *   e. /books/<id>/upload ("add more photos") renders the classic upload page (no wizard, no redirect).
 *   f. /books/<id>/build?trigger=rebuild stays classic, finishes in the editor; the marker stays set
 *      and step 7 still → editor afterwards.
 *   g. (last, book 2 in a fresh tab) browser Back from the editor: the Review step is never shown (a
 *      sessionStorage recorder that survives document loads), every entry of the book ends on the
 *      editor (no loop, nothing stuck), and Back leaves the book within ≤ 6 presses (CDP history).
 * afterAll (always): storage under `<uid>/`, the user (books/photos cascade), then the agent_runs this
 * user created (ids captured first). Logs: counts / paths only.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createBookViaWizard, waitForReview, generateAlbum } from "./helpers/create-book";

const LIVE = process.env.E2E_AUTH === "1";
if (LIVE && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const PHONE = { width: 375, height: 812 };
const BUCKETS = ["photos", "exports"];
const SEEN_KEY = "__m20c_seen";
const ARM_KEY = "__m20c_arm";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

test.describe("m20c confirmed book (live)", () => {
  test.skip(!LIVE, "set E2E_AUTH=1 to run the live M20c checks");
  test.describe.configure({ mode: "serial" });

  let admin: SupabaseClient;
  let baseURL = "";
  let uid = "";
  let email = "";
  let bookId = "";
  let book2 = "";
  let confirmedAt = "";
  const runIds = new Set<string>();
  let context: BrowserContext;
  let page: Page;

  const editorPath = () => `/books/${bookId}/edit`;
  const short = (u: string) => u.replace(baseURL, "").replace(/[0-9a-f-]{36}/g, ":id");

  async function confirmedOf(id: string): Promise<string | null> {
    const { data, error } = await admin.from("books").select("album_confirmed_at").eq("id", id).single();
    if (error) throw new Error(`books select failed (${error.code})`);
    return (data as { album_confirmed_at: string | null }).album_confirmed_at;
  }

  async function runsOf(id: string) {
    const { data, error } = await admin.from("agent_runs").select("id, state, trigger, mode").eq("book_id", id);
    if (error) throw new Error(`agent_runs select failed (${error.code})`);
    for (const r of data ?? []) runIds.add((r as { id: string }).id);
    return (data ?? []) as { id: string; state: string; trigger: string; mode: string }[];
  }

  async function listUserObjects(bucket: string): Promise<string[]> {
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

  async function seen(p: Page = page): Promise<string[]> {
    return p.evaluate((k) => JSON.parse(sessionStorage.getItem(k) ?? "[]") as string[], SEEN_KEY).catch(() => []);
  }

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(120_000);
    baseURL = String(info.project.use.baseURL ?? "");
    admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    email = `e2e+m20c-${randomBytes(6).toString("hex")}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
    uid = data.user.id;
    context = await browser.newContext({ viewport: PHONE, baseURL, locale: "en-US", hasTouch: true, isMobile: true });
    await context.addInitScript(
      ({ seenKey, armKey }) => {
        try {
          localStorage.setItem("pb.editor.coach.v1", "1");
        } catch {
          /* ignore */
        }
        // Once armed (after Generate), record every time a wizard step / the Review shows up, per
        // document, in sessionStorage (survives location.replace / reloads in this tab).
        const record = () => {
          try {
            if (sessionStorage.getItem(armKey) !== "1") return;
            const w = document.querySelector('[data-testid="new-book-wizard"]');
            const review = document.querySelector('[data-testid="wizard-step-review"]');
            if (!w && !review) return;
            const entry = `${review ? "review" : `wizard-step-${w?.getAttribute("data-step") ?? "?"}`} @ ${location.pathname}${location.search}`;
            const list = JSON.parse(sessionStorage.getItem(seenKey) ?? "[]") as string[];
            if (list[list.length - 1] !== entry) {
              list.push(entry);
              sessionStorage.setItem(seenKey, JSON.stringify(list));
            }
          } catch {
            /* ignore */
          }
        };
        const start = () => {
          new MutationObserver(record).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-step"] });
          record();
        };
        if (document.documentElement) start();
        else document.addEventListener("DOMContentLoaded", start);
      },
      { seenKey: SEEN_KEY, armKey: ARM_KEY },
    );
    page = await context.newPage();
    page.on("dialog", (d) => void d.accept());
    const { data: link, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (le || !link.properties?.hashed_token) throw new Error(`generateLink failed (${le?.code ?? "no token"})`);
    await page.goto(`/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/dashboard`);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    if (!uid) return;
    await context?.close().catch(() => {});
    for (const r of (await admin.from("agent_runs").select("id").eq("user_id", uid)).data ?? []) runIds.add((r as { id: string }).id);
    if (book2) for (const r of (await admin.from("agent_runs").select("id").eq("book_id", book2)).data ?? []) runIds.add((r as { id: string }).id);
    if (bookId) for (const r of (await admin.from("agent_runs").select("id").eq("book_id", bookId)).data ?? []) runIds.add((r as { id: string }).id);
    let removed = 0;
    for (const bucket of BUCKETS) {
      for (let round = 0; round < 3; round++) {
        const paths = await listUserObjects(bucket).catch(() => [] as string[]);
        if (paths.length === 0) break;
        for (let i = 0; i < paths.length; i += 100) await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
        removed += paths.length;
      }
    }
    for (const b of [bookId, book2]) if (b) await admin.from("exports").delete().eq("book_id", b);
    await admin.from("orders").delete().eq("user_id", uid);
    const { error } = await admin.auth.admin.deleteUser(uid);
    let left = 0;
    for (const bucket of BUCKETS) left += (await listUserObjects(bucket).catch(() => [] as string[])).length;
    const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
    const ids = [...runIds];
    let runsDeleted = 0;
    let runsLeft = 0;
    if (ids.length) {
      runsDeleted = (await admin.from("agent_runs").delete().in("id", ids).select("id")).data?.length ?? 0;
      runsLeft = (await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", ids)).count ?? 0;
    }
    console.log(
      `[cleanup] objects removed=${removed} left=${left} books=${books.count} runsFound=${ids.length} runsDeleted=${runsDeleted} runsLeft=${runsLeft} userDeleted=${!error}`,
    );
    expect(error).toBeNull();
    expect(left).toBe(0);
    expect(books.count ?? 0).toBe(0);
    expect(runsLeft).toBe(0);
  });

  test("a. Generate album → editor; books.album_confirmed_at is set", async () => {
    test.setTimeout(600_000);
    bookId = await createBookViaWizard(page, { title: "Confirmed album", occasion: "family", format: "A5_PORTRAIT" });
    expect(await confirmedOf(bookId)).toBeNull();
    await expect(page.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, 6, 2000));
    await waitForReview(page, bookId);
    expect(await confirmedOf(bookId)).toBeNull(); // only Generate marks it
    const t0 = Date.now();
    await generateAlbum(page, bookId);
    await page.evaluate((k) => sessionStorage.setItem(k, "1"), ARM_KEY);
    const at = await confirmedOf(bookId);
    console.log(`[a] album_confirmed_at set=${at !== null} runs=${(await runsOf(bookId)).map((r) => `${r.mode}:${r.trigger}:${r.state}`).join(",")}`);
    expect(at).not.toBeNull();
    expect(Math.abs(new Date(at!).getTime() - t0)).toBeLessThan(5 * 60_000);
    confirmedAt = at!;
  });

  test("c. /books/new?book=<id>&step=1..7 → the editor (HTTP no loop; browser 7, 5, 2)", async () => {
    test.setTimeout(240_000);
    test.skip(!confirmedAt, "needs the confirmed book");
    const req = page.context().request;
    for (const step of [1, 2, 3, 4, 5, 6, 7]) {
      const r = await redirectOf(req, `/books/new?book=${bookId}&step=${step}`);
      console.log(`[c] step=${step} → ${r.status}${r.streamed ? "(streamed)" : ""} ${short(String(r.to))}`);
      expect(r.to, `step ${step} redirects to the editor`).toBe(editorPath());
      const e = await redirectOf(req, r.to!);
      expect(e).toMatchObject({ status: 200, to: null });
    }
    for (const step of [7, 5, 2]) {
      await page.goto(`/books/new?book=${bookId}&step=${step}`);
      await page.waitForURL((u) => u.pathname === editorPath(), { timeout: 30_000 });
      await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
    }
    const s = await seen();
    console.log(`[c] wizard seen: ${JSON.stringify(s.map(short))}`);
    expect(s.filter((e) => e.startsWith("review"))).toEqual([]);
  });

  test("d. dashboard: card + Open → /books/<id>/edit", async () => {
    test.setTimeout(120_000);
    test.skip(!confirmedAt, "needs the confirmed book");
    await page.goto("/dashboard");
    const card = page.getByTestId("book-card").filter({ hasText: "Confirmed album" });
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    expect(await card.getAttribute("href")).toBe(editorPath());
    const opens = await page.locator(`[data-testid="book-open"]`).evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    console.log(`[d] card=${short(String(await card.getAttribute("href")))} open=${JSON.stringify(opens.map((h) => short(String(h))))}`);
    expect(opens.length).toBeGreaterThan(0);
    for (const h of opens) expect(h).toBe(editorPath());
    expect(await page.locator(`a[href*="/books/new?book=${bookId}"]`).count()).toBe(0);
    await card.click();
    await page.waitForURL((u) => u.pathname === editorPath(), { timeout: 30_000 });
    await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
  });

  test("e. /books/<id>/upload (add more photos) renders the classic upload page", async () => {
    test.setTimeout(120_000);
    test.skip(!confirmedAt, "needs the confirmed book");
    const req = page.context().request;
    expect(await redirectOf(req, `/books/${bookId}/upload`)).toMatchObject({ status: 200, to: null });
    await page.goto(`/books/${bookId}/upload`);
    await expect(page.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    expect(new URL(page.url()).pathname).toBe(`/books/${bookId}/upload`);
    await expect(page.getByTestId("new-book-wizard")).toHaveCount(0);
    await expect(page.getByTestId("wizard-shell")).toHaveCount(0);
  });

  test("f. ?trigger=rebuild stays classic → editor; marker kept; step 7 still → editor", async () => {
    test.setTimeout(420_000);
    test.skip(!confirmedAt, "needs the confirmed book");
    const req = page.context().request;
    expect(await redirectOf(req, `/books/${bookId}/build?trigger=rebuild`)).toMatchObject({ status: 200, to: null });
    await page.goto(`/books/${bookId}/build?trigger=rebuild`);
    await expect(page.getByTestId("build-progress")).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe(`/books/${bookId}/build`);
    await expect(page.getByTestId("new-book-wizard")).toHaveCount(0);
    await expect(page.getByTestId("wizard-shell")).toHaveCount(0);
    await expect(page.getByTestId("build-progress")).not.toHaveAttribute("data-variant", "wizard");
    await page.waitForURL((u) => u.pathname === editorPath(), { timeout: 300_000 });
    await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
    const runs = await runsOf(bookId);
    console.log(`[f] runs=${runs.map((r) => `${r.mode}:${r.trigger}:${r.state}`).join(",")}`);
    expect(runs.some((r) => r.trigger === "rebuild")).toBe(true);
    expect(await confirmedOf(bookId)).toBe(confirmedAt);
    const r = await redirectOf(req, `/books/new?book=${bookId}&step=7`);
    expect(r.to).toBe(editorPath());
    const s = await seen();
    expect(s.filter((e) => e.startsWith("review"))).toEqual([]);
  });

  test("g. browser Back from the editor never shows Review; ends on the editor; leaves within a few Backs (book 2, fresh tab)", async () => {
    test.setTimeout(600_000);
    // Last test (a failure here doesn't skip c–f): its own book + tab so the history is exactly
    // dashboard → wizard 1–7 → editor.
    const page = await context.newPage();
    page.on("dialog", (d) => void d.accept());
    await page.goto("/dashboard");
    const bookId = await createBookViaWizard(page, { title: "Back album", occasion: "travel", format: "A5_PORTRAIT" });
    book2 = bookId;
    const editorPath = () => `/books/${bookId}/edit`;
    await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, 6, 3000));
    await waitForReview(page, bookId);
    await generateAlbum(page, bookId);
    await page.evaluate((k) => sessionStorage.setItem(k, "1"), ARM_KEY);
    expect(await confirmedOf(bookId)).not.toBeNull();
    expect(new URL(page.url()).pathname).toBe(editorPath());
    // The tab's real history (CDP): entries + current index, so "no more history" is exact.
    const cdp = await context.newCDPSession(page);
    const history = async () =>
      (await cdp.send("Page.getNavigationHistory")) as { currentIndex: number; entries: { url: string }[] };
    const h0 = await history();
    console.log(`[g] history at the editor: index=${h0.currentIndex} ${h0.entries.map((e) => short(e.url)).join(" | ")}`);
    const chain: string[] = [];
    const stuck: string[] = [];
    let backs = 0;
    let leftTo = "";
    for (let i = 0; i < 14; i++) {
      if ((await history()).currentIndex === 0) break;
      await page.goBack({ waitUntil: "commit", timeout: 30_000 }).catch(() => null);
      backs++;
      // Let a stale wizard entry leave (location.replace / server redirect) before reading the URL.
      await page.waitForTimeout(1_500);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      const u = new URL(page.url());
      const ofBook = u.pathname.startsWith(`/books/${bookId}`) || u.searchParams.get("book") === bookId;
      if (ofBook && u.pathname !== editorPath()) {
        await page.waitForURL((x) => x.pathname === editorPath(), { timeout: 20_000 }).catch(() => {});
      }
      const settled = new URL(page.url());
      const hi = (await history()).currentIndex;
      chain.push(`#${hi} ${short(u.pathname + u.search)} ⇒ ${short(settled.pathname + settled.search)}`);
      if (settled.pathname === editorPath()) {
        await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
        continue;
      }
      const body = (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80);
      if (settled.searchParams.get("book") === bookId || settled.pathname.startsWith(`/books/${bookId}`)) {
        // An entry of this book that is not the editor 20 s after Back.
        stuck.push(`Back ${backs}: ${short(settled.pathname + settled.search)} shows "${body}"`);
        continue;
      }
      leftTo = `${short(settled.pathname + settled.search)} ("${body.slice(0, 50)}")`;
      break;
    }
    const s = await seen(page);
    console.log(`[g] backs=${backs} leftTo=${leftTo || "-"} chain: ${chain.join(" | ")}`);
    console.log(`[g] wizard seen after Generate: ${JSON.stringify(s.map(short))}`);
    console.log(`[g] stuck (book entry not on the editor 20 s after Back): ${JSON.stringify(stuck)}`);
    expect(s.filter((e) => e.startsWith("review")), "Review never shown after Generate").toEqual([]);
    expect(s.filter((e) => e.includes(`book=${bookId}`)), "no wizard step of this book shown after Generate").toEqual([]);
    expect(stuck, "every Back into an entry of this book ends on the editor").toEqual([]);
    expect(leftTo, "Back leaves the book").not.toBe("");
    expect(backs, "Backs to leave the book").toBeLessThanOrEqual(6);
  });
});

async function redirectOf(req: APIRequestContext, url: string): Promise<{ status: number; to: string | null; streamed: boolean }> {
  const r = await req.get(url, { maxRedirects: 0 });
  const loc = r.headers()["location"];
  if (r.status() >= 300 && r.status() < 400) return { status: r.status(), to: loc ?? null, streamed: false };
  const html = await r.text();
  const meta = /http-equiv="refresh" content="\d+;\s*url=([^"]+)"/i.exec(html)?.[1];
  const digest = /NEXT_REDIRECT;(?:replace|push);([^;"\\]+);/.exec(html)?.[1];
  const to = meta ? meta.replace(/&amp;/g, "&") : digest ?? null;
  return { status: r.status(), to, streamed: to !== null };
}

async function makeSynthetic(p: Page, n: number, seedBase: number) {
  const list = await p.evaluate(
    async ({ count, seedBase }) => {
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
      for (let i = 0; i < count; i++) out.push(await draw(seedBase + i));
      return out;
    },
    { count: n, seedBase },
  );
  return list.map((b64, i) => ({ name: `m20c-${seedBase + i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}
