-- =============================================================================
-- 20261115001900_design.sql — Milestone 10b: book format + design style
-- columns (D-063), photos.color
--
-- Additive only: 0100–1800 are applied in production and must not be edited.
--
-- Deploy order: additive: apply BEFORE code. The M10b code reads / inserts
-- books.format and books.design_style; the M10a code never names them, and the
-- defaults below are exactly what it produces (A5 portrait, classic), so the
-- old code keeps working against a database with 1900 applied. Apply →
-- supabase/tests/rls_check.sql.
--
-- 1) books.format text not null default 'A5_PORTRAIT'
--      check in ('A5_PORTRAIT', 'A5_LANDSCAPE')          (src/lib/book/schema.ts BOOK_FORMATS)
--    books.design_style text not null default 'classic'
--      check in ('classic', 'modern', 'geometric', 'scrapbook')  (DESIGN_STYLES)
--    D-063: chosen on the New book form, fixed afterwards, and the server's
--    authority for doc.format / doc.style.designStyle.
--
-- 2) photos.color text null, check '#RRGGBB' (either hex case, same as
--    HexColorSchema). Dominant colour of the photo, server-written only.
--
-- 3) Privileges. books / photos use TABLE-level grants for authenticated
--    (0300: select, insert, update, delete) + the SECURITY INVOKER column-guard
--    triggers (current_user check, see 0100). A column-level REVOKE cannot
--    narrow a table-level grant in Postgres, so the guards enforce D-063 the
--    same way 0900 made doc / page_count / doc_rev server-only:
--      private.protect_book_columns (latest = 1800) + format / design_style:
--        INSERT: left alone — the owner's own insert (src/lib/db/books.ts
--                createBook, direct insert through RLS policy, no RPC) may set
--                them; the check constraints reject anything outside the enums.
--        UPDATE: old values kept for non-privileged callers (insert-only).
--      private.protect_photo_columns (latest = 0500) + color:
--        INSERT: forced to null; UPDATE: old value kept.
--    Both functions stay SECURITY INVOKER, search_path '', EXECUTE revoked.
--    Same names → the triggers (0100 books_protect_columns, 0500
--    photos_protect_columns) pick up the new bodies; firing order unchanged.
--
-- 4) Backfill (postgres, bypasses the guard): format / design_style copied
--    from doc->>'format' and doc->'style'->>'designStyle' when present and
--    valid; rows whose doc has neither (e.g. '{}' drafts, v1 docs without
--    designStyle) keep the defaults. doc is NOT written, so books_set_doc_rev
--    keeps doc_rev (it only bumps when doc is distinct). books_set_updated_at
--    would set updated_at = now() on every touched row — that is the draft
--    idle clock (cleanup_delete_abandoned_drafts / claim_draft_warnings), so a
--    bump would re-arm draft warnings and postpone deletion for every backfilled
--    book. It is disabled for the backfill statement only and re-enabled in the
--    same transaction (the migration is one transaction; ALTER TABLE ... ADD
--    COLUMN already holds ACCESS EXCLUSIVE on books). Only rows that actually
--    differ are updated.
--
-- rls_check.sql: 173 → 175 checks (+1 books format / design_style: insert
-- allowed + enum checks + owner update kept + backfill consistency of the live
-- data; +1 photos.color: insert forced null, owner update kept, hex check).
-- The backfill itself is dry-run against a seeded v2 landscape doc with
-- scripts/pglite/seeds/1900_design.sql + scripts/pglite/checks/1900_design.sql
-- (see scripts/pglite/README.md).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) books.format / books.design_style
-- ---------------------------------------------------------------------------
alter table public.books
  add column format       text not null default 'A5_PORTRAIT',
  add column design_style text not null default 'classic';

alter table public.books
  add constraint books_format_check
    check (format in ('A5_PORTRAIT', 'A5_LANDSCAPE')),
  add constraint books_design_style_check
    check (design_style in ('classic', 'modern', 'geometric', 'scrapbook'));

-- ---------------------------------------------------------------------------
-- 2) photos.color
-- ---------------------------------------------------------------------------
alter table public.photos add column color text;

alter table public.photos
  add constraint photos_color_format check (color is null or color ~ '^#[0-9A-Fa-f]{6}$');

-- ---------------------------------------------------------------------------
-- 3a) books column guard: same as 1800, plus format / design_style
--     (insert-only for owners, D-063).
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
    -- format / design_style: owner-chosen on insert (D-063), enum-checked by constraints.
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
    new.format                    := old.format;
    new.design_style              := old.design_style;
  end if;

  return new;
end;
$$;

revoke all on function private.protect_book_columns() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3b) photos column guard: same as 0500, plus color (server-only).
--
-- Must stay SECURITY INVOKER (current_user check). Trigger order unchanged:
-- photos_enforce_cap (0400) still fires before photos_protect_columns.
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
    new.color            := null;
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
    new.color            := old.color;
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

revoke all on function private.protect_photo_columns() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Backfill from doc (doc / doc_rev / updated_at untouched)
-- ---------------------------------------------------------------------------
alter table public.books disable trigger books_set_updated_at;

update public.books as b
   set format       = coalesce(v.doc_format, b.format),
       design_style = coalesce(v.doc_style, b.design_style)
  from (
    select x.id,
           case when x.doc ->> 'format' in ('A5_PORTRAIT', 'A5_LANDSCAPE')
                then x.doc ->> 'format' end as doc_format,
           case when x.doc -> 'style' ->> 'designStyle' in ('classic', 'modern', 'geometric', 'scrapbook')
                then x.doc -> 'style' ->> 'designStyle' end as doc_style
      from public.books as x
  ) as v
 where v.id = b.id
   and ((v.doc_format is not null and v.doc_format <> b.format)
        or (v.doc_style is not null and v.doc_style <> b.design_style));

alter table public.books enable trigger books_set_updated_at;
