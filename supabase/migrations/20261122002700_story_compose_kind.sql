-- =============================================================================
-- 20261122002700_story_compose_kind.sql — storybook page composition calls (Task 7)
--
-- Additive only: 0100–2600 must not be edited.
--
-- public.story_ai_calls (2600) gets one more call kind and one more run scope:
--   kind  'compose' — the ONE page-intent call of composeStorybookPages()
--                     (src/lib/ai/story/compose.ts): the model picks a template
--                     family / emphasis / approved template id per page; code
--                     validates every choice and lays the pages out.
--   scope 'compose' — the run it belongs to (one composition). The per-book
--                     limit (src/lib/ai/limits.ts maxStoryComposes) counts
--                     DISTINCT run_id with scope 'compose' among live ok rows.
-- Both checks keep their names. Each is dropped and re-added inside ONE alter
-- table statement (like 2100 did for books_design_style_check), so there is no
-- moment without a check; every existing row satisfies the wider lists (they
-- are supersets of the 2600 lists), so the validation scan cannot fail. The
-- table stays service-role only and holds no text (no new column).
--
-- Deploy order: additive — apply BEFORE code that calls composeStorybookPages()
-- with AI on. Against a database without 2700 a live compose call would be
-- recorded with a kind the check rejects (the insert fails; the composer
-- records best effort and still lays the book out deterministically), so the
-- composer refuses the live call while it cannot be counted (usage probe).
-- Rollback: older code never writes 'compose'; narrowing the checks back is
-- only possible while no row has kind / scope 'compose' — leave them wide.
--
-- rls_check.sql: 185 → 186 checks (+1 story compose kind: 'compose' accepted
-- as kind and scope, unknown values still rejected, still no client access).
-- =============================================================================

alter table public.story_ai_calls
  drop constraint story_ai_calls_kind_check,
  add constraint story_ai_calls_kind_check check (kind in ('plan', 'write', 'repair', 'rewrite', 'compose')),
  drop constraint story_ai_calls_scope_check,
  add constraint story_ai_calls_scope_check check (scope in ('plan', 'book', 'chapter', 'block', 'compose'));
