-- =============================================================================
-- 20261108000600_agent_pipeline.sql — Milestone 3: AI agent pipeline tables
--
-- Additive only: 0100–0500 are applied and must not be edited.
--
-- 1) public.agent_runs   one row per AI build / rebuild / caption rewrite (D-022:
--                        client-driven resumable ticks guarded by a DB lease).
-- 2) public.agent_steps  one row per agent call attempt (tokens, cost, latency,
--                        output). Replaces the earlier `ai_usage` idea.
-- 3) public.user_memory  per-user style preferences (Memory Keeper).
-- 4) claim_agent_run / release_agent_run: service-role-only lease RPCs.
-- 5) books.ai_status gains 'partial' and becomes server-only.
-- 6) Deleting a book scrubs its runs' step outputs (privacy) but keeps costs.
--
-- D-021 — AI status and usage counters are server-side only. There are NO
--   counter columns a client could reset: rebuilds, analysed photos, builds per
--   day and caption rewrites are always derived server-side by counting
--   agent_runs / agent_steps / photos.ai. Clients can never write agent_runs or
--   agent_steps (no INSERT/UPDATE/DELETE grants; only service_role writes), and
--   books.ai_status is forced by private.protect_book_columns.
--
-- D-027 — AI trace privacy. agent_steps holds model output, so clients get no
--   privileges on it at all (admin traces are read server-side with the service
--   role, limited to ADMIN_USER_IDS). Curator step output must only contain ids /
--   keep / reason / quality / scene / coverWorthy — descriptions live in
--   photos.ai and are deleted with the photo. When a book is deleted its runs
--   survive with book_id = null (so cost history and daily caps stay correct),
--   but a trigger nulls output / input_summary of all their steps.
--
-- Privilege notes (see .agentos/memory/lessons.md):
--   * Supabase's default privileges grant ALL on new public tables to anon and
--     authenticated, and EXECUTE on new public functions to authenticated
--     (0300 only removed public/anon) — so everything is revoked explicitly.
--   * FK actions (ON DELETE SET NULL / CASCADE) run as the owner of the
--     referencing table (postgres) with RLS not applied, so a user deleting
--     their own book through RLS needs no privileges on agent_runs/agent_steps.
--     Inside the triggers fired by that set-null, current_user = postgres.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) agent_runs
-- ---------------------------------------------------------------------------
create table public.agent_runs (
  id                  uuid primary key default gen_random_uuid(),
  book_id             uuid references public.books (id) on delete set null,
  user_id             uuid references auth.users (id) on delete set null,
  trigger             text not null,
  mode                text not null,
  state               text not null default 'queued',
  ai_status           text,
  progress            jsonb not null default '{}'::jsonb,
  cursor              jsonb not null default '{}'::jsonb,
  lease_until         timestamptz,
  attempts            integer not null default 0,
  error_code          text,
  critic_score        numeric(3, 1),
  total_cost_usd      numeric(10, 4) not null default 0,
  total_input_tokens  integer not null default 0,
  total_output_tokens integer not null default 0,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  updated_at          timestamptz not null default now(),
  constraint agent_runs_trigger_check check (trigger in ('build', 'rebuild', 'rewrite')),
  constraint agent_runs_mode_check check (mode in ('live', 'replay', 'rule')),
  constraint agent_runs_state_check check (
    state in ('queued', 'curating', 'storytelling', 'captioning', 'critiquing',
              'repairing', 'validating', 'done', 'failed')
  ),
  constraint agent_runs_ai_status_check check (ai_status in ('ok', 'partial', 'failed')),
  constraint agent_runs_progress_size check (pg_column_size(progress) <= 4096),
  constraint agent_runs_cursor_size check (pg_column_size(cursor) <= 65536),
  constraint agent_runs_error_code_length check (char_length(error_code) <= 64),
  constraint agent_runs_attempts_check check (attempts >= 0),
  constraint agent_runs_totals_check check (
    total_cost_usd >= 0 and total_input_tokens >= 0 and total_output_tokens >= 0
  )
);

-- At most one active (not done/failed) run per book.
create unique index agent_runs_one_active_per_book_idx
  on public.agent_runs (book_id)
  where state not in ('done', 'failed');

create index agent_runs_user_id_started_at_idx on public.agent_runs (user_id, started_at desc);

create trigger agent_runs_set_updated_at
  before update on public.agent_runs
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) agent_steps
-- ---------------------------------------------------------------------------
create table public.agent_steps (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid not null references public.agent_runs (id) on delete cascade,
  agent              text not null,
  step_key           text not null,
  attempt            smallint not null default 1,
  status             text not null,
  input_summary      jsonb,
  output             jsonb,
  model              text,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd           numeric(10, 6) not null default 0,
  latency_ms         integer,
  stop_reason        text,
  error              text,
  created_at         timestamptz not null default now(),
  constraint agent_steps_run_step_attempt_key unique (run_id, step_key, attempt),
  constraint agent_steps_agent_check check (
    agent in ('curator', 'storyteller', 'caption_writer', 'critic', 'rewriter', 'memory_keeper')
  ),
  constraint agent_steps_status_check check (status in ('ok', 'error', 'refused', 'skipped')),
  constraint agent_steps_step_key_length check (char_length(step_key) <= 64),
  constraint agent_steps_attempt_check check (attempt >= 1),
  constraint agent_steps_input_summary_size check (pg_column_size(input_summary) <= 8192),
  constraint agent_steps_output_size check (pg_column_size(output) <= 262144),
  constraint agent_steps_model_length check (char_length(model) <= 64),
  constraint agent_steps_stop_reason_length check (char_length(stop_reason) <= 32),
  constraint agent_steps_error_length check (char_length(error) <= 200),
  constraint agent_steps_counts_check check (
    input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0
    and cache_write_tokens >= 0 and cost_usd >= 0
  )
);

create index agent_steps_run_id_created_at_idx on public.agent_steps (run_id, created_at);

-- ---------------------------------------------------------------------------
-- 3) user_memory
-- ---------------------------------------------------------------------------
create table public.user_memory (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint user_memory_prefs_size check (pg_column_size(prefs) <= 8192)
);

create trigger user_memory_set_updated_at
  before update on public.user_memory
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
alter table public.agent_runs  enable row level security;
alter table public.agent_steps enable row level security;
alter table public.user_memory enable row level security;

revoke all on table public.agent_runs, public.agent_steps, public.user_memory from anon, authenticated, public;
grant all on table public.agent_runs, public.agent_steps, public.user_memory to service_role;

-- agent_runs: owner may read own runs (progress screen); all writes server-side.
grant select on table public.agent_runs to authenticated;

create policy "agent_runs_select_own" on public.agent_runs
  for select to authenticated
  using (user_id = (select auth.uid()));

-- agent_steps: no client privileges and no policies (service role only, D-027).

-- user_memory: owner may read and forget (delete) own prefs; written server-side.
grant select, delete on table public.user_memory to authenticated;

create policy "user_memory_select_own" on public.user_memory
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "user_memory_delete_own" on public.user_memory
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4) Run lease RPCs (D-022). SECURITY INVOKER: they need the service role's own
--    privileges; called only by src/lib/db with the admin client after the
--    route has checked ownership.
-- ---------------------------------------------------------------------------

-- Takes the lease on an active run if nobody holds it (or it expired).
-- Atomic: concurrent callers serialise on the row lock; the loser re-checks
-- lease_until after the winner commits and updates 0 rows → false.
create or replace function public.claim_agent_run(p_run_id uuid, p_lease_seconds integer)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_secs integer;
begin
  if p_run_id is null or p_lease_seconds is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  v_secs := least(300, greatest(5, p_lease_seconds));

  update public.agent_runs as r
     set lease_until = now() + make_interval(secs => v_secs),
         attempts = r.attempts + 1
   where r.id = p_run_id
     and r.state not in ('done', 'failed')
     and (r.lease_until is null or r.lease_until < now());

  return found;
end;
$$;

-- Releases the lease (end of a tick) so the next advance can claim at once.
create or replace function public.release_agent_run(p_run_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_run_id is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  update public.agent_runs as r
     set lease_until = null
   where r.id = p_run_id;
end;
$$;

revoke all on function public.claim_agent_run(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_agent_run(uuid) from public, anon, authenticated;
grant execute on function public.claim_agent_run(uuid, integer) to service_role;
grant execute on function public.release_agent_run(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5) books.ai_status: add 'partial' (D-021) and make it server-only
-- ---------------------------------------------------------------------------
alter table public.books drop constraint books_ai_status_check;
alter table public.books
  add constraint books_ai_status_check check (
    ai_status in ('idle', 'analyzing', 'planning', 'captioning', 'done', 'partial', 'failed')
  );

-- Same as 0300, plus ai_status forced for non-privileged callers.
--
-- Must stay SECURITY INVOKER: the privilege check is `current_user` (see the
-- full rationale in 20261108000100_init_schema.sql).
--
-- WARNING: any future SECURITY DEFINER function owned by postgres that writes
-- to public.books bypasses this guard (inside it current_user = the owner,
-- postgres). Such functions must enforce these rules themselves.
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
    new.ai_status    := 'idle';
  elsif tg_op = 'UPDATE' then
    new.id           := old.id;
    new.created_at   := old.created_at;
    new.is_paid      := old.is_paid;
    new.max_pages    := old.max_pages;
    new.expires_at   := old.expires_at;
    new.slug         := old.slug;
    new.published_at := old.published_at;
    new.user_id      := old.user_id;
    new.ai_status    := old.ai_status;
  end if;

  return new;
end;
$$;

revoke all on function private.protect_book_columns() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) Scrub step outputs when a run loses its book (book deleted, D-027)
--
-- Fires inside the ON DELETE SET NULL of agent_runs.book_id, which Postgres
-- runs as the table owner — so SECURITY INVOKER is enough (verified with a
-- user deleting their own book through RLS in supabase/tests/rls_check.sql).
-- Costs, tokens and statuses are kept for usage accounting.
-- ---------------------------------------------------------------------------
create or replace function private.scrub_agent_steps()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.book_id is not null and new.book_id is null then
    update public.agent_steps as s
       set output = null,
           input_summary = null
     where s.run_id = new.id
       and (s.output is not null or s.input_summary is not null);
  end if;
  return new;
end;
$$;

create trigger agent_runs_scrub_steps
  before update of book_id on public.agent_runs
  for each row execute function private.scrub_agent_steps();

revoke all on function private.scrub_agent_steps() from public, anon, authenticated;
