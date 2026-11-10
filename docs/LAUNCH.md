# Launch checklist

Work through this list top to bottom; each section assumes the earlier ones are done. Tick boxes as you go
(`- [x]`). Day-2 operations (refunds, comps, cron, PDF failures, deleting users, rotating secrets) are in
[`RUNBOOK.md`](RUNBOOK.md).

Conventions: `<domain>` = the production domain (e.g. `photobook.ae`), `<prod>` = `https://<domain>`,
`:user` = your Supabase user uuid. Vercel env changes only take effect after a **redeploy**.

Order that matters (from the M6–M9 deploy notes): **database migrations before the M9 code** (1600 + 1700
must be in production before the delete-book / delete-account code runs; **1800 goes the other way: deploy the
M9 review code first, then push 1800** — the new code also works without it), **`BOOK_ACCESS_SECRET` before any
code that signs cookies/tokens**, **Vercel Pro before live Stripe keys** (D-053: Hobby is non-commercial).

---

## 1. Accounts & plans

### 1.1 Vercel
- [ ] Upgrade the team to **Pro** (D-053 — required before real payments; Hobby is non-commercial use only).
- [ ] Settings → Functions → **Fluid compute ON** (also forced by `"fluid": true` in `vercel.json`; confirm
      the dashboard agrees).
- [ ] Settings → Functions → **Function CPU: Performance (4 GB / 2 vCPU)**. The PDF renderer sizes itself from
      function memory; nothing else to change. Keep `maxDuration` 300 s (`PDF_MAX_DURATION_SECONDS` in
      `src/lib/pdf/rules.ts` = route `maxDuration` = `vercel.json`; raise all three together if ever needed).
- [ ] Settings → Functions → **Function Region = the region closest to the Supabase project** (see 1.2), e.g.
      Supabase `ap-south-1` (Mumbai) → `bom1`; `eu-central-1` (Frankfurt) → `fra1`. Every PDF print image is
      downloaded from Storage, so this directly affects render time. (Optional extra: `preferredRegion` in
      `src/app/api/books/[id]/pdf/route.ts`, see the TODO there — the project setting is enough.)
- [ ] Deployment Protection: Production public; Preview stays protected (Vercel Authentication). Create a
      **Protection Bypass for Automation** secret → `VERCEL_AUTOMATION_BYPASS_SECRET` (Preview) so the PDF
      renderer can open `/print/...` on Preview.
- [ ] Settings → Billing → Spend Management: set a monthly alert/limit.

### 1.2 Supabase
- [ ] Upgrade the production project to **Pro** (daily backups, 7-day retention, no project pausing).
- [ ] Later (when there are paying users): add **Point-in-Time Recovery**.
- [ ] Region note: the project region **cannot be changed** (moving = new project + data migration). Supabase
      has no UAE region; Mumbai (`ap-south-1`) is closest to UAE users, Frankfurt for EU. Write the actual
      region down here: `__________` — it is needed for the Vercel function region (1.1) and for the privacy
      policy (`src/lib/legal/processors.ts`, Supabase `location`).
- [ ] Authentication → Rate Limits → **Rate limit for sending emails**: raise from the default once custom
      SMTP is on (1.4), e.g. 100/hour. Leave the OTP/verify limits at their defaults.

### 1.3 Stripe
- [ ] Account under the **UAE legal entity** (AED payouts to a UAE bank account), business verification
      complete, payouts schedule set.
- [ ] Settings → Payment methods: **Apple Pay** and **Google Pay** ON (hosted Checkout — no domain verification
      needed). Cards ON.
- [ ] Settings → Customer emails: **Successful payments** and **Refunds** receipts ON. Set statement descriptor
      and public business name / support email (same as `SUPPORT_EMAIL`).
- [ ] Developers → API keys: copy the **live secret key** (`sk_live_…`, or a restricted `rk_live_…` with
      Checkout Sessions write + Charges/Refunds read) → `STRIPE_SECRET_KEY` (Production only).
- [ ] Developers → Webhooks → Add endpoint `<prod>/api/stripe/webhook` (**live** mode) with exactly these
      **6 events**:
      `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
      `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`,
      `charge.dispute.created`. Copy its signing secret → `STRIPE_WEBHOOK_SECRET` (Production).
- [ ] Same endpoint in **test** mode for Preview (`<preview-origin>/api/stripe/webhook`, same 6 events) →
      Preview's own `STRIPE_WEBHOOK_SECRET` + `sk_test_…`. Each environment has its own secret.
- [ ] Adaptive Pricing stays off (the app sends `adaptive_pricing: {enabled: false}`; don't enable it in the
      Dashboard either).

### 1.4 Resend (email)
- [ ] Add the sending domain (e.g. `mail.<domain>` or `<domain>`); pick its region (write it into
      `src/lib/legal/processors.ts`, Resend `location`).
- [ ] DNS: add the **SPF** (TXT/MX on the send subdomain) and **DKIM** (`resend._domainkey` TXT) records Resend
      shows; add **DMARC** `_dmarc.<domain>` TXT `v=DMARC1; p=none; rua=mailto:<SUPPORT_EMAIL>` (tighten to
      `quarantine` after a few clean weeks). Wait until Resend shows the domain **Verified**.
- [ ] API key (sending access, this domain only) → `RESEND_API_KEY` (Production). `EMAIL_FROM` =
      `"<App name> <hello@<domain>>"` on the verified domain. Set these only after `SUPPORT_EMAIL` is real (5.1).
- [ ] **Supabase Auth custom SMTP via Resend**: Supabase → Authentication → Emails → SMTP Settings → enable;
      host `smtp.resend.com`, port `465`, user `resend`, password = a Resend API key (a separate key is fine),
      sender = an address on the verified domain. (Built-in SMTP sends ~2 emails/hour, only to team members.)
- [ ] Email templates still point at `/auth/confirm` in BOTH Magic Link and Confirm signup:
      `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` (+ `{{ .Token }}` for the code).
- [ ] Then raise the Supabase email rate limit (1.2).

### 1.5 PostHog (analytics)
- [ ] Project on **PostHog EU Cloud** (eu.posthog.com). Project API key → `NEXT_PUBLIC_POSTHOG_KEY`;
      leave `NEXT_PUBLIC_POSTHOG_HOST` empty (defaults to `https://eu.i.posthog.com`).
- [ ] Project settings → **Discard client IP data: ON** (NEEDS-HUMAN from M9 T14).

### 1.6 Sentry (errors)
- [ ] Organisation in the **EU data region** (`de.sentry.io`), project type Next.js. DSN → `SENTRY_DSN` and
      `NEXT_PUBLIC_SENTRY_DSN` (same value).
- [ ] Organisation auth token (source map upload scope) → `SENTRY_AUTH_TOKEN` in the Vercel **build** env;
      `SENTRY_ORG`, `SENTRY_PROJECT` = the slugs. Without the token stack traces stay minified (nothing breaks).
- [ ] Project settings → Security & Privacy: data scrubber ON, **Prevent storing of IP addresses** ON.

### 1.7 Others
- [ ] Anthropic Console: production API key (`ANTHROPIC_API_KEY`), monthly spend limit in the Console as a
      second breaker behind `AI_DAILY_BUDGET_USD`.
- [ ] Mapbox: production token (`MAPBOX_TOKEN`), URL-restricted is not possible for server use — keep it secret.

---

## 2. Domain

- [ ] Buy the domain (`.ae` needs a UAE registrar/trade licence; `.com` as fallback).
- [ ] Vercel → Project → Domains → add `<domain>` and `www.<domain>`; pick ONE canonical host and make the
      other redirect to it. Add the DNS records Vercel shows.
- [ ] `NEXT_PUBLIC_APP_URL` (Production) = the **exact canonical origin** after redirects: scheme + host, no
      trailing slash, no path (e.g. `https://photobook.ae`, not `https://www.photobook.ae` if www redirects
      to apex). A redirecting value breaks every PDF export (`navigation_failed`) and sign-in redirects.
- [ ] Supabase → Authentication → URL Configuration: **Site URL** = `NEXT_PUBLIC_APP_URL`; **Redirect URLs**:
      `<prod>/**`, the Preview origin `/**` (see 3), `http://localhost:3000/**`. Remove the old
      `*.vercel.app` production URL once the domain works.
- [ ] Google Cloud Console → OAuth consent screen: app name, support email, **app domain**, privacy policy
      `<prod>/privacy`, terms `<prod>/terms`, authorised domain `<domain>` → **Publish app** (status
      "In production"; carried since M1). Credentials → OAuth client: Authorised JavaScript origins `<prod>`
      (+ Preview origin, `http://localhost:3000`); Authorised redirect URI stays
      `https://<project-ref>.supabase.co/auth/v1/callback`.
- [ ] Share links in WhatsApp must use `<prod>` (deployment-hash URLs are behind Vercel Authentication).

---

## 3. Environment variables per environment

Set in Vercel → Settings → Environment Variables. Mark every "secret = yes" value as **Sensitive**.
Development = your `.env.local` (copy `.env.example`). Preview should use **test** Stripe keys and a stable
Preview origin (e.g. the branch alias of a `staging` branch) that is also in the Supabase redirect URLs.

| Key | Production | Preview | Development | Secret? | Where to get it |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | prod project URL | prod or staging project URL | dev project URL | no | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | prod `sb_publishable_…` | matching project | dev project | no | Supabase → Project Settings → API keys |
| `SUPABASE_SECRET_KEY` | prod `sb_secret_…` | matching project | dev project | **yes** | Supabase → Project Settings → API keys (server only) |
| `ANTHROPIC_API_KEY` | live key | optional (costs money) | optional | **yes** | Anthropic Console → API keys |
| `AI_MODE` | empty (auto → live with key) or `live` | empty / `replay` | `replay` | no | — (`off` \| `replay` \| `live`) |
| `AI_DAILY_BUDGET_USD` | **`10`** at launch | e.g. `2` | empty | no | — (USD per Asia/Dubai day; `0` = AI off) |
| `ADMIN_USER_IDS` | your uid (`:user`) | your uid | your uid | no (but not public) | Supabase → Authentication → Users. Gates `/admin/runs`, `/admin/ai-spend` and `scripts/comp-book.mjs` |
| `MAPBOX_TOKEN` | prod token | same or dev token | dev token | **yes** | Mapbox → Account → Access tokens |
| `STRIPE_SECRET_KEY` | `sk_live_…` / `rk_live_…` | `sk_test_…` | `sk_test_…` | **yes** | Stripe → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | live endpoint `whsec_…` | test endpoint `whsec_…` | from `stripe listen` | **yes** | Stripe → Developers → Webhooks → endpoint |
| `STRIPE_ALLOW_TEST_IN_PROD` | **not set — remove it** | not set | not set | no | — (only for a deliberate test-mode run on Production) |
| `NEXT_PUBLIC_APP_URL` | `<prod>` exact canonical origin | stable Preview origin | `http://localhost:3000` | no | your domain (2) |
| `CRON_SECRET` | random | random (other value) | optional | **yes** | `openssl rand -base64 32`; Vercel Cron sends it automatically |
| `BOOK_ACCESS_SECRET` | random ≥ 32 bytes | random (other value) | random | **yes** | `openssl rand -base64 32` (rotating signs viewers out of locked books) |
| `RESEND_API_KEY` | Resend key | optional (real emails!) | optional | **yes** | Resend → API keys |
| `EMAIL_FROM` | `"<App> <hello@<domain>>"` | same if key set | same if key set | no | address on the Resend-verified domain |
| `PDF_CHROME_PATH` | not set | not set | local Chrome/Chromium path | no | `node -e "console.log(require('playwright').chromium.executablePath())"` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | not needed | bypass secret | not set | **yes** | Vercel → Settings → Deployment Protection → Protection Bypass for Automation |
| `SENTRY_DSN` | DSN | DSN (environment tag separates) | empty | no | Sentry → Project → Client Keys (DSN) |
| `NEXT_PUBLIC_SENTRY_DSN` | same DSN | same DSN | empty | no | same as above |
| `SENTRY_AUTH_TOKEN` | token (build env) | token (build env) | empty | **yes** | Sentry → Settings → Auth Tokens (organisation token) |
| `SENTRY_ORG` | org slug | org slug | empty | no | Sentry organisation settings |
| `SENTRY_PROJECT` | project slug | project slug | empty | no | Sentry project settings |
| `NEXT_PUBLIC_POSTHOG_KEY` | EU project key | empty (keep stats clean) or a 2nd project | empty | no | PostHog → Project settings → Project API key |
| `NEXT_PUBLIC_POSTHOG_HOST` | empty | empty | empty | no | — (defaults to `https://eu.i.posthog.com`) |

- [ ] All Production values set; **`STRIPE_ALLOW_TEST_IN_PROD` removed** from every environment.
- [ ] `CRON_SECRET` and `BOOK_ACCESS_SECRET` differ between Production and Preview.
- [ ] `AI_DAILY_BUDGET_USD=10` in Production; `ADMIN_USER_IDS` set in Production + Preview.
- [ ] Redeploy Production after the last env change.

---

## 4. Database

- [ ] Run in **your own Terminal** (needs a TTY; CLI pinned to 2.x): `npx supabase link` to the prod project,
      then `npx supabase db push`. All migrations through **`20261114001800_warning_confirm.sql`** must be
      applied — check with `npx supabase migration list --linked` (local and remote columns identical).
      Apply 1600 + 1700 **before** deploying the M9 code; apply **1800 after** the code that calls
      `confirm_warning` is live (old code + 1800 would re-send warnings daily — safe, but noisy).
- [ ] Supabase → SQL Editor → paste the whole of `supabase/tests/rls_check.sql` → Run. Expected: an error panel
      starting with **`RLS OK — all 173 checks passed`** (raised on purpose; it rolls everything back). Anything
      else (`RLS FAIL [...]`, permission denied) is a blocker.
- [ ] Verify `private.auth_user_email` works (the warning emails depend on it; needs `postgres` to read
      `auth.users`):
      ```sql
      begin;
      set local role service_role;
      select private.auth_user_email(':user');   -- expect your sign-in email
      rollback;
      ```
- [ ] Verify the `delete_book_guarded` lock behaviour with **two SQL Editor tabs** (the race with a concurrent
      checkout was reasoned, not tested on prod). Create two throwaway free books in the app (`:book1`,
      `:book2`, no payment). Each tab's script holds its transaction open with `pg_sleep`; start the second
      tab within 20 s.
  - Our lock first — Tab A:
    ```sql
    begin;
    select public.delete_book_guarded(':book1', ':user');  -- 'deleted', row locked
    select pg_sleep(20);
    commit;
    ```
    Tab B (while A sleeps):
    ```sql
    insert into public.orders (user_id, book_id, type, amount, currency, status, stripe_session_id, livemode, note)
    values (':user', ':book1', 'digital', 3900, 'aed', 'pending', 'cs_test_locktest_1', false, 'lock test');
    ```
    Expect: Tab B **waits** until A commits, then fails with `23503` (foreign key violation). No order row.
  - Their insert first — Tab B:
    ```sql
    begin;
    insert into public.orders (user_id, book_id, type, amount, currency, status, stripe_session_id, livemode, note)
    values (':user', ':book2', 'digital', 3900, 'aed', 'pending', 'cs_test_locktest_2', false, 'lock test');
    select pg_sleep(20);
    commit;
    ```
    Tab A (while B sleeps): `select public.delete_book_guarded(':book2', ':user');`
    Expect: Tab A **waits**, then returns **`protected`**; the book still exists.
  - Clean up: `delete from public.orders where stripe_session_id in ('cs_test_locktest_1', 'cs_test_locktest_2');`
    then delete `:book2` from the dashboard (⋯ → Delete book). Storage leftovers of `:book1` (if it had photos)
    are removed by the orphan sweep after 7 days.
- [ ] `npm run db:types` and check `git diff src/lib/supabase/database.types.ts` is empty (prod schema = code).

---

## 5. Content

### 5.1 Brand and support
- [ ] `SUPPORT_EMAIL` in `src/lib/brand.ts` = a real inbox that **receives** mail (Resend only sends — use
      Google Workspace / Zoho / forwarding with MX records on the domain). Set it before `EMAIL_FROM`.
- [ ] `LEGAL_ENTITY_NAME` in `src/lib/brand.ts` = the registered company name from the UAE trade licence.
- [ ] `src/lib/legal/processors.ts`: Supabase region (1.2) and Resend region (1.4).
- [ ] Final product name (`APP_NAME`, D-040 placeholder "Photobook") if branding changes before launch.

### 5.2 Legal pages (M9 T12)

**DRAFT — not legal advice — review with a lawyer.**

- `/privacy` and `/terms` (src/app/(marketing)/privacy, terms) are team-written drafts. They show a visible
  "Draft — under legal review" note while `LEGAL_DRAFT = true` in `src/lib/legal/meta.ts`. Flip it to
  `false` only after a lawyer signs off, and update `LEGAL_LAST_UPDATED`.
- NEEDS-HUMAN before launch:
  - `SUPPORT_EMAIL` and `LEGAL_ENTITY_NAME` in `src/lib/brand.ts` (placeholders now).
  - Supabase project region and Resend sending region in `src/lib/legal/processors.ts`.
  - Which data-protection law applies: federal PDPL (Federal Decree-Law No. 45 of 2021) — or ADGM / DIFC
    rules if the company is licensed in a financial free zone. GDPR wording for EU visitors.
  - Refund policy (Terms §Refunds, currently "email within 14 days"), liability cap, governing law and courts.
  - Anthropic training wording ("Under Anthropic's commercial terms, data sent through its API is not used to
    train its models") — check against Anthropic's current commercial terms. Same sentence in the landing FAQ
    (`src/lib/marketing/faq.ts`).
  - Minimum age (18 assumed), cross-border transfer basis.
- Retention text is generated from `retentionSummary()` in `src/lib/cleanup/rules.ts` — change the constants,
  not the page.

Checklist:
- [ ] Lawyer review of `/privacy` + `/terms`, including the **ADGM / DIFC vs federal PDPL** question (depends on
      where the company is licensed), refund wording, liability cap, governing law, minimum age, transfers.
- [ ] Anthropic training sentence checked (privacy + `src/lib/marketing/faq.ts`).
- [ ] After sign-off: `LEGAL_DRAFT = false` and `LEGAL_LAST_UPDATED` updated in `src/lib/legal/meta.ts`.

### 5.3 Landing page (M9 T11)

- Hero claim lives in `HERO_CLAIM` / `BUILD_TIME_CLAIM` (`src/lib/marketing/copy.ts`). If live builds take
  longer than about a minute, set `BUILD_TIME_CLAIM = "in minutes"`.
- Demo video: add `public/demo/demo.mp4` + `public/demo/poster.jpg` and redeploy (checked at build time).
- Example flipbooks: fill `EXAMPLE_BOOKS` in `src/lib/marketing/examples.ts` (static covers under `/public`)
  after the demo seed (T15).

Checklist:
- [ ] Demo books created on **production** with `scripts/seed-demo-books.mjs` (see its header for flags/env;
      export the prod `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SECRET_KEY` in the shell — `.env.local` usually
      points at dev), then comped so they have no watermark/expiry:
      `node scripts/comp-book.mjs --book <uuid> --admin :user --reason "demo for landing page"` (RUNBOOK 2.1).
- [ ] Publish the demo books, fill `EXAMPLE_BOOKS` with their slugs and static covers.
- [ ] Demo video recorded (`scripts/record-demo.mjs`) → `public/demo/demo.mp4` + `poster.jpg`, redeploy.
- [ ] **Hero claim only after live timing**: time 3 real live AI builds (~150 photos) on production; keep
      `BUILD_TIME_CLAIM = "in about a minute"` only if they finish in about a minute, else `"in minutes"`.

---

## 6. Money

- [ ] **VAT** with an accountant (D-046): AED 39 is charged VAT-inclusive with no tax line; registration is
      mandatory above AED 375k/yr. Confirm, and note the revisit trigger (Stripe Tax + `automatic_tax`).
- [ ] Refund policy wording agreed (Terms §Refunds, landing FAQ, Stripe receipt footer) — and that refunds
      never revoke a book automatically (RUNBOOK 1.5 is the manual path).
- [ ] **Test payment on Preview** (test keys, test webhook endpoint): card `4242 4242 4242 4242` on a phone,
      plus Apple Pay / Google Pay; book becomes paid within seconds, watermark gone, expiry gone, PDF works;
      Stripe → Webhooks shows 200s. Also try a non-AED card (session stays AED). This is the open M7 T10.
- [ ] **Live payment on Production**: pay AED 39 with a real card for your own book → paid; then refund it in
      Stripe → order becomes `refunded`, book stays paid (decide: revoke per RUNBOOK 1.5 or keep). Check the
      receipt email and that the payout/balance shows AED.

---

## 7. Final checks (production, on a phone at 375 px unless noted)

Open phone checks carried from earlier milestones:
- [ ] **M2** — iPhone photo picker: does GPS arrive with "Options → Location" on? (0/110 had GPS so far);
      upload hint wording (D-020).
- [ ] **M3/M4** — review screen, Update album, Rebuild with AI; Settings memory view + clear; new-book prefill;
      captions preview (Arabic RTL in Cairo).
- [ ] **M3b/M4b live AI** (with the key): first live build works; cache reads > 0 on repeat calls; cost per book
      on `/admin/ai-spend` vs ~$1 per 200 photos; caption quality EN + AR (native reader); Critic catches an
      invented name; ✨ rewrite latency ~1 s.
- [ ] **M5** — editor "Done when": swipe pages, pinch crop, touch drag reorder in Pages, iOS keyboard vs the
      docked caption sheet, autosave "Saved ✓".
- [ ] **M6** — WhatsApp link preview (OG image) + smooth flip on **another** phone; iPhone battery with the
      flipbook left idle for 10 minutes (idle rAF loop).
- [ ] **M7** — real payment on a phone (6, Preview then live), "Payment cancelled" notice, success page.
- [ ] **M8** — paid **40-page PDF** on production: time click → download, and read the
      `[pdf-export] timing` log line (compare to the README estimate; Performance CPU should beat it).
- [ ] **M9** — paid end card ("The end", Replay, Share) on a phone (the white-screen bug); delete book sheet
      and delete account at 375 px; deletion chips; landing + `/privacy` + `/terms` at 375 px;
      `/admin/ai-spend` as admin with live data.

Platform checks:
- [ ] **Cron**: after the first 01:00 UTC run (or Vercel → Cron Jobs → Run), Vercel logs show one
      `[cleanup] <sweep> n=…` line per sweep, no `error=`; manual curl without the bearer returns 401.
- [ ] **Sentry**: on `<prod>` open the browser console and run
      `setTimeout(() => { throw new Error("sentry launch test") })` → the event appears in Sentry (EU) with
      environment `production`, no IP, readable (source-mapped) stack.
- [ ] **PostHog**: sign in + create a book → `book_created` arrives in PostHog EU Live events; the event shows
      no IP / location, URLs are sanitised (`/b/:slug`, `:id`), no cookies set.
- [ ] **Email**: trigger a reminder (or send one to yourself) → arrives from `EMAIL_FROM`, passes SPF/DKIM
      (Gmail "Show original"); the List-Unsubscribe **one-click** button in Gmail/iOS Mail turns
      Settings → Email reminders off; the link in the email shows the confirm page. Magic-link sign-in email
      arrives via Resend.
- [ ] Sign in with Google and with a magic link on `<prod>` (consent screen shows the app name, not "unverified").
- [ ] Stripe webhook endpoint (live) shows only 200s after the live test.

---

## 8. Launch day + rollback

Launch:
- [ ] Merge to `main` → Production deploy is green; smoke: landing, sign-in, upload 10 photos, AI build,
      publish, open the link in WhatsApp.
- [ ] Watch for the first hours: Vercel logs (`[stripe-webhook]`, `[pdf-export]`, `[cleanup]`), Sentry issues,
      `/admin/ai-spend` against the budget.

Rollback levers (fastest first):
- **Bad deploy** → Vercel → Deployments → pick the last good Production deployment → **Instant Rollback**
  (or "Promote to Production"). Takes seconds, no rebuild. While rolled back, new pushes to `main` do not go
  live automatically until you promote again. Rolling back code does not touch env vars or the database.
- **Migrations are additive** — never "roll back" by dropping schema. Older code runs against the newer schema
  (1700 note: the old webhook may 500 once on `fulfilled_after_review_order`; Stripe's retry is a 200
  duplicate and the book is paid either way). Fix forward with a new migration.
- **Turn AI off** → set `AI_DAILY_BUDGET_USD=0` (Production) → redeploy. New builds, rebuilds and caption
  rewrites are refused with "AI is taking a break — try again later"; users keep the rule-based album.
  (`AI_MODE=off` is the harder switch.)
- **Turn payments off** → remove `STRIPE_SECRET_KEY` (or `STRIPE_WEBHOOK_SECRET`) from Production → redeploy.
  Upgrade buttons show **"Payments unavailable"** and the webhook returns 503, so Stripe keeps retrying
  undelivered events for up to 3 days — restore the keys and in-flight payments are fulfilled. Expire open
  Checkout sessions in Stripe if you need them gone.
- **Turn reminder emails off** → remove `RESEND_API_KEY` → redeploy (nothing is claimed or sent).
- **Cron misbehaving** → remove `CRON_SECRET` (endpoint returns 503) → redeploy; see RUNBOOK 3.
