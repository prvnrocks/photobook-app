-- =============================================================================
-- 20261121002600_story_ai_calls.sql — Story Planner / Narrative Writer usage log (Task 6)
--
-- Additive only: 0100–2500 must not be edited. No existing table, column,
-- constraint, policy, grant, trigger or function changes.
--
-- public.story_ai_calls — one row per model call of src/lib/ai/story:
--   kind   'plan'    the outline call of planStory()
--          'write'   one chapter (or the closing page) of writeStory()
--          'repair'  the single repair call of a chapter whose blocks failed
--                    the grounding check
--          'rewrite' one attempt of rewriteNarrativeBlock()
--   scope  what the run produces: 'plan' | 'book' (a full write) | 'chapter'
--          (one chapter regenerated) | 'block' (one block rewritten). The
--          per-book limits (src/lib/ai/limits.ts: story writes / chapter
--          regenerations / block rewrites) count DISTINCT run_id per scope
--          among live ok rows.
--   run_id one id per planStory / writeStory / rewriteNarrativeBlock call.
--   Per row: chapter_id ('c3', 'closing' or null), the storybook version being
--   written, model, prompt_version, mode (live | replay), status + error code,
--   token usage, cost_usd, latency_ms.
--   The table holds NO text: no prompt, no user answer, no photo description
--   and no generated narrative. The narrative itself lives in
--   storybook_versions (2200).
--
-- Access: SERVICE ROLE ONLY, like photo_analyses (2400) and agent_steps: no
-- client grants and no policies. Rows are deleted with the book or the account
-- (cascade).
--
-- Deploy order: additive — apply BEFORE code that calls planStory() /
-- writeStory() / rewriteNarrativeBlock() in live mode (live calls are refused
-- while the table is missing, because they could not be counted against the
-- limits or the daily budget). Nothing in the deployed app calls them yet.
-- Rollback: older code never touches the table; dropping it is safe.
--
-- rls_check.sql: 184 → 185 checks (+1 story ai calls: no client access at all,
-- kind / scope / chapter id / count checks, error rows carry a code).
-- =============================================================================

create table public.story_ai_calls (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  book_id            uuid not null references public.books (id) on delete cascade,
  run_id             uuid not null,
  kind               text not null,
  scope              text not null,
  chapter_id         text,
  storybook_version  integer,
  model              text not null,
  prompt_version     text not null,
  mode               text not null,
  status             text not null,
  error              text,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd           numeric(10, 6) not null default 0,
  latency_ms         integer not null default 0,
  created_at         timestamptz not null default now(),
  constraint story_ai_calls_kind_check check (kind in ('plan', 'write', 'repair', 'rewrite')),
  constraint story_ai_calls_scope_check check (scope in ('plan', 'book', 'chapter', 'block')),
  constraint story_ai_calls_chapter_id_check check (chapter_id is null or chapter_id ~ '^(c[1-9][0-9]{0,3}|closing)$'),
  constraint story_ai_calls_version_check check (storybook_version is null or storybook_version >= 1),
  constraint story_ai_calls_model_length check (char_length(model) between 1 and 64),
  constraint story_ai_calls_prompt_version_length check (char_length(prompt_version) between 1 and 40),
  constraint story_ai_calls_mode_check check (mode in ('live', 'replay')),
  constraint story_ai_calls_status_check check (status in ('ok', 'error')),
  constraint story_ai_calls_error_check check (
    (status = 'ok' and error is null)
    or (status = 'error' and error is not null and error ~ '^[a-z_]{3,40}$')
  ),
  constraint story_ai_calls_counts_check check (
    input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0
    and cache_write_tokens >= 0 and cost_usd >= 0 and latency_ms >= 0
  )
);

create index story_ai_calls_book_id_idx on public.story_ai_calls (book_id);
create index story_ai_calls_user_id_idx on public.story_ai_calls (user_id);
create index story_ai_calls_created_at_idx on public.story_ai_calls (created_at);

alter table public.story_ai_calls enable row level security;

-- Service role only: no client privileges and no policies.
revoke all on table public.story_ai_calls from anon, authenticated, public;
grant all on table public.story_ai_calls to service_role;
