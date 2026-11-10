-- =============================================================================
-- 20261110000900_editor.sql — Milestone 5: editor (D-036, D-037)
--
-- Additive only: 0100–0800 are applied and must not be edited.
--
-- 1) books.doc_rev bigint: optimistic-concurrency revision of books.doc. Bumped
--    by the BEFORE UPDATE trigger books_set_doc_rev only when doc actually
--    changes (jsonb IS DISTINCT FROM, i.e. semantic). Nobody sets it directly:
--    the trigger always derives it from old.doc_rev.
-- 2) D-036: books.doc / page_count / doc_rev become server-only.
--    private.protect_book_columns now also keeps the old values of these three
--    columns on UPDATE and forces '{}' / 0 / 0 on INSERT for non-service
--    callers. Editor saves go through PUT /api/books/[id]/doc (admin client,
--    WHERE doc_rev = baseRev); finalize / AI / Update album already write with
--    the admin client after an ownership check (src/lib/db/books.ts).
--    Trigger order: BEFORE triggers fire alphabetically, so
--      books_protect_columns  (resets doc for clients)
--      books_set_doc_rev      (sees the reset doc → no bump for clients)
--      books_set_updated_at
--    "books_set_doc_rev" must keep sorting after "books_protect_columns".
-- 3) D-037 (6): rewrite runs are excluded from the one-active-run-per-book
--    index, so a caption rewrite can run while a build / rebuild is active.
--    At most one rewrite per book in flight is enforced by
--    create_rewrite_run_capped (advisory lock per user) instead.
-- 4) public.create_rewrite_run_capped: atomic per-book rewrite cap + per-user
--    daily ceiling + insert.
-- 5) Rewrite runs never look like builds (M5 review B1): new state 'rewriting'
--    (rewrite runs are inserted with it, never 'queued'), and claim_agent_run
--    refuses rewrite runs, so the build tick machinery can never lease one.
--
-- Privileges: all new / replaced functions are SECURITY INVOKER with
-- search_path '' (same model as 0700: the only caller is service_role, which
-- has the table privileges itself; a DEFINER function would bypass the books
-- column guard — see the WARNING below). EXECUTE on the RPC is revoked from
-- public / anon / authenticated (Supabase default privileges grant it to
-- authenticated) and granted to service_role only.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) books.doc_rev + bump trigger
-- ---------------------------------------------------------------------------
alter table public.books add column doc_rev bigint not null default 0;

alter table public.books
  add constraint books_doc_rev_check check (doc_rev >= 0);

create or replace function private.set_book_doc_rev()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.doc is distinct from old.doc then
    new.doc_rev := old.doc_rev + 1;
  else
    new.doc_rev := old.doc_rev;
  end if;
  return new;
end;
$$;

revoke all on function private.set_book_doc_rev() from public, anon, authenticated;

create trigger books_set_doc_rev
  before update on public.books
  for each row execute function private.set_book_doc_rev();

-- ---------------------------------------------------------------------------
-- 2) Column guard: same as 0600, plus doc / page_count / doc_rev (D-036).
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
    new.is_paid      := false;
    new.max_pages    := 20;
    new.expires_at   := null;
    new.slug         := null;
    new.published_at := null;
    new.ai_status    := 'idle';
    new.doc          := '{}'::jsonb;
    new.page_count   := 0;
    new.doc_rev      := 0;
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
    new.doc          := old.doc;
    new.page_count   := old.page_count;
    new.doc_rev      := old.doc_rev;
  end if;

  return new;
end;
$$;

revoke all on function private.protect_book_columns() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) One active run per book — excluding rewrite runs (D-037 (6)).
-- ---------------------------------------------------------------------------
drop index public.agent_runs_one_active_per_book_idx;

create unique index agent_runs_one_active_per_book_idx
  on public.agent_runs (book_id)
  where state not in ('done', 'failed') and trigger <> 'rewrite';

-- ---------------------------------------------------------------------------
-- 4) Rewrite runs get their own state (M5 review B1).
--
-- A rewrite run is one bounded request: it is inserted as state 'rewriting'
-- and finished done/failed by the same request. It is never 'queued', so no
-- build code path that starts a run from 'queued' + empty cursor can mistake
-- it for a fresh build. App code additionally filters every build-run lookup
-- by trigger in ('build', 'rebuild') and the orchestrator refuses other
-- triggers before claiming.
-- ---------------------------------------------------------------------------
alter table public.agent_runs drop constraint agent_runs_state_check;
alter table public.agent_runs
  add constraint agent_runs_state_check check (
    state in ('queued', 'curating', 'storytelling', 'captioning', 'critiquing',
              'repairing', 'validating', 'rewriting', 'done', 'failed')
  );

alter table public.agent_runs
  add constraint agent_runs_rewriting_state_check check (
    (state = 'rewriting') = (trigger = 'rewrite' and state not in ('done', 'failed'))
  );

-- claim_agent_run (0700) + "and r.trigger in ('build', 'rebuild')": a rewrite
-- run can never be leased by a build tick. Same signature → privileges kept;
-- re-stated below anyway.
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
     and r.trigger in ('build', 'rebuild')
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
-- 5) Capped rewrite-run creation
--
-- Returns jsonb: {"id": uuid} | {"error": "already_running"}
--              | {"error": "limit", "limit": "rewrites"}
--              | {"error": "daily_limit"} | {"error": "not_found"}.
--
-- pg_advisory_xact_lock on the USER id (key space 3; create_agent_run_capped
-- uses key space 1) serialises all rewrite starts of one user — and therefore
-- of each of their books — so stale-fail + checks + insert are atomic for both
-- the per-book cap and the per-user daily ceiling.
--
--   not_found:       p_book does not exist or is not owned by p_user
--                    (defence in depth; the route checks ownership first).
--   stale reaping:   a rewrite is one bounded model call (≤ ~60 s request), so
--                    an unfinished rewrite run of this book started more than
--                    5 minutes ago is a crashed request: it is failed here
--                    (state failed, ai_status failed, error_code 'stale') so it
--                    never stays active (or blocks the book) forever.
--   already_running: a rewrite run of this book is still in flight (max 1,
--                    D-037 (6)).
--   When p_enforce:
--   daily_limit:     ALL rewrite runs of the user (any book, any outcome,
--                    incl. failed / refused / stale) started in the last 24 h
--                    >= p_daily_cap. Cost ceiling (M5 review S1): failed
--                    rewrites never count toward the per-book cap, so without
--                    this a client could retry failing rewrites forever.
--   limit:           rewrite runs of this book that finished with
--                    ai_status = 'ok' plus the ones in flight >= p_cap. Failed /
--                    refused rewrites never count (D-037 (6)). Not filtered by
--                    mode: the caller decides enforcement via p_enforce.
-- ---------------------------------------------------------------------------
create or replace function public.create_rewrite_run_capped(
  p_book      uuid,
  p_user      uuid,
  p_mode      text,
  p_cap       integer,
  p_daily_cap integer,
  p_enforce   boolean
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
  if p_book is null or p_user is null or p_mode is null or p_enforce is null
     or (p_enforce and (p_cap is null or p_daily_cap is null)) then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 3));

  if not exists (
    select 1 from public.books as b where b.id = p_book and b.user_id = p_user
  ) then
    return jsonb_build_object('error', 'not_found');
  end if;

  update public.agent_runs as r
     set state       = 'failed',
         ai_status   = 'failed',
         error_code  = 'stale',
         finished_at = now()
   where r.book_id = p_book
     and r.trigger = 'rewrite'
     and r.state not in ('done', 'failed')
     and r.started_at <= now() - interval '5 minutes';

  select count(*) into v_n
    from public.agent_runs as r
   where r.book_id = p_book
     and r.trigger = 'rewrite'
     and r.state not in ('done', 'failed');
  if v_n > 0 then
    return jsonb_build_object('error', 'already_running');
  end if;

  if p_enforce then
    select count(*) into v_n
      from public.agent_runs as r
     where r.user_id = p_user
       and r.trigger = 'rewrite'
       and r.started_at > now() - interval '24 hours';
    if v_n >= p_daily_cap then
      return jsonb_build_object('error', 'daily_limit');
    end if;

    select count(*) into v_n
      from public.agent_runs as r
     where r.book_id = p_book
       and r.trigger = 'rewrite'
       and (r.ai_status = 'ok' or r.state not in ('done', 'failed'));
    if v_n >= p_cap then
      return jsonb_build_object('error', 'limit', 'limit', 'rewrites');
    end if;
  end if;

  insert into public.agent_runs (book_id, user_id, trigger, mode, state)
  values (p_book, p_user, 'rewrite', p_mode, 'rewriting')
  returning id into v_id;

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_rewrite_run_capped(uuid, uuid, text, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.create_rewrite_run_capped(uuid, uuid, text, integer, integer, boolean)
  to service_role;
