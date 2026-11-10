/**
 * Milestone 9 T6/T10 — delete a book from the dashboard, toggle email reminders, delete the account,
 * against the LIVE hosted Supabase project (opt-in, 375 px).
 *
 * SKIPPED unless E2E_AUTH=1. Creates ONE throwaway user `e2e+m9del-<random>@example.com`, signs in via
 * an admin generateLink token_hash (no email), seeds two books with the admin client (one with a
 * Storage object under `<uid>/<book>/`), deletes one via the card menu, then deletes the account in
 * Settings. afterAll (always) removes any leftover objects and the user. Per-test timeouts only.
 * Logs are counts / booleans only.
 *
 * Preconditions (tests skip with a message instead of failing): migrations 1600 (profiles.email_reminders,
 * books.draft_warning_sent_at) and 1700 (delete_book_guarded) applied on the live project.
 *
 * Example:
 *   (production build in a scratch copy) next start -p 3531
 *   E2E_AUTH=1 npx playwright test -c <config with baseURL :3531, no webServer> e2e/delete.spec.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live delete flow");

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const VIEWPORT = { width: 375, height: 812 };
const BUCKETS = ["photos", "exports"] as const;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let admin: SupabaseClient;
let uid = "";
let email = "";
let migrationsReady = false;
let keepBookId = "";
let deleteBookId = "";

async function objectsUnder(bucket: string, prefix: string): Promise<string[]> {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  return (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
}

async function signIn(page: Page, next: string) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
  await page.goto(`/auth/confirm?token_hash=${data.properties.hashed_token}&type=magiclink&next=${encodeURIComponent(next)}`);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (!ENABLED) return;
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // 1700 probe: a random book → 'not_found'; 1600 probe: select the new columns.
  const probe = await admin.rpc("delete_book_guarded", { p_book: randomUUID(), p_user: randomUUID() });
  const cols = await admin.from("books").select("draft_warning_sent_at").limit(1);
  const prof = await admin.from("profiles").select("email_reminders").limit(1);
  migrationsReady = !probe.error && probe.data === "not_found" && !cols.error && !prof.error;
  console.log(`[e] migrations 1600+1700 ready=${migrationsReady}`);
  if (!migrationsReady) return;

  email = `e2e+m9del-${randomBytes(4).toString("hex")}@example.com`;
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser failed (${created.error?.code ?? "?"})`);
  uid = created.data.user.id;

  const ins = await admin
    .from("books")
    .insert([
      { user_id: uid, title: "Keep me", occasion: "other", tone: "fun" },
      { user_id: uid, title: "رحلتنا — delete me", occasion: "other", tone: "fun" },
    ])
    .select("id, title");
  if (ins.error || !ins.data) throw new Error(`book insert failed (${ins.error?.code ?? "?"})`);
  keepBookId = ins.data.find((b) => b.title === "Keep me")!.id;
  deleteBookId = ins.data.find((b) => b.title !== "Keep me")!.id;
  for (const id of [keepBookId, deleteBookId]) {
    const up = await admin.storage
      .from("photos")
      .upload(`${uid}/${id}/e2e-web.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { contentType: "image/jpeg" });
    if (up.error) throw new Error(`upload failed (${up.error.message})`);
  }
});

test.afterAll(async () => {
  if (!ENABLED || !uid) return;
  for (const bucket of BUCKETS) {
    for (const id of [keepBookId, deleteBookId]) {
      const names = await objectsUnder(bucket, `${uid}/${id}`);
      if (names.length > 0) await admin.storage.from(bucket).remove(names);
    }
  }
  const { data } = await admin.auth.admin.getUserById(uid);
  if (data?.user) await admin.auth.admin.deleteUser(uid);
});

test("dashboard: delete one book via the card menu (375 px)", async ({ browser }) => {
  test.setTimeout(90_000);
  test.skip(!migrationsReady, "migrations 1600/1700 not applied on the live project");
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await signIn(page, "/dashboard");
  await expect(page.getByTestId("dashboard-heading")).toBeVisible();
  await expect(page.getByTestId("book-card")).toHaveCount(2);

  const card = page.locator("li", { hasText: "delete me" });
  await card.getByTestId("book-menu").click();
  await page.getByTestId("book-menu-delete").click();
  const dialog = page.getByTestId("delete-book-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("delete-book-title")).toHaveText("رحلتنا — delete me");
  const box = await dialog.boundingBox();
  expect(box && box.width <= VIEWPORT.width).toBe(true);
  await dialog.getByTestId("delete-book-confirm").click();

  await expect(page.getByTestId("book-card")).toHaveCount(1, { timeout: 20_000 });
  await expect(dialog).toBeHidden();
  const row = await admin.from("books").select("id").eq("id", deleteBookId).maybeSingle();
  expect(row.data).toBeNull();
  expect(await objectsUnder("photos", `${uid}/${deleteBookId}`)).toEqual([]);
  expect((await objectsUnder("photos", `${uid}/${keepBookId}`)).length).toBe(1);
  console.log("[e] book deleted: row=0 objects=0 other book kept=1");
  await context.close();
});

test("settings: reminders toggle saves; delete account removes everything (375 px)", async ({ browser }) => {
  test.setTimeout(120_000);
  test.skip(!migrationsReady, "migrations 1600/1700 not applied on the live project");
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await signIn(page, "/settings");
  await expect(page.getByTestId("settings-heading")).toBeVisible();

  const toggle = page.getByTestId("settings-reminders-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(page.getByTestId("settings-reminders-saved")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const prof = await admin.from("profiles").select("email_reminders").eq("id", uid).single();
  expect(prof.data?.email_reminders).toBe(false);

  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollW).toBeLessThanOrEqual(VIEWPORT.width);

  const button = page.getByTestId("settings-delete-button");
  await expect(button).toBeDisabled();
  await page.getByTestId("settings-delete-input").fill("delete");
  await expect(button).toBeDisabled();
  await page.getByTestId("settings-delete-input").fill("DELETE");
  await button.click();

  await page.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });
  await expect(page.getByTestId("account-deleted-notice")).toBeVisible();
  expect(new URL(page.url()).search).toBe("");

  const user = await admin.auth.admin.getUserById(uid);
  expect(user.data?.user ?? null).toBeNull();
  const books = await admin.from("books").select("id").eq("user_id", uid);
  expect(books.data ?? []).toEqual([]);
  expect(await objectsUnder("photos", `${uid}/${keepBookId}`)).toEqual([]);

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  console.log("[e] account deleted: user=0 books=0 objects=0 signed_out=1");
  await context.close();
});
