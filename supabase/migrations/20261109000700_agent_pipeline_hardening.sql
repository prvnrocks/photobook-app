-- =============================================================================
-- 20261109000700_agent_pipeline_hardening.sql — M3 review fixes (T16) for 0600
--
-- Additive only: 0100–0600 are applied and must not be edited.
--
-- 1) Lease tokens (T16 #1). agent_runs.lease_token: claim_agent_run now returns
--    a fresh token (or null); release_agent_run(p_run_id, p_token) only clears a
--    lease it still owns. A tick whose lease expired and was re-claimed by
--    another tick can therefore neither release nor checkpoint (stale tick).
--    Checkpoints check the token client-side: src/lib/db/agent-runs.ts updates
--    with `.eq('lease_token', token)` and treats 0 rows as stale (service role
--    is the only writer, so no RPC is needed for that).
-- 2) create_agent_run_capped (T16 #4 / #5): atomic per-user daily-build cap and
--    per-book rebuild cap + insert, serialised by a per-user advisory lock, so
--    parallel starts on different books can't both slip under the cap.
-- 3) Column-level SELECT on agent_runs for authenticated (T16 #6): owners can
--    no longer read cursor (photo ids), lease_token, attempts or costs/tokens.
--    The RLS policy agent_runs_select_own is unchanged.
-- 4) Scrub on book delete also clears agent_runs.cursor / progress (T16 #7).
-- 5) Cost columns widened to numeric(12, 6) (T16 #16) — run totals no longer
--    round to 4 decimals, so total == sum of steps exactly.
--
-- D-021 still holds: no client-writable counters; usage is derived from
-- agent_runs / agent_steps. All new / replaced functions are SECURITY INVOKER
-- and executable by service_role only (Supabase default privileges grant
-- EXECUTE on new public functions to authenticated → revoked explicitly).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 5) Cost precision (done first: cheap, no dependencies)
-- ---------------------------------------------------------------------------
alter table public.agent_runs  alter column total_cost_usd type numeric(12, 6);
alter table public.agent_steps alter column cost_usd       type numeric(12, 6);

-- ---------------------------------------------------------------------------
-- 1) Lease tokens
-- ---------------------------------------------------------------------------
alter table public.agent_runs add column lease_token uuid;

-- The return type changes (boolean → uuid) and release gains a parameter, so
-- the 0600 versions are dropped (CREATE OR REPLACE can't change either). Old
-- callers fail loudly instead of silently releasing someone else's lease.
drop function public.claim_agent_run(uuid, integer);
drop function public.release_agent_run(uuid);

-- Takes the lease on an active run if nobody holds it (or it expired) and
-- returns a NEW token; null when the lease is held or the run is done/failed/
-- missing. Atomic: concurrent callers serialise on the row lock; the loser
-- re-checks lease_until after the winner commits and updates 0 rows → null.
create or replace function public.claim_agent_run(p_run_id uuid, p_lease_seconds integer)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_secs  integer;
  v_token uuid;
begin
  if p_run_id is null or p_lease_seconds is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  v_secs := least(300, greatest(5, p_lease_seconds));
  v_token := gen_random_uuid();

  update public.agent_runs as r
     set lease_until = now() + make_interval(secs => v_secs),
         lease_token = v_token,
         attempts = r.attempts + 1
   where r.id = p_run_id
     and r.state not in ('done', 'failed')
     and (r.lease_until is null or r.lease_until < now());

  if not found then
    return null;
  end if;
  return v_token;
end;
$$;

-- Releases the lease only when p_token is the current token (no-op otherwise,
-- including a null token), so a stale tick can't free a lease another tick holds.
create or replace function public.release_agent_run(p_run_id uuid, p_token uuid)
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
     set lease_until = null,
         lease_token = null
   where r.id = p_run_id
     and r.lease_token = p_token;
end;
$$;

revoke all on function public.claim_agent_run(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_agent_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_agent_run(uuid, integer) to service_role;
grant execute on function public.release_agent_run(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Capped run creation
--
-- Returns jsonb: {"id": uuid} | {"error": "already_running"}
--              | {"error": "limit", "limit": "daily_builds" | "rebuilds"}.
--
-- pg_advisory_xact_lock on the user id serialises all starts of one user
-- (released at commit), so count + insert is atomic per user. Under READ
-- COMMITTED each statement after the lock sees the previous holder's commit.
--
-- When p_enforce (live mode only; replay/rule runs are never capped):
--   daily_builds: live build/rebuild runs of the user started in the last 24 h
--     that cost something (total_cost_usd > 0) OR are still active (state not
--     done/failed). Cost is only known after the first call is logged, so an
--     in-progress run with cost 0 must count too or N parallel starts would all
--     pass; a run that finished/failed without any billed call does not count
--     (T16 #5: failures that cost nothing don't consume the cap).
--   rebuilds (trigger 'rebuild' only): live rebuild runs of this book that cost
--     something and ended ok/partial. Active rebuilds need no counting — the
--     one-active-run-per-book index already rejects a second one.
-- The unique index agent_runs_one_active_per_book_idx → already_running.
-- ---------------------------------------------------------------------------
create or replace function public.create_agent_run_capped(
  p_book_id     uuid,
  p_user_id     uuid,
  p_trigger     text,
  p_mode        text,
  p_daily_cap   integer,
  p_rebuild_cap integer,
  p_enforce     boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n  integer;
  v_id uuid;
begin
  if p_book_id is null or p_user_id is null or p_trigger is null or p_mode is null
     or p_enforce is null
     or (p_enforce and (p_daily_cap is null or p_rebuild_cap is null)) then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1));

  if p_enforce then
    select count(*) into v_n
      from public.agent_runs as r
     where r.user_id = p_user_id
       and r.mode = 'live'
       and r.trigger in ('build', 'rebuild')
       and r.started_at >= now() - interval '24 hours'
       and (r.total_cost_usd > 0 or r.state not in ('done', 'failed'));
    if v_n >= p_daily_cap then
      return jsonb_build_object('error', 'limit', 'limit', 'daily_builds');
    end if;

    if p_trigger = 'rebuild' then
      select count(*) into v_n
        from public.agent_runs as r
       where r.book_id = p_book_id
         and r.mode = 'live'
         and r.trigger = 'rebuild'
         and r.total_cost_usd > 0
         and r.ai_status in ('ok', 'partial');
      if v_n >= p_rebuild_cap then
        return jsonb_build_object('error', 'limit', 'limit', 'rebuilds');
      end if;
    end if;
  end if;

  begin
    insert into public.agent_runs (book_id, user_id, trigger, mode)
    values (p_book_id, p_user_id, p_trigger, p_mode)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('error', 'already_running');
  end;

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_agent_run_capped(uuid, uuid, text, text, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.create_agent_run_capped(uuid, uuid, text, text, integer, integer, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3) Owners read only the progress-screen columns of their runs
--    (src/lib/db/agent-runs.ts OWNER_RUN_COLUMNS ⊆ this list).
-- ---------------------------------------------------------------------------
revoke select on table public.agent_runs from authenticated;
grant select (id, book_id, user_id, state, ai_status, progress, error_code, mode, trigger, started_at, finished_at)
  on public.agent_runs to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Scrub on book delete: steps' output / input_summary (0600) and now also
--    the run's cursor (photo ids, plan) and progress. Costs, tokens and
--    statuses are kept for usage accounting. Still SECURITY INVOKER: it fires
--    inside the FK's ON DELETE SET NULL, which runs as the table owner.
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
    new.cursor := '{}'::jsonb;
    new.progress := '{}'::jsonb;
  end if;
  return new;
end;
$$;

revoke all on function private.scrub_agent_steps() from public, anon, authenticated;
