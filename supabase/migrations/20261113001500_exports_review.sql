-- =============================================================================
-- 20261113001500_exports_review.sql — Milestone 8 review fixes for public.exports
--
-- Additive only: 1400 is applied in production and must not be edited.
--
-- 1) S1 (daily-cap bypass): export rows must SURVIVE cleanup, because
--    create_export_job's daily cap counts the user's rows of the rolling 24 h.
--    Cleanup used to DELETE older ready rows → unlimited renders. Now:
--      status 'superseded' (new) — a former ready row whose PDF object was
--        removed (a newer export of the book is ready, D-051 keeps only the
--        latest) or found missing in Storage. path is cleared, purged_at set.
--      purged_at timestamptz — when the object was removed / found missing.
--      Checks: superseded ⇒ path null, purged_at and finished_at set;
--              purged_at only on superseded rows.
--    The ready-reuse lookup only matches status 'ready', so superseded rows are
--    never reused; the cap counts them (any status).
--
-- 2) N1 renderer version: renderer_version integer not null default 1
--    (1..1000; existing rows = 1, the pre-review renderer). A ready PDF is
--    reused only when its renderer_version equals the caller's
--    (PDF_RENDERER_VERSION in src/lib/pdf/rules.ts, 2 = static print fonts +
--    baseline JPEG encoder), so PDFs from an older renderer are re-rendered.
--
-- 3) public.supersede_exports(p_book uuid, p_user uuid, p_ids uuid[],
--      p_reason text) returns integer
--    Marks the given READY rows of (p_book, p_user) superseded: path null,
--    purged_at = now(), error_code = p_reason (null, or [a-z0-9_]{1,64}, e.g.
--    'missing_file'). Rows in any other status are left alone. Returns the
--    number of rows changed. Never deletes.
--
-- 4) public.create_export_job — new signature (drop + create):
--      (p_book uuid, p_user uuid, p_doc_rev bigint, p_doc jsonb,
--       p_caption_lang text, p_renderer_version integer, p_daily_cap integer,
--       p_stale_seconds integer) returns jsonb
--    Same order as 1400 (lock key 6 → not_found → not_paid → stale_rev → reap
--    → ready → running → daily_cap → insert) with these changes:
--      d) reap (N2): queued rows created ≥ p_stale_seconds ago; rendering rows
--         ONLY when their lease expired (lease_until < now()) AND either the 3
--         claims are used up or the row was created over 1 hour ago. A live
--         lease is never reaped, however old the row.
--      e) ready reuse also requires renderer_version = p_renderer_version.
--      f) running answer adds "state" ('queued' | 'rendering') and
--         "claimable" (queued, or rendering with an expired lease and
--         attempt < 3) — N3: the caller re-kicks a claimable job (claim_export
--         leases an expired rendering row again, at most 3 claims in total).
--      g) cap unchanged: ALL rows created in the rolling 24 h (incl. failed and
--         superseded).
--      h) the insert records p_renderer_version.
--    p_renderer_version must be 1..1000, else 'invalid_argument' (22023).
--
-- All functions: SECURITY INVOKER, search_path '', EXECUTE revoked from
-- public / anon / authenticated, granted to service_role only. No grant changes
-- on the table: clients still read only the 1400 status columns.
--
-- Deploy: apply BEFORE the code that calls the 8-argument create_export_job
-- (the M8 code is not live yet, so nothing calls the dropped 7-argument one).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) + 2) columns and checks
-- ---------------------------------------------------------------------------
alter table public.exports add column purged_at timestamptz;
alter table public.exports add column renderer_version integer not null default 1;

alter table public.exports
  add constraint exports_renderer_version_check check (renderer_version between 1 and 1000);

alter table public.exports drop constraint exports_status_check;
alter table public.exports
  add constraint exports_status_check check (status in ('queued', 'rendering', 'ready', 'failed', 'superseded'));

alter table public.exports
  add constraint exports_superseded_purged check (
    status <> 'superseded' or (path is null and purged_at is not null and finished_at is not null)
  );
alter table public.exports
  add constraint exports_purged_only_superseded check (purged_at is null or status = 'superseded');

-- ---------------------------------------------------------------------------
-- 3) supersede_exports — ready → superseded (never delete: the cap counts rows)
-- ---------------------------------------------------------------------------
create or replace function public.supersede_exports(
  p_book   uuid,
  p_user   uuid,
  p_ids    uuid[],
  p_reason text
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_book is null or p_user is null or p_ids is null
     or (p_reason is not null and p_reason !~ '^[a-z0-9_]{1,64}$') then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  update public.exports as e
     set status     = 'superseded',
         path       = null,
         purged_at  = now(),
         error_code = p_reason
   where e.book_id = p_book
     and e.user_id = p_user
     and e.id = any (p_ids)
     and e.status = 'ready';

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.supersede_exports(uuid, uuid, uuid[], text) from public, anon, authenticated;
grant execute on function public.supersede_exports(uuid, uuid, uuid[], text) to service_role;

-- ---------------------------------------------------------------------------
-- 4) create_export_job — new signature with p_renderer_version
-- ---------------------------------------------------------------------------
drop function public.create_export_job(uuid, uuid, bigint, jsonb, text, integer, integer);

create or replace function public.create_export_job(
  p_book             uuid,
  p_user             uuid,
  p_doc_rev          bigint,
  p_doc              jsonb,
  p_caption_lang     text,
  p_renderer_version integer,
  p_daily_cap        integer,
  p_stale_seconds    integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_paid  boolean;
  v_rev   bigint;
  v_id    uuid;
  v_frev  bigint;
  v_state text;
  v_claim boolean;
  v_n     integer;
begin
  if p_book is null or p_user is null or p_doc_rev is null or p_doc is null
     or p_caption_lang is null or p_renderer_version is null
     or p_daily_cap is null or p_stale_seconds is null
     or p_doc_rev < 0 or jsonb_typeof(p_doc) <> 'object'
     or p_caption_lang not in ('en', 'ar')
     or p_renderer_version not between 1 and 1000
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
     and ((e.status = 'queued'
           and e.created_at <= now() - make_interval(secs => p_stale_seconds))
          or (e.status = 'rendering'
              and e.lease_until < now()
              and (e.attempt >= 3 or e.created_at <= now() - interval '1 hour')));

  select e.id into v_id
    from public.exports as e
   where e.book_id = p_book
     and e.status = 'ready'
     and e.doc_rev = p_doc_rev
     and e.caption_lang = p_caption_lang
     and e.renderer_version = p_renderer_version
   order by e.finished_at desc, e.created_at desc
   limit 1;
  if v_id is not null then
    return jsonb_build_object('status', 'ready', 'export_id', v_id);
  end if;

  select e.id, e.doc_rev, e.status,
         (e.status = 'queued' or (e.lease_until < now() and e.attempt < 3))
    into v_id, v_frev, v_state, v_claim
    from public.exports as e
   where e.book_id = p_book
     and e.status in ('queued', 'rendering')
   limit 1;
  if v_id is not null then
    return jsonb_build_object('status', 'running', 'export_id', v_id, 'doc_rev', v_frev,
                              'state', v_state, 'claimable', coalesce(v_claim, false));
  end if;

  select count(*) into v_n
    from public.exports as e
   where e.user_id = p_user
     and e.created_at > now() - interval '24 hours';
  if v_n >= p_daily_cap then
    return jsonb_build_object('status', 'daily_cap');
  end if;

  insert into public.exports (book_id, user_id, doc_rev, doc, caption_lang, renderer_version, status)
  values (p_book, p_user, p_doc_rev, p_doc, p_caption_lang, p_renderer_version, 'queued')
  returning id into v_id;

  return jsonb_build_object('status', 'created', 'export_id', v_id);
end;
$$;

revoke all on function public.create_export_job(uuid, uuid, bigint, jsonb, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_export_job(uuid, uuid, bigint, jsonb, text, integer, integer, integer)
  to service_role;
