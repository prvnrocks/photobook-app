# Runbook: operating the photobook app

Copy-pasteable fixes for production. Run SQL in **Supabase Dashboard → SQL Editor** (runs as `postgres`,
which passes the column guard). Read with a `select` first, then change data inside `begin; … commit;`.
Logs: **Vercel → Project → Logs** (filter by tag, e.g. `[stripe-webhook]`). Logs carry ids and codes only,
never emails or amounts. Look up a Stripe object in the Stripe Dashboard by pasting its id (`cs_…`, `pi_…`, `evt_…`).

Placeholders: `:book`, `:user`, `:order`, `:session`, `:pi`. Replace them, keep the quotes.

Rules that still apply here (D-045 / D-061):
- Only the Stripe webhook sets `books.is_paid`. The exceptions are the manual fixes in this file and
  `scripts/comp-book.mjs`. Every manual entitlement change needs an `orders` row with a `note` (max 200 chars,
  no line breaks). The owner can read the note, so write it with that in mind.
- Refunds never revoke a book automatically. Revoking is a deliberate manual step.

---

## 1. Payments

### 1.1 Find everything about a book's payments
```sql
select id, status, amount, currency, stripe_session_id, stripe_payment_intent_id,
       paid_at, refunded_at, livemode, note, comped_by, created_at
  from public.orders where book_id = ':book' order by created_at;
select id, user_id, is_paid, max_pages, expires_at, published_at from public.books where id = ':book';
```
From a log line (`cs=` / `pi=`): `select * from public.orders where stripe_session_id = ':session' or stripe_payment_intent_id = ':pi';`

### 1.2 `needs_review` (log: `paid_but_invalid:<reason>` + `needs_review:updated`)
Stripe took the money, but the session failed our checks (`wrong_amount`, `wrong_currency`, missing or wrong
reference…). The book was **not** upgraded, and checkout stays blocked for that book until this is resolved.
1. Open the session (`cs_…`) in Stripe. Check the amount, the currency and `metadata.book_id` / `user_id`.
2. Pick one:
   - **Refund**: Stripe → Payment → Refund (full). The `charge.refunded` webhook sets the order to
     `refunded`, which unblocks checkout. Nothing else to do.
   - **Fulfil manually** (the payment is fine, e.g. a currency quirk):
     ```sql
     begin;
     update public.orders set status = 'paid', paid_at = coalesce(paid_at, now()),
            note = 'manual fulfil after review: <reason>'
      where id = ':order' and status = 'needs_review';
     update public.books set is_paid = true, max_pages = 100, expires_at = null where id = ':book';
     commit;
     ```
3. If the book already has another `paid` order, this is a **double payment**: refund one (1.4).

### 1.3 Paid but invalid, with **no order row** (log: `needs_review:order_missing`)
Money moved, but there is no `orders` row for the session (e.g. the order insert failed, or the session was
created outside the app). Check the session in Stripe, then either refund in Stripe (no SQL needed) or
fulfil and record it:
```sql
begin;
insert into public.orders (user_id, book_id, type, amount, currency, status, stripe_session_id,
                           stripe_payment_intent_id, paid_at, livemode, note)
values (':user', ':book', 'digital', 3900, 'aed', 'paid', ':session', ':pi', now(), true,
        'manual fulfil: no order row');
update public.books set is_paid = true, max_pages = 100, expires_at = null where id = ':book';
commit;
```
Related cases:
- `book_missing` (warn): the book was deleted, or the user and book don't match. The order is kept with
  `book_id` null. Refund unless the user tells you which book it was meant for.
- refund/dispute `order_missing` (error): a refund or dispute on a payment we have no order for. Check in Stripe.

### 1.4 Double payment (log: `double_payment` or `double_payment:review_order`)
The user paid twice for one book. Since 1700, a payment counts as already held when another session's order
is `paid`, `disputed`, `needs_review` or `comped`.
- `double_payment`: the book was already paid. The session in the log is the extra one, so refund **that** `pi=`.
- `double_payment:review_order`: the book was upgraded by the session in the log, and another session of the
  same book is in `needs_review`. Refund the `needs_review` payment (1.2, Refund).
```sql
select id, status, stripe_session_id, stripe_payment_intent_id, paid_at from public.orders
 where book_id = ':book' and status in ('paid', 'disputed', 'needs_review', 'comped') order by created_at;
```
Refund in Stripe (full). The webhook marks the order `refunded` and the book stays paid.

### 1.5 Revoking a paid book (refund given and access should end; rare)
```sql
begin;
update public.books set is_paid = false, max_pages = 20,
       expires_at = case when published_at is not null then now() + interval '30 days' end
 where id = ':book';
update public.orders set note = 'access revoked after refund: <reason>' where id = ':order';
commit;
```
Pages beyond 20 stay in the doc, but the editor and publish flow enforce the free limit again.

---

### 1.6 Stuck `pending` order (blocks "Delete account" / per-book delete; Checkout shows "already in progress")
A `pending` order normally becomes `expired` / `paid` within 31 min via the webhook. If one is still pending
hours later, the `checkout.session.expired` event was lost or failed.
1. Find it: `select id, book_id, user_id, stripe_session_id, created_at from public.orders where status = 'pending' and created_at < now() - interval '2 hours';`
2. Paste the `cs_…` into the Stripe Dashboard. **Only continue if Stripe shows the session as Expired** (no
   payment). If it shows Complete / paid, don't touch the row: resend the event (Stripe → Webhooks → event →
   Resend) and follow 1.2 if it lands in `needs_review`.
3. Mark it expired:
   ```sql
   begin;
   update public.orders
      set status = 'expired', note = 'Manually expired: Stripe session expired, webhook missed'
    where id = ':order' and status = 'pending';   -- expect UPDATE 1
   commit;
   ```

## 2. Comped books (D-061)

### 2.1 Comp a demo or goodwill book
Needs `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `ADMIN_USER_IDS` in the env or `.env.local`.
**`.env.local` usually points at the dev project.** For a prod comp, export the prod values in the shell first.
```sh
node scripts/comp-book.mjs --book <book uuid> --admin <your user uuid> --reason "demo for landing page"
```
- Prints `comped`, `already_paid` (nothing written) or `not_found` (exit code 1).
- `--admin` must be listed in `ADMIN_USER_IDS` and have a profile.
- What it does: inserts one order (`status 'comped'`, AED 0, `note` = reason, `comped_by` = admin) and sets
  `is_paid`, `max_pages = 100` and `expires_at = null`.
- If the owner has an open checkout, expire that session in Stripe first. A payment on a comped book is
  logged as `double_payment` (refund it).

List comps: `select id, book_id, user_id, note, comped_by, created_at from public.orders where status = 'comped' order by created_at desc;`

### 2.2 Revert a comp (no script, on purpose)
```sql
begin;
update public.books set is_paid = false, max_pages = 20,
       expires_at = case when published_at is not null then now() + interval '30 days' end
 where id = ':book';
-- keep the audit row; mark it so it no longer counts as an entitlement
update public.orders set status = 'refunded', refunded_at = now(), note = left('comp reverted: <reason>', 200)
 where id = ':order' and status = 'comped';
commit;
```
A reverted comp is an ordinary free book again. Retention (D-055) applies to it, and the owner can pay
normally. If the order is left as `comped`, the book can't be deleted by its owner (`delete_book_guarded`
treats it as protected).

---

## 3. Cleanup cron (`/api/cron/cleanup`, daily 01:00–01:59 UTC)

Each run logs one line per sweep:
`[cleanup] <sweep> n=<count> ms=<ms> [storage_removed=N] [storage_fail=N] [partial=1|skipped=1] [error=<code>]`.
The sweeps run in this order: `warnings, expired_books, abandoned_drafts, pending_uploads, orphans_photos,
orphans_exports, old_exports, unlock_attempts, stale_runs`.
- `partial=1`: the 240 s budget ran out. The next day's run continues where it stopped.
- `skipped=1`: the budget was used up before this sweep started.
- `storage_fail=N`: object removal failed. The orphan sweep retries these after 7 days.
- `error=<code>`: the sweep stopped. Look up the Postgres code; `42501` usually means a grant is missing on prod.
- `[cleanup] CRON_SECRET missing` / `run failed`: check the env in Vercel, then re-run by hand:
  `curl -H "Authorization: Bearer $CRON_SECRET" https://<prod-domain>/api/cron/cleanup`
- Backlog check:
  ```sql
  select count(*) filter (where expires_at < now() - interval '14 days' and not is_paid) as expired_overdue,
         count(*) filter (where published_at is null and updated_at < now() - interval '45 days') as idle_drafts
    from public.books;
  ```
  If `partial=1` shows up several days in a row, run the cron a few times by hand (it's safe; every sweep is
  idempotent).

### 3.1 Pause ALL deletions (incident, bad deploy, suspected wrong rule)
Remove `CRON_SECRET` from the Vercel Production env and redeploy. The route then answers **503** and logs
`[cleanup] CRON_SECRET missing` — no sweep runs (no warnings, no deletions, no orphan sweep). Changing the
value is **not** a pause: Vercel Cron always sends the current env value, so the next run is authorised again.
To resume: set a new value (`openssl rand -base64 32`), redeploy. The backlog is picked up over the next runs.
Per-book deletes and account deletes by users are not affected (they don't use the cron).

### 3.2 Warning emails (`[email] warnings …`, before the `warnings` sweep line)
`[email] warnings expiry_sent=N expiry_failed=N draft_sent=N draft_failed=N [deferred=N] [codes=…] [legacy=1] [release_fail=N] [partial=1]`
- How it works (migration 1800): a claim sets `*_warning_claimed_at`; only a successful send + `confirm_warning`
  sets `*_warning_sent_at`. Draft deletion requires `draft_warning_sent_at` (≥ 7 days old, after the last
  activity), so a crashed run can never get a draft deleted without an email. Claims older than 1 hour are
  taken again by the next run. Opening a warned draft (editor / review page) bumps `updated_at` and clears
  `draft_warning_sent_at` — a fresh warning is needed before any deletion.
- `deferred=N`: the warnings budget (100 s, and never later than 25 s before the cron deadline) ran out; those
  claims were released and go out tomorrow.
- `codes=confirm_<code>:N`: the email went out but the confirm failed. The book stays claimed and is re-sent by
  a later run (same day: deduped by Resend's idempotency key; next day: a duplicate email, rare).
- `legacy=1`: the database doesn't have 1800 yet (`confirm_warning` missing) — claim = sent, as in 1600.
  Push 1800.
- `codes=quota:N` / `rejected:N`: Resend daily quota / bad address or sender — check the Resend dashboard.
- **Incident: "a draft was deleted / is about to be deleted but the owner says no email arrived"**
  1. Pause deletions (3.1) if more books could be affected.
  2. Look at the claim state:
     ```sql
     select id, updated_at, draft_warning_claimed_at, draft_warning_sent_at,
            expiry_warning_claimed_at, expiry_warning_sent_at
       from public.books where user_id = ':user' and published_at is null;
     -- claimed but never confirmed (stuck > 1 h — should be 0 outside a cron run):
     select count(*) from public.books
      where (draft_warning_claimed_at < now() - interval '1 hour')
         or (expiry_warning_claimed_at < now() - interval '1 hour');
     ```
     `draft_warning_sent_at` set ⇒ our side sent it (check Resend → Emails for delivery/bounce by date).
     Only `claimed_at` set ⇒ never confirmed: it will be re-sent, the draft is safe.
  3. To give a draft a fresh full notice period (e.g. the email bounced), clear its warning — this keeps the
     idle clock but requires a new, confirmed warning (≥ 7 days) before deletion:
     ```sql
     begin;
     update public.books set draft_warning_sent_at = null, draft_warning_claimed_at = null where id = ':book';
     commit;
     ```
  4. A deleted draft can't be restored (rows and Storage are gone; Supabase PITR only if your plan has it).

## 4. PDF export failures (`[pdf-export]`)
- `[pdf-export] failed <exportId> (<code>)`, codes from `src/lib/pdf/errors.ts`:
  - `chrome_unavailable`: Chromium didn't start. On Vercel, check `@sparticuz/chromium` and the memory setting. Locally, set `PDF_CHROME_PATH`.
  - `navigation_failed`: `/print/...` didn't load. `NEXT_PUBLIC_APP_URL` must be the exact canonical origin with no redirect. On Preview, set `VERCEL_AUTOMATION_BYPASS_SECRET`.
  - `render_timeout`: the page wasn't ready within the budget. Check the `timing` line, which is usually slow Storage downloads (`images_ready`, `dl_sum`).
  - `image_failed`: a print image didn't load or decode (a missing original, or a corrupt file).
  - `print_failed` / `merge_failed`: a Chromium or pdf-lib error. Retry, and if it repeats, test locally with the doc snapshot from `public.exports`.
  - `token_unavailable`: `BOOK_ACCESS_SECRET` is missing or shorter than 32 bytes.
- `timing <id> load= plan= images_ready= launch= render= chunks= merge= upload= finish= …` gives ms per phase.
  Compare against the M8 baselines.
- `busy_instance`: another render is running on that instance. The client retries, so this is normal under load.
- Stuck jobs: `select id, status, attempt, error_code, created_at from public.exports where book_id = ':book' order by created_at desc;`
  Rows stuck in `rendering` past their lease are re-claimed automatically (stale after 360 s).

## 5. Delete a user on request
Users can do this themselves: Settings → Delete account (type DELETE). It deletes every book (paid ones too),
both Storage prefixes per book, then the auth user, signs out and lands on `/?account=deleted`. It refuses with
"A payment is still being processed" while any of their orders is `pending` (Checkout sessions expire after
31 min). A single book: dashboard card ⋯ → Delete book — refused for books with a payment (paid, comped, or an
order pending / needs_review / disputed): "contact support". Logs: `[account] deleted books=N storage_failures=N`
or `[account] delete failed step=check|books|storage|user code=…` (step=user: books are gone, the account
still exists — retrying in Settings, or step 3 below, finishes it).

Manual path (support request, or a book the owner can't delete):
1. Find the user: `select id, email from auth.users where email = '<email>';`
2. Delete Storage first, in **both** buckets `photos` and `exports`: Dashboard → Storage → bucket → folder
   `<user_id>` → select all → Delete. (Direct SQL deletes on `storage.objects` are blocked on Supabase.)
   If you miss any, the daily orphan sweep removes leftovers after 7 days.
3. Delete the auth user: Dashboard → Authentication → Users → user → Delete user.
   Cascades remove profiles, books, photos, exports, unlock attempts and user_memory. `orders` and `agent_runs`
   keep their rows with `user_id`/`book_id` set to null, so payment history and cost totals survive.
4. Check:
   ```sql
   select (select count(*) from public.books where user_id = ':user') as books,
          (select count(*) from storage.objects where (storage.foldername(name))[1] = ':user') as objects;
   ```
   Both should be 0. Refund any open payments in Stripe separately; deleting the user doesn't touch Stripe.

## 6. Rotate secrets
Change the value in Vercel (Production + Preview), redeploy, then revoke the old one.

| Secret | Where | Side effects |
|---|---|---|
| `SUPABASE_SECRET_KEY` | Supabase → Settings → API keys → create a new secret key, deploy, delete the old key | none |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → roll | open Checkout sessions keep working |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → endpoint → Roll secret (old one stays valid for the overlap you choose) | while they differ, events fail with a 400 and Stripe retries them |
| `ANTHROPIC_API_KEY` | Anthropic Console → new key → deploy → delete old | AI falls back to the rule-based album if the key is bad |
| `CRON_SECRET` | any random value (`openssl rand -base64 32`) | the next cron run uses the new value (removing it pauses the cron, see 3.1) |
| `BOOK_ACCESS_SECRET` | `openssl rand -base64 32` | signs every viewer out of locked books (access cookies); in-flight PDF print tokens fail once; **every unsubscribe link in already-sent warning emails stops working** (the page shows "link invalid or expired" — users can still turn reminders off in Settings). Avoid rotating it in the days after a warning run unless it leaked. |
| `RESEND_API_KEY` | Resend → API Keys → create (sending access, your domain) → deploy → delete the old key | none if the new key works; a bad key makes the warnings run log `codes=rejected:N` (nothing is marked sent; tomorrow retries). Supabase Auth SMTP uses its own key — rotate it under Supabase → Auth → SMTP separately |
| `MAPBOX_TOKEN`, `SENTRY_*`, `VERCEL_AUTOMATION_BYPASS_SECRET` | the provider's dashboard | none |

After rotating: send a test webhook (Stripe → Webhooks → Send test event; it should show 200), open a locked
book, and trigger one PDF export.
