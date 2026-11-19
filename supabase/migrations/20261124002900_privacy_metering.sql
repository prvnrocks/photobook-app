-- =============================================================================
-- 20261124002900_privacy_metering.sql — AI usage ledger, spending caps, book
-- entitlements (grants) and a Postgres rate limiter (Task 9)
--
-- Additive only: 0100–2800 must not be edited. No existing table, column,
-- constraint, policy, grant, trigger or function changes.
--
-- 1) public.ai_usage_ledger — ONE ledger row per model attempt of every AI operation
--    (album pipeline agents, photo analysis, story plan / write / repair /
--    rewrite, page compose): operation, model, mode, status
--    ('ok' | 'failed' | 'refused' | 'retried'), attempt number, error code,
--    token usage (incl. cache read / write), cost_usd, priced (false = the model
--    had no configured price and was costed at the most expensive known rate),
--    latency_ms and cost_bucket:
--      'preview'  storybook AI work on a book that has no full entitlement yet
--                 (the free 4–6 page preview)
--      'paid'     any AI work on a book with a full entitlement (paid, comped
--                 or granted)
--      'other'    everything else (classic album pipeline on a free book)
--    NO text: no prompt, answer, description, caption, narrative or path. The
--    per-attempt detail tables (agent_steps, photo_analyses, story_ai_calls)
--    keep working unchanged; this table is what spending caps and cost reports
--    read. user_id / book_id are ON DELETE SET NULL (not cascade) on purpose:
--    the ledger holds only numbers, and deleting a book must not reset the
--    user's spend (a delete-and-retry loop would otherwise dodge the caps).
--    Rows of a deleted account keep no user id.
-- 2) public.ai_usage_totals(p_user, p_book) — live spend of the book (all
--    time), and of the user today / this month (Asia/Dubai, UTC+4 fixed), for
--    the per-book / per-user caps in src/lib/ai/spend-caps.ts.
--    public.admin_ai_usage_by_bucket(p_days) — daily spend per cost bucket
--    (admin report: free-preview cost apart from paid-book cost).
-- 3) public.book_entitlements — an AUTHORIZED full-storybook entitlement for
--    one book that is not a payment (support grant, tester, promotion).
--    Granted / revoked only by server code with the service role
--    (src/lib/entitlements/grant.ts). It unlocks full storybook generation
--    only — never the paid export (PDF), the watermark-free viewer or the
--    permanent link, which stay tied to books.is_paid (set only by the Stripe
--    webhook / comp_book). At most one active grant per book.
-- 4) private.rate_limit_windows + public.rate_limit_hit(bucket, limit,
--    window) — fixed-window counter for the AI-triggering routes and
--    checkout (429 + Retry-After). Bucket keys are '<route>:<32 hex>' — the hex
--    is a hash of the user id made in code, so the table holds no user id.
--    public.cleanup_rate_limits(p_hours) deletes old windows (for an operator /
--    cron sweep; active buckets already drop their own old windows on each hit).
--
-- Access: every new object is SERVICE ROLE ONLY. ai_usage_ledger and
-- book_entitlements have RLS on, no client grants and no policies (like
-- story_ai_calls); the rate limit table lives in the private schema; all four
-- functions are SECURITY INVOKER with search_path '' and EXECUTE revoked from
-- public / anon / authenticated.
--
-- Deploy order: migration FIRST, then the Task 9 code. Code against a database
-- without 2900 keeps working: the ledger write fails (logged as a code, the
-- call itself is unaffected), spending caps and the rate limiter fail OPEN
-- (missing function → allowed) and entitlements fall back to books.is_paid.
-- Rollback: older code never touches these objects; dropping them is safe
-- (the ledger is then lost — export it first if it is needed).
--
-- rls_check.sql: 187 → 190 checks (+1 ai usage ledger: no client access, no
-- text column, value checks, totals; +1 book entitlements: no client access,
-- one active grant per book, PDF stays tied to is_paid; +1 rate limiter: no
-- client access, counts, retry-after, bucket format).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) AI usage ledger
-- ---------------------------------------------------------------------------
create table public.ai_usage_ledger (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references auth.users (id) on delete set null,
  book_id            uuid references public.books (id) on delete set null,
  run_id             uuid,
  operation          text not null,
  model              text not null,
  mode               text not null,
  status             text not null,
  attempt            smallint not null default 1,
  error              text,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd           numeric(10, 6) not null default 0,
  priced             boolean not null default true,
  latency_ms         integer not null default 0,
  cost_bucket        text not null,
  created_at         timestamptz not null default now(),
  constraint ai_usage_ledger_operation_check check (
    operation in ('curator', 'storyteller', 'caption_writer', 'critic', 'rewriter', 'memory_keeper',
                  'photo_analysis', 'plan', 'write', 'repair', 'rewrite', 'compose')
  ),
  constraint ai_usage_ledger_model_length check (char_length(model) between 1 and 64),
  constraint ai_usage_ledger_mode_check check (mode in ('live', 'replay')),
  constraint ai_usage_ledger_status_check check (status in ('ok', 'failed', 'refused', 'retried')),
  constraint ai_usage_ledger_attempt_check check (attempt between 1 and 20),
  constraint ai_usage_ledger_error_check check (
    (status = 'ok' and error is null)
    or (status <> 'ok' and error is not null and error ~ '^[a-z_]{3,40}$')
  ),
  constraint ai_usage_ledger_bucket_check check (cost_bucket in ('preview', 'paid', 'other')),
  constraint ai_usage_ledger_counts_check check (
    input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0
    and cache_write_tokens >= 0 and cost_usd >= 0 and latency_ms >= 0
  )
);

create index ai_usage_ledger_user_id_created_at_idx on public.ai_usage_ledger (user_id, created_at);
create index ai_usage_ledger_book_id_idx on public.ai_usage_ledger (book_id);
create index ai_usage_ledger_created_at_idx on public.ai_usage_ledger (created_at);

alter table public.ai_usage_ledger enable row level security;

-- Service role only: no client privileges and no policies.
revoke all on table public.ai_usage_ledger from anon, authenticated, public;
grant all on table public.ai_usage_ledger to service_role;

-- ---------------------------------------------------------------------------
-- 2) Totals for the spending caps + the admin bucket report
-- ---------------------------------------------------------------------------
-- Asia/Dubai has no DST: day / month starts are computed with a fixed +4 h
-- offset on UTC, independent of the session time zone.
create or replace function public.ai_usage_totals(p_user uuid, p_book uuid)
returns table (book_usd numeric, user_day_usd numeric, user_month_usd numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    select
      (date_trunc('day', (now() at time zone 'UTC') + interval '4 hours') - interval '4 hours') at time zone 'UTC' as day_start,
      (date_trunc('month', (now() at time zone 'UTC') + interval '4 hours') - interval '4 hours') at time zone 'UTC' as month_start
  )
  select
    coalesce(sum(u.cost_usd) filter (where p_book is not null and u.book_id = p_book), 0)::numeric,
    coalesce(sum(u.cost_usd) filter (where u.user_id = p_user and u.created_at >= b.day_start), 0)::numeric,
    coalesce(sum(u.cost_usd) filter (where u.user_id = p_user and u.created_at >= b.month_start), 0)::numeric
  from bounds as b
  left join public.ai_usage_ledger as u
    on u.mode = 'live'
   and ((p_user is not null and u.user_id = p_user) or (p_book is not null and u.book_id = p_book));
$$;

revoke all on function public.ai_usage_totals(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ai_usage_totals(uuid, uuid) to service_role;

create or replace function public.admin_ai_usage_by_bucket(p_days integer)
returns table (day date, cost_bucket text, usd numeric, calls bigint, failed bigint, retried bigint, unpriced bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_days is null or p_days < 1 or p_days > 366 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
    select ((u.created_at at time zone 'UTC') + interval '4 hours')::date as day,
           u.cost_bucket,
           coalesce(sum(u.cost_usd), 0)::numeric as usd,
           count(*) as calls,
           count(*) filter (where u.status in ('failed', 'refused')) as failed,
           count(*) filter (where u.status = 'retried') as retried,
           count(*) filter (where not u.priced) as unpriced
      from public.ai_usage_ledger as u
     where u.mode = 'live'
       and u.created_at >= now() - make_interval(days => p_days)
     group by 1, 2
     order by 1 desc, 2;
end;
$$;

revoke all on function public.admin_ai_usage_by_bucket(integer) from public, anon, authenticated;
grant execute on function public.admin_ai_usage_by_bucket(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Book entitlements (authorized grants; never a payment)
-- ---------------------------------------------------------------------------
create table public.book_entitlements (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references public.books (id) on delete cascade,
  tier        text not null default 'full',
  source      text not null default 'grant',
  reason      text not null,
  granted_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  constraint book_entitlements_tier_check check (tier = 'full'),
  constraint book_entitlements_source_check check (source = 'grant'),
  constraint book_entitlements_reason_check check (
    char_length(btrim(reason)) between 1 and 200 and reason !~ '[[:cntrl:]]'
  ),
  constraint book_entitlements_revoked_check check (revoked_at is null or revoked_at >= created_at)
);

create unique index book_entitlements_one_active_idx
  on public.book_entitlements (book_id)
  where revoked_at is null;

alter table public.book_entitlements enable row level security;

revoke all on table public.book_entitlements from anon, authenticated, public;
grant all on table public.book_entitlements to service_role;

-- ---------------------------------------------------------------------------
-- 4) Rate limiter (fixed window)
-- ---------------------------------------------------------------------------
create table private.rate_limit_windows (
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start),
  constraint rate_limit_windows_bucket_check check (bucket ~ '^[a-z_]{1,32}:[0-9a-f]{32}$'),
  constraint rate_limit_windows_hits_check check (hits >= 0)
);

create index rate_limit_windows_window_start_idx on private.rate_limit_windows (window_start);

alter table private.rate_limit_windows enable row level security;

revoke all on table private.rate_limit_windows from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on table private.rate_limit_windows to service_role;

-- Counts one hit in the current window of the bucket. Returns 0 when the hit
-- is within p_limit, else the seconds until the window ends (≥ 1). Atomic:
-- INSERT … ON CONFLICT DO UPDATE locks the row, so concurrent hits serialise.
-- Older windows of the same bucket are deleted on the way.
create or replace function public.rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now   timestamptz := clock_timestamp();
  v_start timestamptz;
  v_hits  integer;
begin
  if p_bucket is null or p_bucket !~ '^[a-z_]{1,32}:[0-9a-f]{32}$'
     or p_limit is null or p_limit < 1 or p_limit > 10000
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  v_start := to_timestamp(floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);

  insert into private.rate_limit_windows as w (bucket, window_start, hits)
  values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update
     set hits = w.hits + 1
  returning w.hits into v_hits;

  delete from private.rate_limit_windows as w
   where w.bucket = p_bucket
     and w.window_start < v_start;

  if v_hits <= p_limit then
    return 0;
  end if;
  return greatest(
    1,
    ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - v_now)))::integer
  );
end;
$$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- Deletes windows that started more than p_hours ago (operator / cron sweep). Returns the count.
create or replace function public.cleanup_rate_limits(p_hours integer)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_hours is null or p_hours < 1 or p_hours > 720 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  delete from private.rate_limit_windows as w
   where w.window_start < now() - make_interval(hours => p_hours);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.cleanup_rate_limits(integer) from public, anon, authenticated;
grant execute on function public.cleanup_rate_limits(integer) to service_role;
