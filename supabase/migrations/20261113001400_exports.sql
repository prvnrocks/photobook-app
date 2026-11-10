-- =============================================================================
-- 20261113001400_exports.sql — Milestone 8: PDF export jobs (D-047, D-051)
--
-- Additive only: 0100–1300 are applied in production and must not be edited.
--
-- 1) public.exports — one row per PDF render job. The doc is SNAPSHOTTED into
--    the row (D-047: the PDF renders books.doc as saved, no publish needed), so
--    later edits never change a job in flight.
--      id           uuid pk
--      book_id      → books   on delete cascade
--      user_id      → auth.users on delete cascade (same as books.user_id)
--      doc_rev      bigint    books.doc_rev the snapshot was taken at
--      doc          jsonb     snapshot (object, ≤ 1 MiB like books.doc)
--      caption_lang text      'en' | 'ar' (books check)
--      status       queued → rendering → ready | failed
--      path         {user_id}/{book_id}/{id}.pdf in bucket `exports` (0200);
--                   exact match enforced by a check
--      bytes        1 .. 52428800 (bucket limit 50 MB)
--      page_count   PDF pages, 1 .. 1000
--      error_code   [a-z0-9_]{1,64} — a code, never a message
--      attempt      claims so far (claim_export refuses after 3)
--      lease_token / lease_until  render lease (claim_export)
--      created_at, finished_at
--    Consistency checks: ready ⇒ path, bytes, page_count, finished_at set;
--    failed ⇒ error_code, finished_at set; rendering ⇒ lease set.
--    Indexes: (book_id, doc_rev) where ready (reuse lookup); (user_id,
--    created_at) (daily cap); UNIQUE (book_id) where queued / rendering — at
--    most one job in flight per book (D-051), defence in depth for the RPC.
--    Rows cascade with the book / user; the PDF objects in Storage do NOT —
--    cleanup is the caller's job (listOlderReadyExports / book delete path).
--
-- 2) RLS on. Policy exports_select_own (owner reads own rows). Grants:
--    everything revoked from public / anon / authenticated; authenticated gets
--    column-level SELECT on (id, book_id, doc_rev, status, bytes, page_count,
--    error_code, created_at, finished_at) only — never doc, path, user_id,
--    caption_lang, attempt or the lease. No client INSERT / UPDATE / DELETE:
--    only the service role writes (through the RPCs below).
--
-- 3) public.create_export_job(p_book uuid, p_user uuid, p_doc_rev bigint,
--      p_doc jsonb, p_caption_lang text, p_daily_cap integer,
--      p_stale_seconds integer) returns jsonb
--    Under pg_advisory_xact_lock(hashtextextended(p_user, 6)) — key space 6 is
--    new (in use: 0 photo cap, 1 create_agent_run_capped, 3
--    create_rewrite_run_capped, 4/5 try_book_unlock / clear_unlock_attempt):
--      a) book missing or not owned by p_user     → {"status":"not_found"}
--      b) book not paid (live books.is_paid)      → {"status":"not_paid"}
--      c) p_doc_rev <> books.doc_rev (the doc was
--         saved again since the caller read it)   → {"status":"stale_rev",
--                                                    "doc_rev": <current>}
--      d) reap: the user's queued / rendering rows created ≥ p_stale_seconds
--         ago, or rendering with an expired lease → failed, error_code 'stale'
--      e) a ready row for (p_book, p_doc_rev, p_caption_lang) → newest one:
--                                                   {"status":"ready","export_id"}
--      f) a queued / rendering row for p_book     → {"status":"running",
--                                                    "export_id","doc_rev"}
--      g) rows of the user created in the last 24 h (rolling, ANY status —
--         failures cost compute too) ≥ p_daily_cap → {"status":"daily_cap"}
--      h) insert queued                           → {"status":"created","export_id"}
--    Invalid args (nulls, doc not an object, lang not en/ar, cap < 0, stale
--    window outside 60..86400 s, doc_rev < 0) → 'invalid_argument' (22023).
--
-- 4) public.claim_export(p_export uuid, p_lease_seconds integer) returns uuid
--    Leases a queued row, or a rendering row whose lease expired, while
--    attempt < 3: status rendering, attempt + 1, new lease_token, lease_until =
--    now() + clamp(p_lease_seconds, 30, 900) s. Returns the token, or null when
--    not claimable (missing, ready, failed, leased, attempts used up).
--
-- 5) public.finish_export(p_export uuid, p_token uuid, p_path text,
--      p_bytes bigint, p_pages integer) returns boolean
--    Only for status rendering AND lease_token = p_token: status ready, path,
--    bytes, page_count, finished_at = now(), lease cleared. false otherwise (a
--    reaped / re-claimed job's old worker stops silently; it must delete the
--    object it uploaded). A wrong path / size violates the table checks (23514).
--
-- 6) public.fail_export(p_export uuid, p_token uuid, p_code text) returns boolean
--    Same token rule: status failed, error_code, finished_at, lease cleared.
--
-- All four RPCs: SECURITY INVOKER, search_path '', EXECUTE revoked from
-- public / anon / authenticated (Supabase default privileges grant it to
-- authenticated), granted to service_role only.
--
-- Deploy: safe before the M8 code (new table + new functions only).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) public.exports
-- ---------------------------------------------------------------------------
create table public.exports (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references public.books (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  doc_rev      bigint not null,
  doc          jsonb not null,
  caption_lang text not null default 'en',
  status       text not null default 'queued',
  path         text,
  bytes        bigint,
  page_count   integer,
  error_code   text,
  attempt      integer not null default 0,
  lease_token  uuid,
  lease_until  timestamptz,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  constraint exports_doc_rev_check check (doc_rev >= 0),
  constraint exports_doc_object check (jsonb_typeof(doc) = 'object'),
  constraint exports_doc_size check (pg_column_size(doc) <= 1048576),
  constraint exports_caption_lang_check check (caption_lang in ('en', 'ar')),
  constraint exports_status_check check (status in ('queued', 'rendering', 'ready', 'failed')),
  constraint exports_path_owner check (
    path is null or path = (user_id::text || '/' || book_id::text || '/' || id::text || '.pdf')
  ),
  constraint exports_bytes_check check (bytes is null or bytes between 1 and 52428800),
  constraint exports_page_count_check check (page_count is null or page_count between 1 and 1000),
  constraint exports_error_code_format check (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$'),
  constraint exports_attempt_check check (attempt >= 0),
  constraint exports_ready_complete check (
    status <> 'ready'
    or (path is not null and bytes is not null and page_count is not null and finished_at is not null)
  ),
  constraint exports_failed_complete check (
    status <> 'failed' or (error_code is not null and finished_at is not null)
  ),
  constraint exports_rendering_leased check (
    status <> 'rendering' or (lease_token is not null and lease_until is not null)
  )
);

create index exports_book_ready_idx on public.exports (book_id, doc_rev) where status = 'ready';
create index exports_user_created_idx on public.exports (user_id, created_at);
create unique index exports_one_active_per_book on public.exports (book_id)
  where status in ('queued', 'rendering');

-- ---------------------------------------------------------------------------
-- 2) RLS + grants
-- ---------------------------------------------------------------------------
alter table public.exports enable row level security;

revoke all on table public.exports from public, anon, authenticated;
grant all on table public.exports to service_role;

-- Owners read only the status columns (src/lib/db/exports.ts OWNER_EXPORT_COLUMNS ⊆ this list).
grant select (id, book_id, doc_rev, status, bytes, page_count, error_code, created_at, finished_at)
  on public.exports to authenticated;

create policy "exports_select_own" on public.exports
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3) create_export_job — capped, deduplicated job creation (semantics in header)
-- ---------------------------------------------------------------------------
create or replace function public.create_export_job(
  p_book          uuid,
  p_user          uuid,
  p_doc_rev       bigint,
  p_doc           jsonb,
  p_caption_lang  text,
  p_daily_cap     integer,
  p_stale_seconds integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_paid boolean;
  v_rev  bigint;
  v_id   uuid;
  v_frev bigint;
  v_n    integer;
begin
  if p_book is null or p_user is null or p_doc_rev is null or p_doc is null
     or p_caption_lang is null or p_daily_cap is null or p_stale_seconds is null
     or p_doc_rev < 0 or jsonb_typeof(p_doc) <> 'object'
     or p_caption_lang not in ('en', 'ar')
     or p_daily_cap < 0 or p_stale_seconds not between 60 and 86400 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 6));

  select b.is_paid, b.doc_rev into v_paid, v_rev
    from public.books as b
   where b.id = p_book and b.user_id = p_user;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not v_paid then
    return jsonb_build_object('status', 'not_paid');
  end if;
  if p_doc_rev <> v_rev then
    return jsonb_build_object('status', 'stale_rev', 'doc_rev', v_rev);
  end if;

  update public.exports as e
     set status      = 'failed',
         error_code  = 'stale',
         finished_at = now(),
         lease_token = null,
         lease_until = null
   where e.user_id = p_user
     and e.status in ('queued', 'rendering')
     and (e.created_at <= now() - make_interval(secs => p_stale_seconds)
          or (e.status = 'rendering' and e.lease_until < now()));

  select e.id into v_id
    from public.exports as e
   where e.book_id = p_book
     and e.status = 'ready'
     and e.doc_rev = p_doc_rev
     and e.caption_lang = p_caption_lang
   order by e.finished_at desc, e.created_at desc
   limit 1;
  if v_id is not null then
    return jsonb_build_object('status', 'ready', 'export_id', v_id);
  end if;

  select e.id, e.doc_rev into v_id, v_frev
    from public.exports as e
   where e.book_id = p_book
     and e.status in ('queued', 'rendering')
   limit 1;
  if v_id is not null then
    return jsonb_build_object('status', 'running', 'export_id', v_id, 'doc_rev', v_frev);
  end if;

  select count(*) into v_n
    from public.exports as e
   where e.user_id = p_user
     and e.created_at > now() - interval '24 hours';
  if v_n >= p_daily_cap then
    return jsonb_build_object('status', 'daily_cap');
  end if;

  insert into public.exports (book_id, user_id, doc_rev, doc, caption_lang, status)
  values (p_book, p_user, p_doc_rev, p_doc, p_caption_lang, 'queued')
  returning id into v_id;

  return jsonb_build_object('status', 'created', 'export_id', v_id);
end;
$$;

revoke all on function public.create_export_job(uuid, uuid, bigint, jsonb, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_export_job(uuid, uuid, bigint, jsonb, text, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4) claim_export — render lease
-- ---------------------------------------------------------------------------
create or replace function public.claim_export(p_export uuid, p_lease_seconds integer)
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
  if p_export is null or p_lease_seconds is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  v_secs := least(900, greatest(30, p_lease_seconds));
  v_token := gen_random_uuid();

  update public.exports as e
     set status      = 'rendering',
         attempt     = e.attempt + 1,
         lease_token = v_token,
         lease_until = now() + make_interval(secs => v_secs)
   where e.id = p_export
     and e.attempt < 3
     and (e.status = 'queued'
          or (e.status = 'rendering' and e.lease_until < now()));

  if not found then
    return null;
  end if;
  return v_token;
end;
$$;

revoke all on function public.claim_export(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_export(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5) finish_export — ready (lease holder only)
-- ---------------------------------------------------------------------------
create or replace function public.finish_export(
  p_export uuid,
  p_token  uuid,
  p_path   text,
  p_bytes  bigint,
  p_pages  integer
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_export is null or p_token is null or p_path is null or p_bytes is null or p_pages is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  update public.exports as e
     set status      = 'ready',
         path        = p_path,
         bytes       = p_bytes,
         page_count  = p_pages,
         finished_at = now(),
         lease_token = null,
         lease_until = null
   where e.id = p_export
     and e.status = 'rendering'
     and e.lease_token = p_token;

  return found;
end;
$$;

revoke all on function public.finish_export(uuid, uuid, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.finish_export(uuid, uuid, text, bigint, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6) fail_export — failed (lease holder only)
-- ---------------------------------------------------------------------------
create or replace function public.fail_export(p_export uuid, p_token uuid, p_code text)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_export is null or p_token is null or p_code is null or p_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  update public.exports as e
     set status      = 'failed',
         error_code  = p_code,
         finished_at = now(),
         lease_token = null,
         lease_until = null
   where e.id = p_export
     and e.status = 'rendering'
     and e.lease_token = p_token;

  return found;
end;
$$;

revoke all on function public.fail_export(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_export(uuid, uuid, text) to service_role;
