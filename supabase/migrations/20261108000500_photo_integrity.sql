-- =============================================================================
-- 20261108000500_photo_integrity.sql — Milestone 2 review fixes (S2, S3, S4)
--
-- Additive only: 0100–0400 are applied in prod and must not be edited.
-- Prod public.photos is empty (T13 cleaned up), so every new CHECK validates
-- trivially; the ready-row CHECK still uses NOT VALID + VALIDATE as a habit.
--
-- 1) photos integrity CHECKs (S3)
--      * a `ready` row has all three paths, positive dimensions, mime and bytes
--      * ai jsonb ≤ 16 KiB, phash = 16 lowercase hex (dhash), width/height
--        1..20000, blur_score ≥ 0
-- 2) photos path format CHECKs (S4): paths must be exactly
--      {user_id}/{book_id}/{id}-original.(jpg|png|webp)
--      {user_id}/{book_id}/{id}-web.jpg
--      {user_id}/{book_id}/{id}-thumb.jpg
--    uuid text is [0-9a-f-] only, so concatenating it into the regex is safe.
--    The 0300 photos_*_path_owner LIKE constraints stay (strictly weaker).
-- 3) photos.place_checked_at (S2): when finalize last attempted to geocode the
--    photo (whatever the result). Server-only.
-- 4) Server-only photo columns guard (S3, D-011 style) — see the function.
-- 5) Bucket `photos` accepts only image/jpeg|png|webp (HEIC is converted in the
--    browser, D-012). Enforced by the Storage API, not by SQL.
-- 6) storage.objects insert/update policies for bucket `photos` (S4): the object
--    name must be {uid}/{book}/{photo_id}-(original|web|thumb).ext AND the caller
--    must own a photo row with that id + book that is still `pending`.
--    → no uploads for non-existent photos, no overwrites after `ready`.
--    select/delete keep the 0200 own-folder policies.
-- 7) Finalize rate limit + Mapbox daily cap (S2): private.finalize_runs, written
--    only through two service-role-only RPCs.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) + 3) photos integrity CHECKs and place_checked_at
-- ---------------------------------------------------------------------------
alter table public.photos
  add column place_checked_at timestamptz,
  add constraint photos_ai_size check (pg_column_size(ai) <= 16384),
  add constraint photos_phash_format check (phash is null or phash ~ '^[0-9a-f]{16}$'),
  add constraint photos_width_range check (width between 1 and 20000),
  add constraint photos_height_range check (height between 1 and 20000),
  add constraint photos_blur_score_check check (blur_score >= 0);

alter table public.photos
  add constraint photos_ready_complete check (
    upload_state <> 'ready'
    or (
      original_path is not null
      and web_path is not null
      and thumb_path is not null
      and width > 0
      and height > 0
      and original_mime is not null
      and original_bytes > 0
    )
  ) not valid;

alter table public.photos validate constraint photos_ready_complete;

-- ---------------------------------------------------------------------------
-- 2) Path format CHECKs
-- ---------------------------------------------------------------------------
alter table public.photos
  add constraint photos_original_path_format check (
    original_path is null
    or original_path ~ ('^' || user_id::text || '/' || book_id::text || '/' || id::text
                        || '-original\.(jpg|png|webp)$')
  ),
  add constraint photos_web_path_format check (
    web_path is null
    or web_path ~ ('^' || user_id::text || '/' || book_id::text || '/' || id::text || '-web\.jpg$')
  ),
  add constraint photos_thumb_path_format check (
    thumb_path is null
    or thumb_path ~ ('^' || user_id::text || '/' || book_id::text || '/' || id::text || '-thumb\.jpg$')
  );

-- ---------------------------------------------------------------------------
-- 4) Guard server-only photo columns.
--
-- Same privilege model as private.protect_book_columns (0100/0300): MUST stay
-- SECURITY INVOKER — the check is `current_user`, which under SECURITY DEFINER
-- would be the owner (postgres) and let everyone through. Any future
-- postgres-owned SECURITY DEFINER function writing public.photos bypasses it.
--
-- Non-privileged callers (anon / authenticated):
--   INSERT: ai, dup_group, place, place_checked_at := null; status := 'kept';
--           drop_reason := null; user_override := false; created_at := now().
--   UPDATE: id, created_at, user_id, book_id, fingerprint are frozen;
--           ai, dup_group, place, place_checked_at keep their OLD values
--           (finalize writes dup_group / place / place_checked_at with the
--           service role, after checking ownership — src/lib/db/photos.ts);
--           once a row is `ready`: upload_state stays 'ready' (no ready →
--           pending) and the file columns (original/web/thumb path, mime,
--           bytes, width, height) are frozen — no overwrites after ready.
--   Left client-writable on purpose: status, drop_reason, user_override (the
--   user decides keep/drop in the M3 review — "AI drafts, the user decides"),
--   and the capture metadata (taken_at, date_source, lat, lng, camera, phash,
--   blur_score) the browser extracts before markReady.
--   NOTE (M3): AI usage counters (analysed photos, rebuilds, rewrites) must be
--   server-side only too — never on a client-writable column.
--
-- Becoming ready (INSERT as ready, or pending → ready) by a non-privileged
-- caller also requires the three objects to exist in bucket `photos` (checked
-- with the caller's own storage.objects visibility = own folder). Raised as
-- check_violation 'photo_files_missing'. Since storage writes need a pending
-- row (policy 6), a client can never insert a row directly as ready.
--
-- Trigger order: BEFORE triggers fire alphabetically, so photos_enforce_cap
-- (0400) runs before photos_protect_columns and still rejects a move of a
-- photo into a full book; a move into a non-full book is silently undone here.
-- ---------------------------------------------------------------------------
create or replace function private.protect_photo_columns()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_files integer;
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.ai               := null;
    new.dup_group        := null;
    new.place            := null;
    new.place_checked_at := null;
    new.status           := 'kept';
    new.drop_reason      := null;
    new.user_override    := false;
    new.created_at       := now();
  elsif tg_op = 'UPDATE' then
    new.id               := old.id;
    new.created_at       := old.created_at;
    new.user_id          := old.user_id;
    new.book_id          := old.book_id;
    new.fingerprint      := old.fingerprint;
    new.ai               := old.ai;
    new.dup_group        := old.dup_group;
    new.place            := old.place;
    new.place_checked_at := old.place_checked_at;
    if old.upload_state = 'ready' then
      new.upload_state   := 'ready';
      new.original_path  := old.original_path;
      new.web_path       := old.web_path;
      new.thumb_path     := old.thumb_path;
      new.original_mime  := old.original_mime;
      new.original_bytes := old.original_bytes;
      new.width          := old.width;
      new.height         := old.height;
    end if;
  end if;

  if new.upload_state = 'ready' and (tg_op = 'INSERT' or old.upload_state <> 'ready') then
    select count(*) into v_files
      from storage.objects as o
     where o.bucket_id = 'photos'
       and o.name in (new.original_path, new.web_path, new.thumb_path);
    if v_files < 3 then
      raise exception 'photo_files_missing' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger photos_protect_columns
  before insert or update on public.photos
  for each row execute function private.protect_photo_columns();

revoke all on function private.protect_photo_columns() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) Bucket mime types (HEIC/HEIF no longer accepted)
-- ---------------------------------------------------------------------------
update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'photos';

-- ---------------------------------------------------------------------------
-- 6) storage.objects write policies for bucket `photos`
--
-- The CASE makes sure the uuid casts only run on a name that matched the strict
-- pattern (CASE evaluates its WHEN before its THEN). The EXISTS runs with the
-- caller's privileges, so photos RLS (owner-only) applies inside it as well.
-- `objects.name` is qualified so a future photos.name column can't capture it.
-- ---------------------------------------------------------------------------
drop policy "photos_insert_own" on storage.objects;
drop policy "photos_update_own" on storage.objects;

create policy "photos_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and case
      when objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(original\.(jpg|png|webp)|web\.jpg|thumb\.jpg)$'
      then exists (
        select 1 from public.photos as p
         where p.id = left(split_part(objects.name, '/', 3), 36)::uuid
           and p.book_id = split_part(objects.name, '/', 2)::uuid
           and p.user_id = (select auth.uid())
           and p.upload_state = 'pending'
      )
      else false
    end
  );

create policy "photos_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and case
      when objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(original\.(jpg|png|webp)|web\.jpg|thumb\.jpg)$'
      then exists (
        select 1 from public.photos as p
         where p.id = left(split_part(objects.name, '/', 3), 36)::uuid
           and p.book_id = split_part(objects.name, '/', 2)::uuid
           and p.user_id = (select auth.uid())
           and p.upload_state = 'pending'
      )
      else false
    end
  )
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and case
      when objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(original\.(jpg|png|webp)|web\.jpg|thumb\.jpg)$'
      then exists (
        select 1 from public.photos as p
         where p.id = left(split_part(objects.name, '/', 3), 36)::uuid
           and p.book_id = split_part(objects.name, '/', 2)::uuid
           and p.user_id = (select auth.uid())
           and p.upload_state = 'pending'
      )
      else false
    end
  );

-- ---------------------------------------------------------------------------
-- 7) Finalize rate limit + daily geocode cap
--
-- private.finalize_runs is not exposed by PostgREST (schema private) and has
-- RLS on with no policies; only service_role gets table privileges (and
-- BYPASSRLS). Clients have no grants on it and no EXECUTE on the RPCs.
-- The two RPCs are SECURITY INVOKER (so they need the service role's own
-- privileges) and are only called by src/lib/db/finalize-runs.ts with the
-- admin client after finalizeBook has checked book ownership.
-- ---------------------------------------------------------------------------
create table private.finalize_runs (
  book_id             uuid primary key references public.books (id) on delete cascade,
  last_run_at         timestamptz not null,
  day                 date not null default ((now() at time zone 'utc')::date),
  geocode_calls_today integer not null default 0,
  constraint finalize_runs_geocode_calls_check check (geocode_calls_today >= 0)
);

alter table private.finalize_runs enable row level security;

revoke all on table private.finalize_runs from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on table private.finalize_runs to service_role;

-- Claims a finalize run for the book: returns 0 when claimed (last run was at
-- least p_min_interval_seconds ago, or never), else the seconds to wait.
-- Atomic: INSERT … ON CONFLICT DO UPDATE … WHERE locks the row; concurrent
-- callers serialise and only one of them gets the row back.
create or replace function public.claim_finalize_run(p_book_id uuid, p_min_interval_seconds integer)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_claimed boolean;
  v_last    timestamptz;
begin
  if p_book_id is null or p_min_interval_seconds is null
     or p_min_interval_seconds < 0 or p_min_interval_seconds > 3600 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  insert into private.finalize_runs as r (book_id, last_run_at)
  values (p_book_id, v_now)
  on conflict (book_id) do update
     set last_run_at = excluded.last_run_at
   where r.last_run_at <= excluded.last_run_at - make_interval(secs => p_min_interval_seconds)
  returning true into v_claimed;

  if v_claimed then
    return 0;
  end if;

  select r.last_run_at into v_last from private.finalize_runs as r where r.book_id = p_book_id;
  return greatest(
    1,
    ceil(extract(epoch from (v_last + make_interval(secs => p_min_interval_seconds) - v_now)))::integer
  );
end;
$$;

-- Reserves up to p_want reverse-geocode calls for the book today (UTC day),
-- never more than p_daily_cap per day. Returns the number granted (0..p_want).
-- Requires a row from claim_finalize_run (returns 0 otherwise). Row-locked.
create or replace function public.reserve_geocode_calls(
  p_book_id uuid,
  p_want integer,
  p_daily_cap integer
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_today   date := (now() at time zone 'utc')::date;
  v_used    integer;
  v_granted integer;
begin
  if p_book_id is null or p_want is null or p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  if p_want <= 0 then
    return 0;
  end if;

  select case when r.day = v_today then r.geocode_calls_today else 0 end
    into v_used
    from private.finalize_runs as r
   where r.book_id = p_book_id
     for update;

  if not found then
    return 0;
  end if;

  v_granted := least(p_want, greatest(0, p_daily_cap - v_used));

  update private.finalize_runs as r
     set day = v_today,
         geocode_calls_today = v_used + v_granted
   where r.book_id = p_book_id;

  return v_granted;
end;
$$;

revoke all on function public.claim_finalize_run(uuid, integer) from public, anon, authenticated;
revoke all on function public.reserve_geocode_calls(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_finalize_run(uuid, integer) to service_role;
grant execute on function public.reserve_geocode_calls(uuid, integer, integer) to service_role;
