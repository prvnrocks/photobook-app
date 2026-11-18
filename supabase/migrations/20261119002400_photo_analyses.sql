-- =============================================================================
-- 20261119002400_photo_analyses.sql — Photo Intelligence cache + usage log (Task 3)
--
-- Additive only: 0100–2300 must not be edited. No existing table, column,
-- constraint, policy, grant, trigger or function changes.
--
-- public.photo_analyses — one row per model call of src/lib/ai/photo-intelligence:
--   status 'ok'    the validated analysis (PhotoVision JSON) + what it cost.
--                  CACHE KEY: (user_id, image_sha256, model, prompt_version) —
--                  unique among ok rows. image_sha256 is the SHA-256 of the
--                  metadata-free AI copy that was sent, so the same pixels are
--                  never analysed twice with the same model and prompt.
--                  The key includes user_id on purpose: a cache shared between
--                  users would reveal that someone else uploaded the same image.
--   status 'error' a call that produced no usable analysis (refusal, timeout,
--                  invalid output): error code + the tokens it still cost, so
--                  spend accounting is complete. Never served from the cache.
--   Per row: model, prompt_version, token usage, cost_usd, latency_ms, mode
--   (live | replay).
--
-- Access: SERVICE ROLE ONLY, like agent_steps (D-027): no client grants and no
-- policies. The analysis holds a description of the photo's content, which is
-- never sent to the browser as is. Rows are deleted with the photo, the book or
-- the account (cascade) — "delete AI notes with the photo".
--
-- Deploy order: additive — apply BEFORE code that calls analyzePhoto() in live
-- mode (the service refuses live calls while the table is missing, because it
-- could neither cache nor count them). Nothing in the deployed app calls it yet.
-- Rollback: older code never touches the table; dropping it is safe.
--
-- rls_check.sql: 180 → 181 checks (+1 photo analyses: no client access at all,
-- one ok row per cache key, error rows unlimited, checks, cascade).
-- =============================================================================

create table public.photo_analyses (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  book_id            uuid not null references public.books (id) on delete cascade,
  photo_id           uuid not null references public.photos (id) on delete cascade,
  image_sha256       text not null,
  model              text not null,
  prompt_version     text not null,
  mode               text not null,
  status             text not null,
  analysis           jsonb,
  error              text,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd           numeric(10, 6) not null default 0,
  latency_ms         integer not null default 0,
  created_at         timestamptz not null default now(),
  constraint photo_analyses_image_sha256_check check (image_sha256 ~ '^[0-9a-f]{64}$'),
  constraint photo_analyses_model_length check (char_length(model) between 1 and 64),
  constraint photo_analyses_prompt_version_length check (char_length(prompt_version) between 1 and 40),
  constraint photo_analyses_mode_check check (mode in ('live', 'replay')),
  constraint photo_analyses_status_check check (status in ('ok', 'error')),
  constraint photo_analyses_ok_has_analysis check (
    (status = 'ok' and analysis is not null and jsonb_typeof(analysis) = 'object' and error is null)
    or (status = 'error' and analysis is null and error is not null and error ~ '^[a-z_]{3,40}$')
  ),
  constraint photo_analyses_analysis_size check (pg_column_size(analysis) <= 16384),
  constraint photo_analyses_counts_check check (
    input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0
    and cache_write_tokens >= 0 and cost_usd >= 0 and latency_ms >= 0
  )
);

-- The cache key: at most one usable analysis per user + image + model + prompt.
create unique index photo_analyses_cache_key_idx
  on public.photo_analyses (user_id, image_sha256, model, prompt_version)
  where status = 'ok';

create index photo_analyses_book_id_idx on public.photo_analyses (book_id);
create index photo_analyses_photo_id_idx on public.photo_analyses (photo_id);
create index photo_analyses_created_at_idx on public.photo_analyses (created_at);

alter table public.photo_analyses enable row level security;

-- Service role only: no client privileges and no policies.
revoke all on table public.photo_analyses from anon, authenticated, public;
grant all on table public.photo_analyses to service_role;
