-- =============================================================================
-- 20261109000800_cursor_size.sql — Milestone 4: agent_runs.cursor size limit
--
-- Additive only: 0100–0700 are applied and must not be edited.
--
-- D-033 — Captions live in agent_runs.cursor between captioning ticks (and are
--   stripped at finish), so the cursor size check (0600: 64 KB) is raised to
--   256 KB. Caption text is NOT stored in agent_steps (D-027).
--
-- Nothing else changes: no grants, policies, RLS, functions or other columns.
-- Clients still cannot read agent_runs.cursor (0700 column grants).
-- =============================================================================

alter table public.agent_runs drop constraint agent_runs_cursor_size;
alter table public.agent_runs
  add constraint agent_runs_cursor_size check (pg_column_size(cursor) <= 262144);
