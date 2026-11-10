-- =============================================================================
-- 20261111001000_publish.sql — Milestone 6: publish snapshot + viewer read +
-- password unlock rate limit (D-039, D-040; extends D-011 / D-036)
--
-- Additive only: 0100–0900 are applied and must not be edited.
--
-- 1) D-039 — publish = snapshot. New books columns:
--      published_doc     jsonb        the doc the viewer renders (copy of doc at
--                                     publish time); null = not live
--      published_rev     bigint       doc_rev that was copied ("Publish changes"
--                                     shows when doc_rev > published_rev)
--      last_published_at timestamptz  last (re)publish; published_at stays the
--                                     FIRST publish (free expiry is fixed at
--                                     first publish + 30 days, never extended)
--    Checks: published_doc ≤ 1 MiB (same as doc); published_rev ≥ 0;
--      published_doc is null or (slug is not null and published_at is not null)
--      published_doc is null or (published_rev is not null and
--                                last_published_at is not null)
--    So a live book always has a slug, a first-publish time, a rev and a
--    last-publish time. Unpublish = set published_doc to null (the other
--    columns may stay; slug never changes, D-039).
--
-- 2) Column guard: private.protect_book_columns = the 0900 version (unchanged
--    behaviour) plus published_doc / published_rev / last_published_at /
--    password_hash: null on INSERT and old value on UPDATE for non-service
--    callers. Publishing and setting/removing the password go through server
--    routes with the admin client. (No current code writes password_hash.)
--    Stays SECURITY INVOKER with search_path '' (current_user check — see
--    20261108000100_init_schema.sql). Trigger is NOT recreated, so the BEFORE
--    trigger order on books is unchanged:
--      books_protect_columns < books_set_doc_rev < books_set_updated_at
--
-- 3) public.book_unlock_attempts — password unlock attempts (D-040). RLS on, NO
--    policies, all privileges revoked from public / anon / authenticated: only
--    the service role (via try_book_unlock) touches it. Rows cascade with the
--    book. ip_hash is a keyed hash computed by the server (never a raw IP).
--
-- 4) public.try_book_unlock(p_book, p_ip_hash, p_ip_limit, p_book_limit,
--    p_window_s) returns boolean — atomic check-and-record of one unlock
--    attempt; call it BEFORE verifying the password. Semantics:
--      * ip limit:   attempts from p_ip_hash on ANY book in the last
--                    p_window_s seconds must be < p_ip_limit;
--      * book limit: attempts on p_book from ANY ip in the last 1 HOUR (fixed)
--                    must be < p_book_limit;
--      * allowed → the attempt is recorded and true is returned; refused →
--        nothing is recorded (a blocked client cannot extend its own lockout)
--        and false is returned. Wrong AND right passwords both count (the
--        attempt is recorded before verification).
--      * housekeeping: rows of this book and of this ip older than
--        greatest(p_window_s, 3600) s are deleted on every call.
--      * locks: pg_advisory_xact_lock on the book (key space 4), then on the
--        ip hash (key space 5) — always in that order, so no deadlock; this
--        serialises the counts + insert for the book and for the ip.
--        Key spaces in use: 0 photo cap (book), 1 create_agent_run_capped
--        (user), 3 create_rewrite_run_capped (user), 4/5 here.
--      * invalid arguments (null, limits < 1, window outside 1..86400 s, empty
--        ip hash) raise 'invalid_argument' (22023). An unknown p_book raises a
--        foreign_key_violation on insert (callers resolve the slug first).
--
-- 5) public.get_published_book(p_slug) — dropped and recreated (new return
--    columns). Live = published_doc is not null. Returns
--      id, slug, title, caption_lang, is_paid, page_count (of published_doc),
--      published_rev, published_at, expires_at, is_expired, has_password, doc
--    with is_expired = not is_paid and expires_at is not null and
--    expires_at <= now() (paid books never expire, D-002/D-039) and
--    doc = published_doc only when not expired and no password; never user_id
--    or password_hash. Now SECURITY INVOKER and executable by service_role
--    only: the /b/[slug] server reads it with the admin client (it used to be
--    DEFINER + granted to anon/authenticated in 0200/0300). Nothing else
--    depends on it: there are no anon storage policies (photos are served via
--    signed URLs created server-side).
--
-- Privileges: all new / replaced functions are SECURITY INVOKER with
-- search_path ''. EXECUTE is revoked from public / anon / authenticated
-- (Supabase default privileges grant it to authenticated) and granted to
-- service_role only.
--
-- Deploy: safe to apply BEFORE the M6 code — no current code writes
-- password_hash or the new columns, and nothing calls get_published_book yet.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) books: publish snapshot columns
-- ---------------------------------------------------------------------------
alter table public.books
  add column published_doc     jsonb,
  add column published_rev     bigint,
  add column last_published_at timestamptz;

alter table public.books
  add constraint books_published_doc_size check (pg_column_size(published_doc) <= 1048576),
  add constraint books_published_rev_check check (published_rev >= 0),
  add constraint books_published_doc_requires_publish check (
    published_doc is null or (slug is not null and published_at is not null)
  ),
  add constraint books_published_doc_has_rev check (
    published_doc is null or (published_rev is not null and last_published_at is not null)
  );

-- ---------------------------------------------------------------------------
-- 2) Column guard: same as 0900, plus published_doc / published_rev /
--    last_published_at / password_hash.
--
-- Must stay SECURITY INVOKER: the privilege check is `current_user` (see the
-- full rationale in 20261108000100_init_schema.sql).
--
-- WARNING: any future SECURITY DEFINER function owned by postgres that writes
-- to public.books bypasses this guard (inside it current_user = the owner,
-- postgres). Such functions must enforce these rules themselves.
-- ---------------------------------------------------------------------------
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
    new.is_paid           := false;
    new.max_pages         := 20;
    new.expires_at        := null;
    new.slug              := null;
    new.published_at      := null;
    new.ai_status         := 'idle';
    new.doc               := '{}'::jsonb;
    new.page_count        := 0;
    new.doc_rev           := 0;
    new.published_doc     := null;
    new.published_rev     := null;
    new.last_published_at := null;
    new.password_hash     := null;
  elsif tg_op = 'UPDATE' then
    new.id                := old.id;
    new.created_at        := old.created_at;
    new.is_paid           := old.is_paid;
    new.max_pages         := old.max_pages;
    new.expires_at        := old.expires_at;
    new.slug              := old.slug;
    new.published_at      := old.published_at;
    new.user_id           := old.user_id;
    new.ai_status         := old.ai_status;
    new.doc               := old.doc;
    new.page_count        := old.page_count;
    new.doc_rev           := old.doc_rev;
    new.published_doc     := old.published_doc;
    new.published_rev     := old.published_rev;
    new.last_published_at := old.last_published_at;
    new.password_hash     := old.password_hash;
  end if;

  return new;
end;
$$;

revoke all on function private.protect_book_columns() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Password unlock attempts (service role only)
-- ---------------------------------------------------------------------------
create table public.book_unlock_attempts (
  id         bigserial primary key,
  book_id    uuid not null references public.books (id) on delete cascade,
  ip_hash    text not null,
  created_at timestamptz not null default now(),
  constraint book_unlock_attempts_ip_hash_length check (char_length(ip_hash) between 1 and 128)
);

create index book_unlock_attempts_book_id_created_at_idx
  on public.book_unlock_attempts (book_id, created_at);
create index book_unlock_attempts_ip_hash_created_at_idx
  on public.book_unlock_attempts (ip_hash, created_at);

alter table public.book_unlock_attempts enable row level security;
-- No policies on purpose: clients have no grants; the service role bypasses RLS.

revoke all on table public.book_unlock_attempts from public, anon, authenticated;
grant all on table public.book_unlock_attempts to service_role;
revoke all on sequence public.book_unlock_attempts_id_seq from public, anon, authenticated;
grant usage, select on sequence public.book_unlock_attempts_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 4) try_book_unlock — atomic rate-limit check + record (semantics in header)
-- ---------------------------------------------------------------------------
create or replace function public.try_book_unlock(
  p_book       uuid,
  p_ip_hash    text,
  p_ip_limit   integer,
  p_book_limit integer,
  p_window_s   integer
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ip_n   integer;
  v_book_n integer;
  v_keep   interval;
begin
  if p_book is null or p_ip_hash is null or p_ip_limit is null or p_book_limit is null
     or p_window_s is null or p_ip_limit < 1 or p_book_limit < 1
     or p_window_s < 1 or p_window_s > 86400 or char_length(p_ip_hash) = 0 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_book::text, 4));
  perform pg_advisory_xact_lock(hashtextextended(p_ip_hash, 5));

  v_keep := make_interval(secs => greatest(p_window_s, 3600));

  delete from public.book_unlock_attempts as a
   where a.book_id = p_book
     and a.created_at < now() - v_keep;
  delete from public.book_unlock_attempts as a
   where a.ip_hash = p_ip_hash
     and a.created_at < now() - v_keep;

  select count(*) into v_ip_n
    from public.book_unlock_attempts as a
   where a.ip_hash = p_ip_hash
     and a.created_at > now() - make_interval(secs => p_window_s);
  if v_ip_n >= p_ip_limit then
    return false;
  end if;

  select count(*) into v_book_n
    from public.book_unlock_attempts as a
   where a.book_id = p_book
     and a.created_at > now() - interval '1 hour';
  if v_book_n >= p_book_limit then
    return false;
  end if;

  insert into public.book_unlock_attempts (book_id, ip_hash)
  values (p_book, p_ip_hash);

  return true;
end;
$$;

revoke all on function public.try_book_unlock(uuid, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.try_book_unlock(uuid, text, integer, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5) get_published_book — snapshot read (drop + create: return type changed)
-- ---------------------------------------------------------------------------
drop function public.get_published_book(text);

create function public.get_published_book(p_slug text)
returns table (
  id            uuid,
  slug          text,
  title         text,
  caption_lang  text,
  is_paid       boolean,
  page_count    integer,
  published_rev bigint,
  published_at  timestamptz,
  expires_at    timestamptz,
  is_expired    boolean,
  has_password  boolean,
  doc           jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    b.id,
    b.slug,
    b.title,
    b.caption_lang,
    b.is_paid,
    case
      when jsonb_typeof(b.published_doc -> 'pages') = 'array'
        then jsonb_array_length(b.published_doc -> 'pages')
      else 0
    end                                                               as page_count,
    b.published_rev,
    b.published_at,
    b.expires_at,
    (not b.is_paid and b.expires_at is not null and b.expires_at <= now()) as is_expired,
    (b.password_hash is not null)                                     as has_password,
    case
      when (not b.is_paid and b.expires_at is not null and b.expires_at <= now()) then null
      when b.password_hash is not null then null
      else b.published_doc
    end                                                               as doc
  from public.books as b
  where b.slug = p_slug
    and b.published_doc is not null
    and b.published_at is not null
  limit 1;
$$;

revoke all on function public.get_published_book(text) from public, anon, authenticated;
grant execute on function public.get_published_book(text) to service_role;
