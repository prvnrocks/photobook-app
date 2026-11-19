-- =============================================================================
-- 20261123002800_storybook_runs.sql — storybook generation jobs (Task 8)
--
-- Additive only: 0100–2700 must not be edited.
--
-- One storybook generation job = one public.agent_runs row with trigger
-- 'storybook' (src/lib/ai/story/run.ts). It reuses the D-022 machinery: the
-- client drives resumable ticks, each tick takes the DB lease
-- (claim_agent_run), does bounded work, checkpoints its cursor / progress
-- under the lease token and releases. The four storybook stages are real
-- states of the row:
--   discovering  photo analysis (Task 3) + quality / duplicates (Task 4)
--   organizing   moments (Task 4) + story plan (Task 6 planStory)
--   writing      narrative, one chapter group per tick (Task 6 writeStory)
--   designing    page composition (Task 7 composeStorybookPages)
-- then done / failed. A user "Stop" is state 'failed' with error_code
-- 'cancelled' (no new terminal state: every "active = not done / failed"
-- rule — the one-active-run-per-book index, claim, the reaper, the cleanup
-- index — keeps working unchanged).
--
-- 1) agent_runs_trigger_check gains 'storybook' and agent_runs_state_check the
--    four stage states — each dropped and re-added inside ONE alter table
--    statement (no moment without a check; every existing row satisfies the
--    wider lists). The one-active-run-per-book index (0900: not done / failed,
--    trigger <> 'rewrite') is NOT touched: a storybook run and a build /
--    rebuild run of the same book exclude each other, exactly like two builds.
-- 2) agent_runs_storybook_state_check: the stage states belong to storybook
--    runs only, and an unfinished storybook run is always in one of them —
--    never 'queued' (so no build code path that starts from 'queued' + empty
--    cursor can mistake it for a fresh build; lessons 2026-11-10, two run
--    kinds in one table). Existing rows: no storybook rows, and no build /
--    rewrite row can be in a stage state (the old state check forbade them).
-- 3) claim_agent_run (latest: 0900) also leases storybook runs. Same
--    signature → privileges kept; re-stated anyway. Rewrite runs stay refused.
-- 4) create_agent_run_capped (latest: 0700) — same signature and every
--    existing behaviour, plus: a storybook run is inserted in state
--    'discovering'; the D-026 daily count also counts LIVE storybook runs
--    that are still active or finished ok / partial (their model calls are
--    billed in photo_analyses / story_ai_calls, not agent_steps, so
--    total_cost_usd stays 0 and cannot be the test). The rebuild cap stays
--    'rebuild'-only. Story limits per book live in story_ai_calls (2600).
-- 5) reap_stale_agent_runs (latest: 1600) — same signature and behaviour,
--    plus: stale storybook runs are reaped on the updated_at rule (like
--    builds; ticks touch updated_at), and books.ai_status is only restored
--    for build / rebuild runs (storybook runs never change books.ai_status).
--
-- Privileges: all replaced functions are SECURITY INVOKER with search_path ''
-- (only service_role calls them; a DEFINER function would bypass the books
-- column guard). EXECUTE stays revoked from public / anon / authenticated.
-- Clients keep their 0700 column grants on agent_runs (progress / state /
-- error_code readable by the owner; cursor never).
--
-- Deploy order: migration FIRST, then the code. Old code never creates
-- storybook runs and every old lookup filters by trigger in ('build',
-- 'rebuild') or 'rewrite', so the widened checks / functions change nothing
-- for it. New code against a database without 2800 fails to create a
-- storybook run (trigger check) → the start route answers 503
-- story_unavailable and the wizard says so; nothing is half-written.
-- Rollback: narrowing the checks back is only possible while no row has
-- trigger 'storybook' or a stage state — fail / delete those rows first, then
-- restore the 0900 / 0700 / 1600 function bodies.
--
-- rls_check.sql: 186 → 187 checks (+1 storybook runs: stage states only with
-- trigger 'storybook', never 'queued', one active run per book shared with
-- builds, claim leases a storybook run but still refuses rewrites, capped
-- creation inserts 'discovering', owner can't write runs).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Wider trigger + state checks (one alter table statement each)
-- ---------------------------------------------------------------------------
alter table public.agent_runs
  drop constraint agent_runs_trigger_check,
  add constraint agent_runs_trigger_check check (trigger in ('build', 'rebuild', 'rewrite', 'storybook'));

alter table public.agent_runs
  drop constraint agent_runs_state_check,
  add constraint agent_runs_state_check check (
    state in ('queued', 'curating', 'storytelling', 'captioning', 'critiquing',
              'repairing', 'validating', 'rewriting',
              'discovering', 'organizing', 'writing', 'designing',
              'done', 'failed')
  );

-- ---------------------------------------------------------------------------
-- 2) Stage states belong to storybook runs, and an unfinished storybook run is
--    always in a stage state (never 'queued')
-- ---------------------------------------------------------------------------
alter table public.agent_runs
  add constraint agent_runs_storybook_state_check check (
    (state in ('discovering', 'organizing', 'writing', 'designing'))
      = (trigger = 'storybook' and state not in ('done', 'failed'))
  );

-- ---------------------------------------------------------------------------
-- 3) claim_agent_run (0900) + 'storybook'
-- ---------------------------------------------------------------------------
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
     and r.trigger in ('build', 'rebuild', 'storybook')
     and r.state not in ('done', 'failed')
     and (r.lease_until is null or r.lease_until < now());

  if not found then
    return null;
  end if;
  return v_token;
end;
$$;

revoke all on function public.claim_agent_run(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_agent_run(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4) create_agent_run_capped (0700) + storybook runs
--
-- Returns jsonb: {"id": uuid} | {"error": "already_running"}
--              | {"error": "limit", "limit": "daily_builds" | "rebuilds"}.
-- Unchanged for build / rebuild. For p_trigger = 'storybook': inserted in
-- state 'discovering'; counted in daily_builds while active or after a live
-- ok / partial finish. The unique index agent_runs_one_active_per_book_idx →
-- already_running (also against an active build of the same book).
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
       and r.started_at >= now() - interval '24 hours'
       and (
         (r.trigger in ('build', 'rebuild')
           and (r.total_cost_usd > 0 or r.state not in ('done', 'failed')))
         or (r.trigger = 'storybook'
           and (r.state not in ('done', 'failed') or r.ai_status in ('ok', 'partial')))
       );
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
    insert into public.agent_runs (book_id, user_id, trigger, mode, state)
    values (p_book_id, p_user_id, p_trigger, p_mode,
            case when p_trigger = 'storybook' then 'discovering' else 'queued' end)
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
-- 5) reap_stale_agent_runs (1600) + storybook runs (updated_at rule; no
--    books.ai_status restore for them)
-- ---------------------------------------------------------------------------
create or replace function public.reap_stale_agent_runs(p_hours integer)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n     integer;
  v_books uuid[];
  v_prev  text[];
begin
  if p_hours is null or p_hours < 1 or p_hours > 720 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  with reaped as (
    update public.agent_runs as r
       set state       = 'failed',
           ai_status   = 'failed',
           error_code  = 'stale',
           finished_at = now(),
           lease_until = null,
           lease_token = null,
           progress    = case
                           when jsonb_typeof(r.progress) = 'object'
                             then r.progress || '{"phase":"failed"}'::jsonb
                           else r.progress
                         end
     where r.state not in ('done', 'failed')
       and (r.lease_until is null or r.lease_until < now())
       and (
         (r.trigger in ('build', 'rebuild', 'storybook') and r.updated_at < now() - make_interval(hours => p_hours))
         or (r.trigger = 'rewrite' and r.started_at < now() - make_interval(hours => p_hours))
       )
    returning r.book_id, r.trigger, r.cursor ->> 'prevBookStatus' as prev
  )
  select count(*)::integer,
         array_agg(x.book_id) filter (where x.trigger in ('build', 'rebuild') and x.book_id is not null),
         array_agg(x.prev)    filter (where x.trigger in ('build', 'rebuild') and x.book_id is not null)
    into v_n, v_books, v_prev
    from reaped as x;

  if v_books is null then
    return v_n;
  end if;

  -- Separate statement (fresh snapshot): sees the runs just failed above.
  update public.books as b
     set ai_status = case
                       when coalesce(jsonb_typeof(b.doc -> 'pages'), '') <> 'array' then 'failed'
                       when jsonb_array_length(b.doc -> 'pages') = 0 then 'failed'
                       when s.prev in ('idle', 'done', 'partial', 'failed') then s.prev
                       else 'idle'
                     end
    from (
      select distinct on (u.bid) u.bid, u.prev
        from unnest(v_books, v_prev) as u (bid, prev)
       order by u.bid
    ) as s
   where b.id = s.bid
     and b.ai_status in ('analyzing', 'planning', 'captioning')
     and not exists (
       select 1 from public.agent_runs as a
        where a.book_id = b.id
          and a.trigger in ('build', 'rebuild')
          and a.state not in ('done', 'failed')
     );

  return v_n;
end;
$$;

revoke all on function public.reap_stale_agent_runs(integer) from public, anon, authenticated;
grant execute on function public.reap_stale_agent_runs(integer) to service_role;
