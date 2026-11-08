-- =============================================================================
-- 20261108000400_photo_upload.sql — Milestone 2: resumable upload + photo cap
--
-- Additive only: 0100, 0200 and 0300 are already applied and must not be edited.
--
-- 1) photos upload columns (D-013 resumable upload = server-tracked fingerprints)
--      fingerprint     content fingerprint computed in the browser, unique per book
--                      → re-selecting the same files on resume finds existing rows
--      upload_state    'pending' (row inserted before upload) → 'ready' (all files
--                      uploaded)
--      original_bytes  size of the stored original (nullable until uploaded)
--      original_mime   mime of the stored original; HEIC is always converted to
--                      JPEG before upload (D-012), so only jpeg/png/webp
--    The 0300 path CHECKs (photos_*_path_owner) are untouched and keep working.
--    photos is empty in prod, so `fingerprint not null` without default is safe.
--
-- 2) Upload cap per book (D-014): 150 photos for a free book, 500 for a paid book.
--    The numbers MUST equal LIMITS.free/paid.maxUploadPhotos in
--    src/lib/ai/limits.ts (tests/migrations.test.ts compares them).
--    Enforced by a BEFORE INSERT (and BEFORE UPDATE OF book_id, so photos can't
--    be moved into a full book) trigger. Applies to every role, including the
--    service role.
--
-- Grants: none needed. 0300 granted table-level select/insert/update/delete on
-- public.photos to authenticated and all to service_role; table-level grants
-- cover columns added later. anon still has nothing.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) photos upload columns
-- ---------------------------------------------------------------------------
alter table public.photos
  add column fingerprint    text    not null,
  add column upload_state   text    not null default 'pending',
  add column original_bytes integer,
  add column original_mime  text,
  add constraint photos_fingerprint_length check (char_length(fingerprint) between 16 and 128),
  add constraint photos_book_fingerprint_key unique (book_id, fingerprint),
  add constraint photos_upload_state_check check (upload_state in ('pending', 'ready')),
  add constraint photos_original_bytes_check check (original_bytes > 0),
  add constraint photos_original_mime_check check (
    original_mime in ('image/jpeg', 'image/png', 'image/webp')
  );

-- ---------------------------------------------------------------------------
-- 2) Photo cap per book
--
-- SECURITY INVOKER on purpose (no privilege escalation; the cap applies to the
-- caller with the caller's own visibility):
--   * The book row: an authenticated caller sees its own book through
--     books_select_own. If the book is not visible (someone else's book, or it
--     does not exist) we just return new and let the photos_insert_own /
--     photos_update_own WITH CHECK or the FK reject the row.
--   * The count: photos RLS is owner-only (photos_select_own), and every photo
--     of a book belongs to the book's owner (photos_insert_own/update_own require
--     user_id = auth.uid() AND the book owned by auth.uid()). So the owner's
--     count sees ALL photos of the book. service_role / postgres bypass RLS and
--     see all rows anyway. If a future policy ever lets a non-owner add photos
--     to a book, this assumption breaks and the count must be revisited.
--
-- Concurrency: pg_advisory_xact_lock serialises inserts per book until the
-- inserting transaction ends. The function is VOLATILE, so under READ COMMITTED
-- the count query takes a fresh snapshot after the lock is granted and sees the
-- rows committed by the transaction that held the lock before us.
-- A multi-row insert fires the trigger once per row and each count sees the
-- rows already inserted by the same statement, so inserting 151 rows at once
-- into a free book fails as a whole.
-- ---------------------------------------------------------------------------
create or replace function private.enforce_photo_cap()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_is_paid boolean;
  v_limit   integer;
  v_count   integer;
begin
  if tg_op = 'UPDATE' and new.book_id is not distinct from old.book_id then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.book_id::text, 0));

  select b.is_paid into v_is_paid
    from public.books as b
   where b.id = new.book_id;

  if not found then
    return new; -- not visible / missing: RLS or the FK rejects the row
  end if;

  v_limit := case when v_is_paid then 500 else 150 end;

  select count(*) into v_count
    from public.photos as p
   where p.book_id = new.book_id;

  if v_count >= v_limit then
    raise exception 'photo_limit_reached'
      using errcode = 'P0001', hint = v_limit::text;
  end if;

  return new;
end;
$$;

create trigger photos_enforce_cap
  before insert or update of book_id on public.photos
  for each row execute function private.enforce_photo_cap();

-- Trigger-only function (trigger firing does not check EXECUTE).
revoke all on function private.enforce_photo_cap() from public, anon, authenticated;
