import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getLayout } from "../src/lib/layouts";
import { createBookViaWizard, finishWizardToEditor, waitForSortingOrReview } from "./helpers/create-book";

// M29 T7 — editor "Cover style" tool.
// 1. /dev-editor fixture (dev server only; skips under `next start`): open the tool on the cover,
//    pick a different style, the big cover changes, the stub save runs the REAL save validator
//    (?bg=1 → window.__devEditorLastSave = what PUT /api/books/[id]/doc would store), one undo
//    restores it; 375 px without horizontal scroll, and desktop.
// 2. Live (opt-in E2E_AUTH=1, hosted Supabase, like e2e/editor-auth.spec.ts): build a classic
//    portrait book through the wizard, pick an M29 cover style, Saved ✓ → books.doc has it (v2),
//    undo saves the old one, pick again, reload → the style is still there and marked current.
//    Server: AI_MODE=off (or replay without ANTHROPIC_API_KEY) — never calls Anthropic. Throwaway
//    user `e2e+m29-<random>@example.com`, removed with its storage in afterAll. Logs are counts only.

const cur = (page: Page) => page.locator('[data-testid="carousel-item"][aria-hidden="false"]');
const bigCover = (page: Page) => cur(page).locator('[data-page="cover"]').first();
const options = (page: Page) => page.getByTestId("cover-style-option");
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function openCoverStyle(page: Page) {
  await expect(page.getByTestId("page-counter")).toContainText("Cover");
  await page.getByTestId("editor-tool-cover-style").click();
  await expect(page.getByTestId("cover-style-picker")).toBeVisible();
}

/** The first option that isn't current (optionally: an M29 id, i.e. not in `old`). */
async function pickOther(page: Page, skip: (id: string) => boolean = () => false): Promise<string> {
  const n = await options(page).count();
  for (let i = 0; i < n; i++) {
    const o = options(page).nth(i);
    const id = (await o.getAttribute("data-layout-id")) ?? "";
    if ((await o.getAttribute("aria-pressed")) !== "true" && !skip(id)) {
      await o.click();
      return id;
    }
  }
  throw new Error("no other cover style");
}

test.describe("Cover style on /dev-editor", () => {
  const errors: string[] = [];
  test.beforeAll(async ({ request }) => {
    const res = await request.get("/dev-editor");
    test.skip(res.status() === 404, "/dev-editor is dev-only (404 under next start)");
  });
  test.beforeEach(async ({ page }) => {
    errors.length = 0;
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const st = document.createElement("style");
        st.textContent = "nextjs-portal{display:none!important}";
        document.head.appendChild(st);
      });
    });
  });
  test.afterEach(() => expect(errors, "no page errors").toEqual([]));

  for (const vp of [
    { name: "375 px", viewport: { width: 375, height: 812 }, mobile: true },
    { name: "desktop", viewport: { width: 1280, height: 800 }, mobile: false },
  ]) {
    test.describe(vp.name, () => {
      test.use({ viewport: vp.viewport, hasTouch: vp.mobile, isMobile: vp.mobile });

      test("pick a style → cover changes + saved through the real validator; one undo restores it", async ({ page }) => {
        await page.goto("/dev-editor?bg=1");
        await expect(page.getByTestId("editor-shell")).toBeVisible();
        const before = await bigCover(page).getAttribute("data-layout");
        expect(before).toBeTruthy();
        const title = (await bigCover(page).getByTestId("cover-title").innerText()).trim();

        await openCoverStyle(page);
        const n = await options(page).count();
        expect(n).toBeGreaterThan(1);
        await expect(page.locator('[data-testid="cover-style-option"][aria-pressed="true"]')).toHaveAttribute("data-layout-id", before!);
        // Each option is a live thumbnail of THIS book (its title).
        await expect(options(page).first()).toContainText(title);
        for (let i = 0; i < n; i++) {
          const b = (await options(page).nth(i).boundingBox())!;
          expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
        }
        expect(await overflow(page)).toBeLessThanOrEqual(0);

        const picked = await pickOther(page);
        await expect(bigCover(page)).toHaveAttribute("data-layout", picked);
        await expect(bigCover(page)).toContainText(title);
        await expect(page.locator('[data-testid="cover-style-option"][aria-pressed="true"]')).toHaveAttribute("data-layout-id", picked);
        await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
        const stored = () =>
          page.evaluate(() => (window as { __devEditorLastSave?: { stored: { cover: { layout: string } } } }).__devEditorLastSave?.stored.cover.layout);
        expect(await stored()).toBe(picked);
        expect(await overflow(page)).toBeLessThanOrEqual(0);

        // One undo step back to the old cover (and saved again).
        await page.getByTestId("editor-undo").click();
        await expect(bigCover(page)).toHaveAttribute("data-layout", before!);
        await expect(page.getByTestId("editor-undo")).toBeDisabled();
        await expect.poll(stored, { timeout: 10_000 }).toBe(before);
      });
    });
  }

  test("read-only: no Cover style tool", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/dev-editor?state=readOnly");
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await expect(page.getByTestId("page-counter")).toContainText("Cover");
    await expect(page.getByTestId("editor-tool-cover-style")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Live (E2E_AUTH=1)
// ---------------------------------------------------------------------------------------------

const LIVE = process.env.E2E_AUTH === "1";
if (LIVE && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

test.describe("Cover style persists (live, E2E_AUTH=1)", () => {
  test.skip(!LIVE, "set E2E_AUTH=1 to run the live signed-in cover style flow");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(600_000);
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  const BUCKET = "photos";
  let admin: SupabaseClient;
  let uid = "";

  async function userObjects(): Promise<string[]> {
    const out: string[] = [];
    const top = await admin.storage.from(BUCKET).list(uid, { limit: 1000 });
    for (const e of top.data ?? []) {
      if (e.id) out.push(`${uid}/${e.name}`);
      else for (const o of (await admin.storage.from(BUCKET).list(`${uid}/${e.name}`, { limit: 1000 })).data ?? []) out.push(`${uid}/${e.name}/${o.name}`);
    }
    return out;
  }

  test.afterAll(async () => {
    if (!uid) return;
    for (let round = 0; round < 3; round++) {
      const paths = await userObjects();
      if (!paths.length) break;
      for (let i = 0; i < paths.length; i += 100) await admin.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    }
    const { error } = await admin.auth.admin.deleteUser(uid);
    const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
    console.log(`[cleanup] left=${(await userObjects()).length} books=${books.count} userDeleted=${!error}`);
    expect(error).toBeNull();
    expect(books.count).toBe(0);
  });

  test("classic portrait: pick an M29 style → saved (v2) → undo → pick → reload keeps it", async ({ browser }, info) => {
    admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = `e2e+m29-${randomBytes(6).toString("hex")}@example.com`;
    const created = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`createUser failed (${created.error?.code ?? "no user"})`);
    uid = created.data.user.id;
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (link.error || !link.data.properties?.hashed_token) throw new Error("generateLink failed");

    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: String(info.project.use.baseURL ?? ""), hasTouch: true, isMobile: true });
    const page = await context.newPage();
    page.on("dialog", (d) => void d.accept());
    await page.goto(`/auth/confirm?token_hash=${link.data.properties.hashed_token}&type=magiclink&next=/books/new`);
    await expect(page).toHaveURL(/\/books\/new(\?step=1)?$/);

    const bookId = await createBookViaWizard(page, { occasion: "family", format: "A5_PORTRAIT", style: "classic", goto: false });
    await page.getByTestId("upload-input").setInputFiles(await synthetic(page, 6));
    await waitForSortingOrReview(page, bookId, 180_000);
    await finishWizardToEditor(page, bookId, { timeout: 420_000 });
    await expect(page.getByTestId("editor-shell")).toBeVisible();

    const row = async () => {
      const { data, error } = await admin.from("books").select("doc").eq("id", bookId).single();
      if (error) throw new Error(`books select failed (${error.code})`);
      return data.doc as { version: number; cover: { layout: string; photoId: string | null; title: string } };
    };
    const original = await row();
    const before = original.cover.layout;

    await openCoverStyle(page);
    // An M29 style (autoPick: false — never one the build could have picked).
    const picked = await pickOther(page, (id) => getLayout(id)?.autoPick !== false);
    await expect(bigCover(page)).toHaveAttribute("data-layout", picked);
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
    await expect.poll(async () => (await row()).cover.layout, { timeout: 10_000 }).toBe(picked);
    const saved = await row();
    expect(saved.cover.photoId).toBe(original.cover.photoId);
    expect(saved.cover.title).toBe(original.cover.title);
    expect(saved.version).toBe(2);

    await page.getByTestId("editor-undo").click();
    await expect(bigCover(page)).toHaveAttribute("data-layout", before);
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
    await expect.poll(async () => (await row()).cover.layout, { timeout: 10_000 }).toBe(before);

    await page.getByTestId(`cover-style-option`).and(page.locator(`[data-layout-id="${picked}"]`)).click();
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
    await expect.poll(async () => (await row()).cover.layout, { timeout: 10_000 }).toBe(picked);

    await page.reload();
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await expect(bigCover(page)).toHaveAttribute("data-layout", picked);
    await openCoverStyle(page);
    await expect(page.locator('[data-testid="cover-style-option"][aria-pressed="true"]')).toHaveAttribute("data-layout-id", picked);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await context.close();
  });
});

/** `n` distinct, sharp JPEGs drawn in the browser (same recipe as editor-auth.spec.ts). */
async function synthetic(p: Page, n: number) {
  const list = await p.evaluate(async (count) => {
    const out: string[] = [];
    for (let k = 0; k < count; k++) {
      let s = ((k + 301) * 7919 + 17) >>> 0;
      const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const c = document.createElement("canvas");
      c.width = 900;
      c.height = 1200;
      const g = c.getContext("2d")!;
      for (let y = 0; y < 12; y++)
        for (let x = 0; x < 9; x++) {
          g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
          g.fillRect(x * 100, y * 100, 100, 100);
        }
      const img = g.getImageData(0, 0, 900, 1200);
      for (let i = 0; i < img.data.length; i += 4) {
        const d = Math.floor((r() - 0.5) * 60);
        img.data[i] += d;
        img.data[i + 1] += d;
        img.data[i + 2] += d;
      }
      g.putImageData(img, 0, 0);
      out.push(
        await new Promise<string>((resolve) =>
          c.toBlob((b) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(",")[1]);
            fr.readAsDataURL(b!);
          }, "image/jpeg", 0.92),
        ),
      );
    }
    return out;
  }, n);
  return list.map((b64, i) => ({ name: `cover-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}
