-- =============================================================================
-- 20261108000300_hardening.sql — Milestone 1 review fixes (T12)
--
-- Additive only: 0100 and 0200 are already applied and must not be edited.
--
-- 1) photos path CHECKs: original/web/thumb paths must live under
--    {user_id}/{book_id}/ (the storage folder convention from 0200), so a row
--    can never point at another user's (or another book's) objects.
-- 2) Explicit table grants: anon gets nothing on the 4 tables; authenticated
--    gets exactly what the RLS policies need; service_role gets all.
--    New functions in public no longer get EXECUTE for public/anon by default.
-- 3) Size limits on free-text / jsonb columns; profile name truncated to 120
--    chars when copied from auth metadata.
-- 4) protect_book_columns also freezes books.id and books.created_at.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) photos path constraints (table is empty, so add them validated)
-- ---------------------------------------------------------------------------
alter table public.photos
  add constraint photos_original_path_owner check (
    original_path is null
    or original_path like (user_id::text || '/' || book_id::text || '/%')
  ),
  add constraint photos_web_path_owner check (
    web_path is null
    or web_path like (user_id::text || '/' || book_id::text || '/%')
  ),
  add constraint photos_thumb_path_owner check (
    thumb_path is null
    or thumb_path like (user_id::text || '/' || book_id::text || '/%')
  );

-- ---------------------------------------------------------------------------
-- 2) Explicit grants
-- ---------------------------------------------------------------------------
revoke all on table public.profiles, public.books, public.photos, public.orders from anon;
revoke all on table public.profiles, public.books, public.photos, public.orders from authenticated;

-- books / photos: full CRUD, rows limited by RLS; server-only book columns by trigger.
grant select, insert, update, delete on table public.books, public.photos to authenticated;
-- profiles: rows are created by trigger and deleted by cascade.
grant select, update on table public.profiles to authenticated;
-- orders: read own only; written by the service role (Stripe webhook).
grant select on table public.orders to authenticated;
-- (TRUNCATE is not re-granted to anon/authenticated: it bypasses RLS.)

grant all on table public.profiles, public.books, public.photos, public.orders to service_role;

-- Functions created later in public are not executable by public/anon unless
-- a migration grants it explicitly.
alter default privileges in schema public revoke execute on functions from public, anon;

grant execute on function public.get_published_book(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Size limits
-- ---------------------------------------------------------------------------
alter table public.books
  add constraint books_doc_size check (pg_column_size(doc) <= 1048576),
  add constraint books_occasion_length check (char_length(occasion) <= 40),
  add constraint books_tone_length check (char_length(tone) <= 40);

alter table public.profiles
  add constraint profiles_name_length check (char_length(name) <= 120);

alter table public.photos
  add constraint photos_place_length check (char_length(place) <= 200),
  add constraint photos_camera_length check (char_length(camera) <= 120),
  add constraint photos_drop_reason_length check (char_length(drop_reason) <= 200);

-- Same as 0100, but the name is truncated so a long OAuth/full_name value can
-- never make the auth.users insert (sign-up) fail on profiles_name_length.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), 120)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Guard server-only book columns (D-011) — now also freezes id/created_at.
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
    new.is_paid      := false;
    new.max_pages    := 20;
    new.expires_at   := null;
    new.slug         := null;
    new.published_at := null;
  elsif tg_op = 'UPDATE' then
    new.id           := old.id;
    new.created_at   := old.created_at;
    new.is_paid      := old.is_paid;
    new.max_pages    := old.max_pages;
    new.expires_at   := old.expires_at;
    new.slug         := old.slug;
    new.published_at := old.published_at;
    new.user_id      := old.user_id;
  end if;

  return new;
end;
$$;

-- create or replace keeps existing ACLs, but re-assert: trigger-only functions.
revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.protect_book_columns() from public, anon, authenticated;
