-- =============================================================================
-- 20261115002000_album_confirmed.sql — Milestone 20c: per-book "album
-- confirmed" marker (D-072 known gap)
--
-- Additive only: 0100–1900 are applied in production and must not be edited.
--
-- Problem: "Generate album" (confirmAlbumAction) recorded nothing on the book,
-- so /books/new?book=<id>&step=1..7 (or browser Back from the editor) showed the
-- wizard's Review step again for a generated book.
--
-- 1) books.album_confirmed_at timestamptz null — set once (null → now()) by
--    confirmAlbumAction (src/app/books/[id]/review/actions.ts) through the admin
--    client after the owner check (getMyBook under RLS) + an owner filter.
--    Never cleared. A confirmed book never lands in the wizard again
--    (resolveWizardStep → "editor"). Existing books stay null (no backfill: a
--    user-edited album already goes to the editor; for the rest "generated"
--    cannot be told apart from "built, Review not confirmed yet").
--
-- 2) Privileges. books uses TABLE-level grants for authenticated (0300) + the
--    SECURITY INVOKER column guard (current_user check, see 0100) — a column
--    REVOKE cannot narrow a table grant, so the guard makes the column
--    SERVER-ONLY like is_paid / the warning columns:
--      private.protect_book_columns (latest = 1900) + album_confirmed_at:
--        INSERT: forced to null; UPDATE: old value kept (owner can neither set
--        nor clear it). Same name → trigger books_protect_columns (0100) picks
--        up the new body; SECURITY INVOKER, search_path '', EXECUTE revoked.
--    RLS policies are unchanged (owner-only select / update as before).
--
-- 3) books_set_updated_at (unchanged): the confirm write bumps updated_at like
--    any other user action (it is activity: the draft idle clock may restart).
--
-- Deploy order: apply BEFORE the M20c code. The M20c code selects
-- books.album_confirmed_at in getMyBook (every book page / action) — against a
-- database without 2000 that select fails with 42703 and is NOT tolerated (no
-- legacy retry for this column): the wizard, editor, review, upload, build and
-- publish paths would answer an error / 503 for every book. The OLD code never
-- names the column, so it keeps working against a database with 2000 applied.
-- Apply → supabase/tests/rls_check.sql.
--
-- rls_check.sql: 175 → 176 checks (+1 album_confirmed_at: owner insert forced
-- null, owner update can't set / clear it, B can't touch it, service role can).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) books.album_confirmed_at
-- ---------------------------------------------------------------------------
alter table public.books add column album_confirmed_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2) books column guard: same as 1900, plus album_confirmed_at (server-only).
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
    new.album_confirmed_at        := null;
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
    new.album_confirmed_at        := old.album_confirmed_at;
  end if;

  return new;
end;
$$;

revoke all on function private.protect_book_columns() from public, anon, authenticated;
