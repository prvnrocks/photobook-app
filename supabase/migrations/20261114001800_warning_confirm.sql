-- =============================================================================
-- 20261114001800_warning_confirm.sql — Milestone 9 review B1: crash-safe
-- warning emails (claim / confirm split, D-057 amended)
--
-- Additive only: 0100–1700 are applied in production and must not be edited.
--
-- Problem (review B1): 1600's claim_* set *_warning_sent_at at CLAIM time. A
-- cron run killed between the claim and the send left drafts "warned" without
-- an email, and cleanup_delete_abandoned_drafts deleted them 7 days later.
--
-- 1) books.expiry_warning_claimed_at / books.draft_warning_claimed_at
--    timestamptz — SERVER-ONLY: private.protect_book_columns (latest = 1600)
--    gains both (null on INSERT, old value on UPDATE for non-privileged
--    callers). Still SECURITY INVOKER (current_user check, see 0100).
--
-- 2) private.set_book_updated_at: an update that changes only the four warning
--    columns (sent_at + claimed_at, both kinds) keeps updated_at — claiming,
--    confirming or releasing must never reset a draft's idle clock.
--
-- 3) claim_expiry_warnings / claim_draft_warnings — same signatures and
--    result columns (replaced in place, grants re-asserted). They now set
--    *_warning_claimed_at = now() and NO LONGER touch *_warning_sent_at.
--    Claimable = not sent (expiry: sent_at null; draft: sent_at null or older
--    than the last activity) AND (claimed_at null OR claimed_at older than
--    1 hour). The 1-hour window reclaims claims of a run that died before
--    confirming (the cron's maxDuration is 300 s, so a live run never holds a
--    claim that long); the daily cron therefore retries them the next day.
--
-- 4) confirm_warning(p_book uuid, p_kind text) → boolean (NEW)
--    After a successful send: *_warning_sent_at := *_warning_claimed_at,
--    *_warning_claimed_at := null — only when a claim exists. true when a claim
--    was confirmed. cleanup_delete_abandoned_drafts (unchanged) still requires
--    draft_warning_sent_at ≥ last activity and ≥ notice days ago, so a draft is
--    only ever deleted after a CONFIRMED send.
--
-- 5) release_warning(p_book uuid, p_kind text) → boolean — same signature,
--    replaced in place: clears *_warning_claimed_at (failed / unsent email) so
--    the next run claims it again. sent_at is not touched.
--
-- All functions: SECURITY INVOKER, search_path '', EXECUTE for service_role
-- only (Supabase default privileges grant new public functions to
-- authenticated → revoked explicitly).
--
-- Deploy order: CODE FIRST, then this migration. The M9 review code calls
-- confirm_warning and treats PGRST202 (function missing) as "1600 semantics"
-- (claim = sent), so it works against a database without 1800. The OLD code
-- against 1800 would never confirm → expiry / draft warnings re-sent daily and
-- drafts never deleted (safe, but noisy). Apply → supabase/tests/rls_check.sql.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) books: claim columns (server-only)
-- ---------------------------------------------------------------------------
alter table public.books
  add column expiry_warning_claimed_at timestamptz,
  add column draft_warning_claimed_at  timestamptz;

-- Same as 1600, plus expiry_warning_claimed_at / draft_warning_claimed_at.
--
-- Must stay SECURITY INVOKER: the privilege check is `current_user` (see the
-- full rationale in 20261108000100_init_schema.sql).
--
-- WARNING: any future SECURITY DEFINER function owned by postgres that writes
-- to public.books bypasses this guard (inside it current_user = the owner,
-- postgres). Such functions must enforce these rules themselves.
create or replace function private.protect_book_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.is_paid                   := false;
    new.max_pages                 := 20;
    new.expires_at                := null;
    new.slug                      := null;
    new.published_at              := null;
    new.ai_status                 := 'idle';
    new.doc                       := '{}'::jsonb;
    new.page_count                := 0;
    new.doc_rev                   := 0;
    new.published_doc             := null;
    new.published_rev             := null;
    new.last_published_at         := null;
    new.password_hash             := null;
    new.expiry_warning_sent_at    := null;
    new.draft_warning_sent_at     := null;
    new.expiry_warning_claimed_at := null;
    new.draft_warning_claimed_at  := null;
  elsif tg_op = 'UPDATE' then
    new.id                        := old.id;
    new.created_at                := old.created_at;
    new.is_paid                   := old.is_paid;
    new.max_pages                 := old.max_pages;
    new.expires_at                := old.expires_at;
    new.slug                      := old.slug;
    new.published_at              := old.published_at;
    new.user_id                   := old.user_id;
    new.ai_status                 := old.ai_status;
    new.doc                       := old.doc;
    new.page_count                := old.page_count;
    new.doc_rev                   := old.doc_rev;
    new.published_doc             := old.published_doc;
    new.published_rev             := old.published_rev;
    new.last_published_at         := old.last_published_at;
    new.password_hash             := old.password_hash;
    new.expiry_warning_sent_at    := old.expiry_warning_sent_at;
    new.draft_warning_sent_at     := old.draft_warning_sent_at;
    new.expiry_warning_claimed_at := old.expiry_warning_claimed_at;
    new.draft_warning_claimed_at  := old.draft_warning_claimed_at;
  end if;

  return new;
end;
$$;

revoke all on function private.protect_book_columns() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) books.updated_at: not bumped by warning-column-only updates
-- ---------------------------------------------------------------------------
create or replace function private.set_book_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Cheap test first: the whole-row comparison only runs when a warning column changed.
  if (new.expiry_warning_sent_at is distinct from old.expiry_warning_sent_at
      or new.draft_warning_sent_at is distinct from old.draft_warning_sent_at
      or new.expiry_warning_claimed_at is distinct from old.expiry_warning_claimed_at
      or new.draft_warning_claimed_at is distinct from old.draft_warning_claimed_at)
     and (to_jsonb(new) - array['expiry_warning_sent_at', 'draft_warning_sent_at',
                                'expiry_warning_claimed_at', 'draft_warning_claimed_at', 'updated_at'])
       = (to_jsonb(old) - array['expiry_warning_sent_at', 'draft_warning_sent_at',
                                'expiry_warning_claimed_at', 'draft_warning_claimed_at', 'updated_at']) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.set_book_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3a) claim_expiry_warnings — claims, never marks sent
-- ---------------------------------------------------------------------------
create or replace function public.claim_expiry_warnings(
  p_limit       integer,
  p_days_before integer
)
returns table (
  book_id    uuid,
  user_id    uuid,
  email      text,
  title      text,
  expires_at timestamptz,
  is_live    boolean
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_limit is null or p_days_before is null
     or p_limit < 1 or p_limit > 1000 or p_days_before < 1 or p_days_before > 30 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  return query
    with c as (
      select b.id
        from public.books as b
       where not b.is_paid
         and b.published_at is not null
         and b.expires_at is not null
         and b.expires_at > now()
         and b.expires_at <= now() + make_interval(days => p_days_before)
         and b.expiry_warning_sent_at is null
         and (b.expiry_warning_claimed_at is null or b.expiry_warning_claimed_at < now() - interval '1 hour')
         and coalesce((select pr.email_reminders from public.profiles as pr where pr.id = b.user_id), true)
         and private.auth_user_email(b.user_id) is not null
         and not exists (
           select 1 from public.orders as o
            where o.book_id = b.id
              and o.status in ('pending', 'paid', 'needs_review', 'disputed')
         )
       order by b.expires_at, b.id
       limit p_limit
       for update of b skip locked
    ),
    u as (
      update public.books as b
         set expiry_warning_claimed_at = now()
        from c
       where b.id = c.id
         and b.expiry_warning_sent_at is null
         and (b.expiry_warning_claimed_at is null or b.expiry_warning_claimed_at < now() - interval '1 hour')
         and not b.is_paid
      returning b.id as bid, b.user_id as uid, b.title as t, b.expires_at as exp,
                (b.published_doc is not null) as live
    )
    select u.bid, u.uid, private.auth_user_email(u.uid), u.t, u.exp, u.live
      from u;
end;
$$;

revoke all on function public.claim_expiry_warnings(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_expiry_warnings(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3b) claim_draft_warnings — claims, never marks sent
-- ---------------------------------------------------------------------------
create or replace function public.claim_draft_warnings(
  p_limit       integer,
  p_warn_days   integer,
  p_delete_days integer
)
returns table (
  book_id          uuid,
  user_id          uuid,
  email            text,
  title            text,
  last_activity_at timestamptz,
  delete_after     timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_limit is null or p_warn_days is null or p_delete_days is null
     or p_limit < 1 or p_limit > 1000 or p_warn_days < 1
     or p_delete_days <= p_warn_days or p_delete_days > 36500 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  return query
    with c as (
      select b.id, a.last_at
        from public.books as b
        cross join lateral (
          select greatest(b.updated_at, (select max(p.created_at) from public.photos as p where p.book_id = b.id)) as last_at
        ) as a
       where not b.is_paid
         and b.expires_at is null
         and b.published_at is null
         and exists (select 1 from public.photos as p where p.book_id = b.id)
         and a.last_at < now() - make_interval(days => p_warn_days)
         and (b.draft_warning_sent_at is null or b.draft_warning_sent_at < a.last_at)
         and (b.draft_warning_claimed_at is null or b.draft_warning_claimed_at < now() - interval '1 hour')
         and coalesce((select pr.email_reminders from public.profiles as pr where pr.id = b.user_id), true)
         and private.auth_user_email(b.user_id) is not null
         and not exists (
           select 1 from public.orders as o
            where o.book_id = b.id
              and o.status in ('pending', 'paid', 'needs_review', 'disputed')
         )
       order by a.last_at, b.id
       limit p_limit
       for update of b skip locked
    ),
    u as (
      update public.books as b
         set draft_warning_claimed_at = now()
        from c
       where b.id = c.id
         and (b.draft_warning_sent_at is null or b.draft_warning_sent_at < c.last_at)
         and (b.draft_warning_claimed_at is null or b.draft_warning_claimed_at < now() - interval '1 hour')
         and not b.is_paid
         and b.published_at is null
      returning b.id as bid, b.user_id as uid, b.title as t, c.last_at as last_at
    )
    select u.bid, u.uid, private.auth_user_email(u.uid), u.t, u.last_at,
           greatest(u.last_at + make_interval(days => p_delete_days),
                    now() + make_interval(days => p_delete_days - p_warn_days))
      from u;
end;
$$;

revoke all on function public.claim_draft_warnings(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_draft_warnings(integer, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4) confirm_warning — the email went out: claim becomes "sent"
-- ---------------------------------------------------------------------------
create or replace function public.confirm_warning(p_book uuid, p_kind text)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_book is null or p_kind is null or p_kind not in ('expiry', 'draft') then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  if p_kind = 'expiry' then
    update public.books as b
       set expiry_warning_sent_at    = b.expiry_warning_claimed_at,
           expiry_warning_claimed_at = null
     where b.id = p_book
       and b.expiry_warning_claimed_at is not null;
  else
    update public.books as b
       set draft_warning_sent_at    = b.draft_warning_claimed_at,
           draft_warning_claimed_at = null
     where b.id = p_book
       and b.draft_warning_claimed_at is not null;
  end if;

  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke all on function public.confirm_warning(uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_warning(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5) release_warning — clears the claim (email failed / never started)
-- ---------------------------------------------------------------------------
create or replace function public.release_warning(p_book uuid, p_kind text)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_book is null or p_kind is null or p_kind not in ('expiry', 'draft') then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  if p_kind = 'expiry' then
    update public.books as b
       set expiry_warning_claimed_at = null
     where b.id = p_book
       and b.expiry_warning_claimed_at is not null;
  else
    update public.books as b
       set draft_warning_claimed_at = null
     where b.id = p_book
       and b.draft_warning_claimed_at is not null;
  end if;

  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke all on function public.release_warning(uuid, text) from public, anon, authenticated;
grant execute on function public.release_warning(uuid, text) to service_role;
