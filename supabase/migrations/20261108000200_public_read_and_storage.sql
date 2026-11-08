-- =============================================================================
-- 20261108000200_public_read_and_storage.sql — Milestone 1: public book read +
-- storage buckets and policies
--
-- 1) public.get_published_book(p_slug)
--    The only way anon viewers (/b/[slug]) can read a book. books has no anon
--    RLS policy; this SECURITY DEFINER function returns a narrow, safe column
--    set for one published book. It never returns user_id or password_hash.
--      * Only rows with slug = p_slug and published_at is not null.
--      * Expired books (expires_at <= now()) still return a row, so the viewer
--        can show "this link has expired", but doc is NULL.
--      * Password-protected books return doc = NULL; Milestone 6 adds a
--        separate verify function that returns doc after checking the password.
--
-- 2) Storage buckets (both private; files are served via signed URLs)
--      photos  — 25 MB max, image/jpeg|png|webp|heic|heif
--      exports — 50 MB max, application/pdf (written by the server only)
--
--    Object path convention (first folder MUST be the owner's auth uid; the
--    policies below rely on it):
--      photos:  {user_id}/{book_id}/{photo_id}-{size}.{ext}
--               size = original | web | thumb   e.g.
--               9f1c…/3b2a…/77de…-web.jpg
--      exports: {user_id}/{book_id}/{...}.pdf
--
-- 3) storage.objects policies — owner-only, `to authenticated`, no anon access.
--      photos:  select / insert / update / delete own folder
--      exports: select own folder only (PDFs are written by the service role,
--               which bypasses RLS)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Public read of a published book
-- ---------------------------------------------------------------------------
create or replace function public.get_published_book(p_slug text)
returns table (
  id           uuid,
  title        text,
  slug         text,
  caption_lang text,
  page_count   integer,
  is_paid      boolean,
  published_at timestamptz,
  expires_at   timestamptz,
  is_expired   boolean,
  has_password boolean,
  doc          jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.id,
    b.title,
    b.slug,
    b.caption_lang,
    b.page_count,
    b.is_paid,
    b.published_at,
    b.expires_at,
    (b.expires_at is not null and b.expires_at <= now())       as is_expired,
    (b.password_hash is not null)                               as has_password,
    case
      when (b.expires_at is not null and b.expires_at <= now()) then null
      when b.password_hash is not null then null
      else b.doc
    end                                                         as doc
  from public.books as b
  where b.slug = p_slug
    and b.published_at is not null
  limit 1;
$$;

revoke all on function public.get_published_book(text) from public;
grant execute on function public.get_published_book(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'photos', 'photos', false, 26214400,
    array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
  ),
  (
    'exports', 'exports', false, 52428800,
    array['application/pdf']
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- storage.objects policies (RLS is already enabled on storage.objects by Supabase)
-- ---------------------------------------------------------------------------
create policy "photos_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "photos_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "photos_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "photos_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "exports_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'exports'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
