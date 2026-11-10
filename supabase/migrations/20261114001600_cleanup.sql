-- =============================================================================
-- 20261114001600_cleanup.sql — Milestone 9: data retention + housekeeping
-- (D-055 retention, D-056 daily cron, D-057 warning emails, D-059 AI spend,
--  D-051 amendment: old superseded / failed export rows may be deleted)
--
-- Additive only: 0100–1500 are applied in production and must not be edited.
-- The windows are arguments; the cron passes the constants of
-- src/lib/cleanup/rules.ts (FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY 14,
-- DRAFT_IDLE_DAYS 45, DRAFT_WARNING_DAYS 38, DRAFT_NOTICE_DAYS 7,
-- PENDING_UPLOAD_DAYS 7, ORPHAN_OBJECT_DAYS 7, OLD_EXPORT_ROW_DAYS 30,
-- UNLOCK_ATTEMPT_HOURS 24, STALE_AGENT_RUN_HOURS 1, EXPIRY_WARNING_DAYS_BEFORE 3).
--
-- 1) books.expiry_warning_sent_at / books.draft_warning_sent_at timestamptz —
--    SERVER-ONLY: private.protect_book_columns (latest = 1000) gains both
--    (null on INSERT, old value on UPDATE for non-privileged callers). The
--    guard stays SECURITY INVOKER (current_user check, see 0100). No current
--    code writes them, so nothing silently stops working.
--
-- 2) books.updated_at is NOT bumped by an update that changes only the two
--    warning columns: books_set_updated_at now runs private.set_book_updated_at
--    (create or replace trigger → same name, so the BEFORE trigger order is
--    unchanged: books_protect_columns < books_set_doc_rev < books_set_updated_at).
--    Without this, claiming a draft warning would reset the draft's idle clock
--    and the draft would never be deleted.
--
-- 3) profiles.email_reminders boolean not null default true — the owner may
--    toggle it: profiles already has table-level UPDATE for authenticated
--    (0300) + profiles_update_own (own row only, 0100). false → no expiry /
--    draft warning emails are claimed for that user (account emails unaffected).
--
-- 4) private.auth_user_email(p_user uuid) returns text — SECURITY DEFINER
--    (owner = migration role) so the service-role claim functions can read
--    auth.users.email without granting service_role anything on schema auth.
--    EXECUTE for service_role only. Returns null for unknown users / empty email.
--
-- 5) Service-role-only housekeeping RPCs (all SECURITY INVOKER, search_path '',
--    EXECUTE revoked from public / anon / authenticated, granted to service_role).
--    "Protected" book = is_paid, OR any order of the book in status pending /
--    paid / needs_review / disputed (money in flight or taken, or a human must
--    look at it). No delete / claim function ever returns a protected book.
--    Argument errors raise 'invalid_argument' (22023).
--
--    cleanup_delete_expired_books(p_limit int, p_grace_days int)
--      → table(user_id uuid, book_id uuid)
--      Deletes up to p_limit free books whose expires_at < now() - p_grace_days
--      (oldest first). Candidates are locked FOR UPDATE SKIP LOCKED in one
--      statement and re-checked in a SECOND statement (fresh snapshot; the row
--      locks block new orders, whose FK takes KEY SHARE on the book), so an
--      order committed between the two can't be missed. Cascades: photos,
--      exports, unlock attempts; agent_runs / orders keep their rows with
--      book_id null (0600 scrub). Returned pairs = Storage prefixes
--      {user_id}/{book_id}/ in buckets photos + exports, which the caller removes.
--      p_limit 1..1000, p_grace_days 1..36500.
--
--    cleanup_delete_abandoned_drafts(p_limit int, p_days int, p_notice_days int)
--      → table(user_id uuid, book_id uuid)
--      Free books never published (expires_at null, published_at null) whose
--      last activity = greatest(updated_at, newest photo created_at) is older
--      than p_days, AND one of:
--        * the book has no photos (nothing worth an email), or
--        * the owner can't be emailed (email_reminders false or no email), or
--        * a draft warning was claimed AFTER the last activity and at least
--          p_notice_days ago.
--      So an emailable owner always gets the full notice period, even for drafts
--      already older than p_days when this ships or after a cron outage; if
--      warnings are never sent (email off), such drafts are never deleted
--      (fail safe). Same locking / re-check as above.
--      p_limit 1..1000, p_days 1..36500, p_notice_days 0..p_days.
--
--    cleanup_pending_uploads(p_limit int, p_days int)
--      → table(user_id uuid, book_id uuid, photo_id uuid, paths text[])
--      Deletes up to p_limit photo rows still upload_state 'pending' created
--      more than p_days ago (oldest first, SKIP LOCKED). paths = the object
--      names to remove from bucket photos: the row's non-null path columns plus
--      the existing objects among {user}/{book}/{id}-original.(jpg|png|webp),
--      -web.jpg, -thumb.jpg (pending rows have null paths but may have objects).
--      p_limit 1..1000, p_days 1..36500.
--
--    cleanup_orphan_objects(p_bucket text, p_days int, p_limit int)
--      → table(name text)
--      Read-only. Up to p_limit object names in storage.objects of bucket
--      'photos' or 'exports' created more than p_days ago (oldest first) with
--      no owning row:
--        photos:  name must be {user}/{book}/{photo}-(original.(jpg|png|webp)|
--                 web.jpg|thumb.jpg) AND a photos row with that id, user and
--                 book must exist AND (it is still pending OR name is one of
--                 its three paths); anything else is an orphan.
--        exports: name must be {user}/{book}/{export}.pdf AND an exports row
--                 with that id and path = name must exist.
--      A book's prefix without a book has no rows, so it is covered too. SQL
--      never deletes storage rows: the caller removes them via the Storage API.
--      p_days 1..36500, p_limit 1..1000.
--
--    cleanup_old_exports(p_days int) → integer
--      Deletes exports rows with status superseded / failed, path null,
--      finished_at < now() - p_days. Safe for the D-051 daily cap (it counts
--      rows created in the last 24 h; finished_at ≥ created_at). Never touches
--      queued / rendering / ready rows. p_days 1..36500.
--
--    cleanup_unlock_attempts(p_hours int) → integer
--      Deletes book_unlock_attempts older than p_hours. p_hours 24..8760
--      (try_book_unlock windows go up to 24 h, so a shorter value would weaken
--      the rate limit).
--
--    reap_stale_agent_runs(p_hours int) → integer
--      Marks unfinished agent_runs failed (ai_status failed, error_code
--      'stale', finished_at now(), lease cleared, progress.phase 'failed'):
--        * build / rebuild: no activity (updated_at) for p_hours AND no live
--          lease (lease_until null or past) — a tick holding a lease is never
--          reaped; the row lock + re-check makes it race-free with
--          claim_agent_run;
--        * rewrite ('rewriting'): started more than p_hours ago (their own
--          5-minute rule in create_rewrite_run_capped stays in charge; this
--          only sweeps rows no later rewrite of the book reaped).
--      Then, in a separate statement, books left in a running ai_status
--      (analyzing / planning / captioning) by a reaped build run and with no
--      other active build run get a settled status like the orchestrator's
--      crash(): 'failed' when the doc has no pages, else the run cursor's
--      prevBookStatus when it is idle/done/partial/failed, else 'idle'.
--      Returns the number of runs reaped. p_hours 1..720.
--
--    claim_expiry_warnings(p_limit int, p_days_before int)
--      → table(book_id uuid, user_id uuid, email text, title text,
--              expires_at timestamptz, is_live boolean)
--      Free published books (not protected) with now() < expires_at ≤ now() +
--      p_days_before, expiry_warning_sent_at null, owner email_reminders true
--      and an email. Atomically sets expiry_warning_sent_at = now() (claim;
--      SKIP LOCKED + re-check → never claimed twice). Already-expired books are
--      never claimed ("expires in 3 days" would be false). is_live =
--      published_doc is not null. p_limit 1..1000, p_days_before 1..30.
--
--    claim_draft_warnings(p_limit int, p_warn_days int, p_delete_days int)
--      → table(book_id uuid, user_id uuid, email text, title text,
--              last_activity_at timestamptz, delete_after timestamptz)
--      Never-published free drafts (not protected) with at least one photo,
--      idle for more than p_warn_days, not yet warned since their last activity
--      (draft_warning_sent_at null or < last activity), owner email_reminders
--      true and an email. Sets draft_warning_sent_at = now(). delete_after =
--      greatest(last activity + p_delete_days, now() + (p_delete_days -
--      p_warn_days)) — the earliest moment cleanup_delete_abandoned_drafts
--      (called with p_notice_days = p_delete_days - p_warn_days) can delete it.
--      p_limit 1..1000, 1 ≤ p_warn_days < p_delete_days ≤ 36500.
--
--    release_warning(p_book uuid, p_kind text) → boolean
--      Clears expiry_warning_sent_at (p_kind 'expiry') or draft_warning_sent_at
--      ('draft') after a failed send, so the next run claims it again. true when
--      a claim was cleared.
--
--    admin_ai_spend_daily(p_days int)
--      → table(day date, usd numeric, runs integer, failed integer,
--              build_usd numeric, rewrite_usd numeric, null_book_runs integer)
--      One row per Asia/Dubai calendar day for the last p_days days (today
--      included, newest first, zero rows filled in), from agent_runs by
--      started_at: total cost, run count, failed runs, build+rebuild cost,
--      rewrite cost, runs whose book was deleted. p_days 1..366.
--
-- 6) Partial indexes for the sweeps.
--
-- Lock / key spaces: no advisory locks here (row locks only).
--
-- Deploy: safe to apply BEFORE the M9 code (new columns are server-only and
-- unread; new functions are uncalled; the updated_at change only affects
-- updates of the new columns). Apply → run supabase/tests/rls_check.sql → code.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) books: warning claim columns (server-only)
-- ---------------------------------------------------------------------------
alter table public.books
  add column expiry_warning_sent_at timestamptz,
  add column draft_warning_sent_at  timestamptz;

-- Same as 1000, plus expiry_warning_sent_at / draft_warning_sent_at.
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
    new.is_paid                := false;
    new.max_pages              := 20;
    new.expires_at             := null;
    new.slug                   := null;
    new.published_at           := null;
    new.ai_status              := 'idle';
    new.doc                    := '{}'::jsonb;
    new.page_count             := 0;
    new.doc_rev                := 0;
    new.published_doc          := null;
    new.published_rev          := null;
    new.last_published_at      := null;
    new.password_hash          := null;
    new.expiry_warning_sent_at := null;
    new.draft_warning_sent_at  := null;
  elsif tg_op = 'UPDATE' then
    new.id                     := old.id;
    new.created_at             := old.created_at;
    new.is_paid                := old.is_paid;
    new.max_pages              := old.max_pages;
    new.expires_at             := old.expires_at;
    new.slug                   := old.slug;
    new.published_at           := old.published_at;
    new.user_id                := old.user_id;
    new.ai_status              := old.ai_status;
    new.doc                    := old.doc;
    new.page_count             := old.page_count;
    new.doc_rev                := old.doc_rev;
    new.published_doc          := old.published_doc;
    new.published_rev          := old.published_rev;
    new.last_published_at      := old.last_published_at;
    new.password_hash          := old.password_hash;
    new.expiry_warning_sent_at := old.expiry_warning_sent_at;
    new.draft_warning_sent_at  := old.draft_warning_sent_at;
  end if;

  return new;
end;
$$;

revoke all on function private.protect_book_columns() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) books.updated_at: not bumped by warning-claim-only updates
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
      or new.draft_warning_sent_at is distinct from old.draft_warning_sent_at)
     and (to_jsonb(new) - array['expiry_warning_sent_at', 'draft_warning_sent_at', 'updated_at'])
       = (to_jsonb(old) - array['expiry_warning_sent_at', 'draft_warning_sent_at', 'updated_at']) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.set_book_updated_at() from public, anon, authenticated;

-- Same name as 0100's trigger → same (alphabetical) firing position.
create or replace trigger books_set_updated_at
  before update on public.books
  for each row execute function private.set_book_updated_at();

-- ---------------------------------------------------------------------------
-- 3) profiles.email_reminders (owner-writable through 0100/0300 policy + grant)
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column email_reminders boolean not null default true;

-- ---------------------------------------------------------------------------
-- 4) private.auth_user_email — DEFINER read of auth.users.email
-- ---------------------------------------------------------------------------
create or replace function private.auth_user_email(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(btrim(u.email::text), '')
    from auth.users as u
   where u.id = p_user;
$$;

revoke all on function private.auth_user_email(uuid) from public, anon, authenticated;
grant execute on function private.auth_user_email(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5a) cleanup_delete_expired_books
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_delete_expired_books(
  p_limit      integer,
  p_grace_days integer
)
returns table (user_id uuid, book_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if p_limit is null or p_grace_days is null
     or p_limit < 1 or p_limit > 1000 or p_grace_days < 1 or p_grace_days > 36500 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  select array_agg(c.id) into v_ids
    from (
      select b.id
        from public.books as b
       where not b.is_paid
         and b.expires_at is not null
         and b.expires_at < now() - make_interval(days => p_grace_days)
         and not exists (
           select 1 from public.orders as o
            where o.book_id = b.id
              and o.status in ('pending', 'paid', 'needs_review', 'disputed')
         )
       order by b.expires_at, b.id
       limit p_limit
       for update of b skip locked
    ) as c;

  if v_ids is null then
    return;
  end if;

  -- Second statement = fresh snapshot; the rows are locked, so no new order can
  -- reference them before we delete.
  return query
    with d as (
      delete from public.books as b
       where b.id = any (v_ids)
         and not b.is_paid
         and b.expires_at is not null
         and b.expires_at < now() - make_interval(days => p_grace_days)
         and not exists (
           select 1 from public.orders as o
            where o.book_id = b.id
              and o.status in ('pending', 'paid', 'needs_review', 'disputed')
         )
      returning b.user_id as uid, b.id as bid
    )
    select d.uid, d.bid from d;
end;
$$;

revoke all on function public.cleanup_delete_expired_books(integer, integer) from public, anon, authenticated;
grant execute on function public.cleanup_delete_expired_books(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5b) cleanup_delete_abandoned_drafts
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_delete_abandoned_drafts(
  p_limit       integer,
  p_days        integer,
  p_notice_days integer
)
returns table (user_id uuid, book_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if p_limit is null or p_days is null or p_notice_days is null
     or p_limit < 1 or p_limit > 1000 or p_days < 1 or p_days > 36500
     or p_notice_days < 0 or p_notice_days > p_days then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  select array_agg(c.id) into v_ids
    from (
      select b.id
        from public.books as b
        cross join lateral (
          select greatest(b.updated_at, (select max(p.created_at) from public.photos as p where p.book_id = b.id)) as last_at,
                 exists (select 1 from public.photos as p where p.book_id = b.id) as has_photos
        ) as a
       where not b.is_paid
         and b.expires_at is null
         and b.published_at is null
         and a.last_at < now() - make_interval(days => p_days)
         and not exists (
           select 1 from public.orders as o
            where o.book_id = b.id
              and o.status in ('pending', 'paid', 'needs_review', 'disputed')
         )
         and (
           not a.has_photos
           or not coalesce((select pr.email_reminders from public.profiles as pr where pr.id = b.user_id), true)
           or private.auth_user_email(b.user_id) is null
           or (b.draft_warning_sent_at is not null
               and b.draft_warning_sent_at >= a.last_at
               and b.draft_warning_sent_at <= now() - make_interval(days => p_notice_days))
         )
       order by a.last_at, b.id
       limit p_limit
       for update of b skip locked
    ) as c;

  if v_ids is null then
    return;
  end if;

  return query
    with d as (
      delete from public.books as b
       where b.id = any (v_ids)
         and not b.is_paid
         and b.expires_at is null
         and b.published_at is null
         and greatest(b.updated_at, (select max(p.created_at) from public.photos as p where p.book_id = b.id))
             < now() - make_interval(days => p_days)
         and not exists (
           select 1 from public.orders as o
            where o.book_id = b.id
              and o.status in ('pending', 'paid', 'needs_review', 'disputed')
         )
      returning b.user_id as uid, b.id as bid
    )
    select d.uid, d.bid from d;
end;
$$;

revoke all on function public.cleanup_delete_abandoned_drafts(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.cleanup_delete_abandoned_drafts(integer, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5c) cleanup_pending_uploads
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_pending_uploads(
  p_limit integer,
  p_days  integer
)
returns table (user_id uuid, book_id uuid, photo_id uuid, paths text[])
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if p_limit is null or p_days is null
     or p_limit < 1 or p_limit > 1000 or p_days < 1 or p_days > 36500 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  select array_agg(c.id) into v_ids
    from (
      select p.id
        from public.photos as p
       where p.upload_state = 'pending'
         and p.created_at < now() - make_interval(days => p_days)
       order by p.created_at, p.id
       limit p_limit
       for update of p skip locked
    ) as c;

  if v_ids is null then
    return;
  end if;

  return query
    with d as (
      delete from public.photos as p
       where p.id = any (v_ids)
         and p.upload_state = 'pending'
      returning p.id, p.user_id, p.book_id, p.original_path, p.web_path, p.thumb_path
    )
    select d.user_id, d.book_id, d.id,
           coalesce((
             select array_agg(distinct x.n order by x.n)
               from (
                 select unnest(array[d.original_path, d.web_path, d.thumb_path]) as n
                 union
                 select o.name
                   from storage.objects as o
                  where o.bucket_id = 'photos'
                    and o.name = any (array[
                      d.user_id::text || '/' || d.book_id::text || '/' || d.id::text || '-original.jpg',
                      d.user_id::text || '/' || d.book_id::text || '/' || d.id::text || '-original.png',
                      d.user_id::text || '/' || d.book_id::text || '/' || d.id::text || '-original.webp',
                      d.user_id::text || '/' || d.book_id::text || '/' || d.id::text || '-web.jpg',
                      d.user_id::text || '/' || d.book_id::text || '/' || d.id::text || '-thumb.jpg'
                    ])
               ) as x
              where x.n is not null
           ), array[]::text[])
      from d;
end;
$$;

revoke all on function public.cleanup_pending_uploads(integer, integer) from public, anon, authenticated;
grant execute on function public.cleanup_pending_uploads(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5d) cleanup_orphan_objects (read-only; the caller deletes via Storage API)
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_orphan_objects(
  p_bucket text,
  p_days   integer,
  p_limit  integer
)
returns table (name text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_bucket is null or p_days is null or p_limit is null
     or p_bucket not in ('photos', 'exports')
     or p_days < 1 or p_days > 36500 or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  if p_bucket = 'photos' then
    return query
      select o.name::text
        from storage.objects as o
        left join lateral (
          select regexp_match(
            o.name,
            '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(original\.(jpg|png|webp)|web\.jpg|thumb\.jpg)$'
          ) as m
        ) as k on true
       where o.bucket_id = 'photos'
         and o.created_at < now() - make_interval(days => p_days)
         and not exists (
           select 1
             from public.photos as p
            where k.m is not null
              and p.id = k.m[3]::uuid
              and p.user_id = k.m[1]::uuid
              and p.book_id = k.m[2]::uuid
              and (p.upload_state = 'pending' or o.name in (p.original_path, p.web_path, p.thumb_path))
         )
       order by o.created_at, o.name
       limit p_limit;
  else
    return query
      select o.name::text
        from storage.objects as o
        left join lateral (
          select regexp_match(
            o.name,
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf$'
          ) as m
        ) as k on true
       where o.bucket_id = 'exports'
         and o.created_at < now() - make_interval(days => p_days)
         and not exists (
           select 1
             from public.exports as e
            where k.m is not null
              and e.id = k.m[1]::uuid
              and e.path = o.name
         )
       order by o.created_at, o.name
       limit p_limit;
  end if;
end;
$$;

revoke all on function public.cleanup_orphan_objects(text, integer, integer) from public, anon, authenticated;
grant execute on function public.cleanup_orphan_objects(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5e) cleanup_old_exports (D-051 amended)
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_old_exports(p_days integer)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_days is null or p_days < 1 or p_days > 36500 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  delete from public.exports as e
   where e.status in ('superseded', 'failed')
     and e.path is null
     and e.finished_at is not null
     and e.finished_at < now() - make_interval(days => p_days);

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.cleanup_old_exports(integer) from public, anon, authenticated;
grant execute on function public.cleanup_old_exports(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5f) cleanup_unlock_attempts
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_unlock_attempts(p_hours integer)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_hours is null or p_hours < 24 or p_hours > 8760 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  delete from public.book_unlock_attempts as a
   where a.created_at < now() - make_interval(hours => p_hours);

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.cleanup_unlock_attempts(integer) from public, anon, authenticated;
grant execute on function public.cleanup_unlock_attempts(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5g) reap_stale_agent_runs
-- ---------------------------------------------------------------------------
create or replace function public.reap_stale_agent_runs(p_hours integer)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n     integer;
  v_books uuid[];
  v_prev  text[];
begin
  if p_hours is null or p_hours < 1 or p_hours > 720 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  with reaped as (
    update public.agent_runs as r
       set state       = 'failed',
           ai_status   = 'failed',
           error_code  = 'stale',
           finished_at = now(),
           lease_until = null,
           lease_token = null,
           progress    = case
                           when jsonb_typeof(r.progress) = 'object'
                             then r.progress || '{"phase":"failed"}'::jsonb
                           else r.progress
                         end
     where r.state not in ('done', 'failed')
       and (r.lease_until is null or r.lease_until < now())
       and (
         (r.trigger in ('build', 'rebuild') and r.updated_at < now() - make_interval(hours => p_hours))
         or (r.trigger = 'rewrite' and r.started_at < now() - make_interval(hours => p_hours))
       )
    returning r.book_id, r.trigger, r.cursor ->> 'prevBookStatus' as prev
  )
  select count(*)::integer,
         array_agg(x.book_id) filter (where x.trigger <> 'rewrite' and x.book_id is not null),
         array_agg(x.prev)    filter (where x.trigger <> 'rewrite' and x.book_id is not null)
    into v_n, v_books, v_prev
    from reaped as x;

  if v_books is null then
    return v_n;
  end if;

  -- Separate statement (fresh snapshot): sees the runs just failed above.
  update public.books as b
     set ai_status = case
                       when coalesce(jsonb_typeof(b.doc -> 'pages'), '') <> 'array' then 'failed'
                       when jsonb_array_length(b.doc -> 'pages') = 0 then 'failed'
                       when s.prev in ('idle', 'done', 'partial', 'failed') then s.prev
                       else 'idle'
                     end
    from (
      select distinct on (u.bid) u.bid, u.prev
        from unnest(v_books, v_prev) as u (bid, prev)
       order by u.bid
    ) as s
   where b.id = s.bid
     and b.ai_status in ('analyzing', 'planning', 'captioning')
     and not exists (
       select 1 from public.agent_runs as a
        where a.book_id = b.id
          and a.trigger in ('build', 'rebuild')
          and a.state not in ('done', 'failed')
     );

  return v_n;
end;
$$;

revoke all on function public.reap_stale_agent_runs(integer) from public, anon, authenticated;
grant execute on function public.reap_stale_agent_runs(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5h) claim_expiry_warnings
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
         set expiry_warning_sent_at = now()
        from c
       where b.id = c.id
         and b.expiry_warning_sent_at is null
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
-- 5i) claim_draft_warnings
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
         set draft_warning_sent_at = now()
        from c
       where b.id = c.id
         and (b.draft_warning_sent_at is null or b.draft_warning_sent_at < c.last_at)
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
-- 5j) release_warning
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
       set expiry_warning_sent_at = null
     where b.id = p_book
       and b.expiry_warning_sent_at is not null;
  else
    update public.books as b
       set draft_warning_sent_at = null
     where b.id = p_book
       and b.draft_warning_sent_at is not null;
  end if;

  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke all on function public.release_warning(uuid, text) from public, anon, authenticated;
grant execute on function public.release_warning(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5k) admin_ai_spend_daily (D-059; admin page reads it with the admin client)
-- ---------------------------------------------------------------------------
create or replace function public.admin_ai_spend_daily(p_days integer)
returns table (
  day            date,
  usd            numeric,
  runs           integer,
  failed         integer,
  build_usd      numeric,
  rewrite_usd    numeric,
  null_book_runs integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_today date;
begin
  if p_days is null or p_days < 1 or p_days > 366 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  v_today := (now() at time zone 'Asia/Dubai')::date;

  return query
    select g.d,
           coalesce(sum(r.total_cost_usd), 0)::numeric,
           count(r.id)::integer,
           (count(r.id) filter (where r.state = 'failed'))::integer,
           coalesce(sum(r.total_cost_usd) filter (where r.trigger in ('build', 'rebuild')), 0)::numeric,
           coalesce(sum(r.total_cost_usd) filter (where r.trigger = 'rewrite'), 0)::numeric,
           (count(r.id) filter (where r.book_id is null))::integer
      from (
        select (v_today - s.i) as d
          from generate_series(0, p_days - 1) as s (i)
      ) as g
      left join public.agent_runs as r
        on r.started_at >= (g.d::timestamp at time zone 'Asia/Dubai')
       and r.started_at <  ((g.d + 1)::timestamp at time zone 'Asia/Dubai')
     group by g.d
     order by g.d desc;
end;
$$;

revoke all on function public.admin_ai_spend_daily(integer) from public, anon, authenticated;
grant execute on function public.admin_ai_spend_daily(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6) Indexes for the sweeps
-- ---------------------------------------------------------------------------
create index books_free_expires_at_idx on public.books (expires_at)
  where not is_paid and expires_at is not null;
create index books_free_drafts_idx on public.books (updated_at)
  where not is_paid and expires_at is null and published_at is null;
create index photos_pending_created_at_idx on public.photos (created_at)
  where upload_state = 'pending';
create index photos_book_id_created_at_idx on public.photos (book_id, created_at);
create index agent_runs_active_updated_at_idx on public.agent_runs (updated_at)
  where state not in ('done', 'failed');
create index agent_runs_started_at_idx on public.agent_runs (started_at);
create index exports_finished_old_idx on public.exports (finished_at)
  where status in ('superseded', 'failed');
create index book_unlock_attempts_created_at_idx on public.book_unlock_attempts (created_at);
