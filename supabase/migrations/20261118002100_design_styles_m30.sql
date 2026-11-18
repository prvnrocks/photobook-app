-- =============================================================================
-- 20261118002100_design_styles_m30.sql — Milestone 30: design styles
-- 'magazine' + 'editorial' (D-090)
--
-- Additive only: 0100–2000 are applied in production and must not be edited.
--
-- 1) books_design_style_check (1900: classic, modern, geometric, scrapbook) is
--    widened to the six values of src/lib/book/schema.ts DESIGN_STYLES:
--      classic, modern, geometric, scrapbook, magazine, editorial
--    Same constraint name. Drop + re-add are ONE alter table statement, so the
--    swap is atomic on its own (and `supabase db push` runs the file in one
--    transaction anyway): there is no moment without a check. Every existing
--    row already satisfies the wider list (it is a superset of the 1900 list),
--    so the validation scan cannot fail; it holds ACCESS EXCLUSIVE on books for
--    one short scan of a small table.
--
-- Nothing else changes: no columns, defaults ('classic'), grants, policies,
-- RLS, triggers or functions. format / design_style stay insert-only for
-- owners (private.protect_book_columns, latest = 2000, D-063); the 1900
-- backfill is not repeated (no doc could name the new styles before M30).
--
-- Deploy order: additive: apply BEFORE code. The M30 code inserts books with
-- design_style 'magazine' / 'editorial' (src/lib/db/books.ts createBook) —
-- against a database without 2100 those inserts fail with 23514
-- (check_violation); the four old styles keep working either way. The OLD code
-- never writes the new values, so it keeps working against a database with
-- 2100 applied. Apply → supabase/tests/rls_check.sql.
--
-- Rollback: redeploying older code needs no database change (it never writes
-- the new values, and reads design_style as text). BUT older code cannot parse
-- a 'magazine' / 'editorial' book: its doc schema rejects the style, the M30
-- layout ids, chapter descriptions and colourways, and the same holds for the
-- v2 published snapshots (published_doc) of such books — their editor and
-- public /b/[slug] links stop working until the M30 code is redeployed. Books
-- of the four older styles are unaffected. Narrowing the check back to
-- the four 1900 values is only possible while no book has design_style
-- 'magazine' / 'editorial' — otherwise the re-add fails on those rows; leave
-- the wider check in place instead.
--
-- rls_check.sql: 176 → 177 checks (+1 design styles m30: the constraint lists
-- exactly the six styles, an owner can insert 'magazine' / 'editorial', an
-- unknown style is still rejected, the new values stay insert-only). The 1900
-- backfill-consistency check now compares all six doc styles.
-- =============================================================================

alter table public.books
  drop constraint books_design_style_check,
  add constraint books_design_style_check
    check (design_style in ('classic', 'modern', 'geometric', 'scrapbook', 'magazine', 'editorial'));
