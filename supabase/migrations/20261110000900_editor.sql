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
--    create_rewrite_run_capped (advisory lock per book) instead.
-- 4) public.create_rewrite_run_capped: atomic per-book rewrite cap + insert.
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
-- 4) Capped rewrite-run creation
--
-- Returns jsonb: {"id": uuid} | {"error": "already_running"}
--              | {"error": "limit", "limit": "rewrites"} | {"error": "not_found"}.
--
-- pg_advisory_xact_lock on the book id (key space 2; create_agent_run_capped
-- uses the user id in key space 1) serialises all rewrite starts of one book,
-- so check + insert is atomic per book.
--
--   not_found:       p_book does not exist or is not owned by p_user
--                    (defence in depth; the route checks ownership first).
--   already_running: a rewrite run of this book is still in flight (max 1,
--                    D-037 (6)). "In flight" = not done/failed AND started in
--                    the last 5 minutes — a rewrite is one bounded model call,
--                    so an older unfinished run is a crashed request and must
--                    not block the book (or count toward the cap) forever.
--   limit (only when p_enforce): rewrite runs of this book that finished with
--                    ai_status = 'ok' plus those in flight >= p_cap. Failed /
--                    refused rewrites never count (D-037 (6)). Not filtered by
--                    mode: the caller decides enforcement via p_enforce.
-- ---------------------------------------------------------------------------
create or replace function public.create_rewrite_run_capped(
  p_book    uuid,
  p_user    uuid,
  p_mode    text,
  p_cap     integer,
  p_enforce boolean
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
     or (p_enforce and p_cap is null) then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_book::text, 2));

  if not exists (
    select 1 from public.books as b where b.id = p_book and b.user_id = p_user
  ) then
    return jsonb_build_object('error', 'not_found');
  end if;

  select count(*) into v_n
    from public.agent_runs as r
   where r.book_id = p_book
     and r.trigger = 'rewrite'
     and r.state not in ('done', 'failed')
     and r.started_at > now() - interval '5 minutes';
  if v_n > 0 then
    return jsonb_build_object('error', 'already_running');
  end if;

  if p_enforce then
    select count(*) into v_n
      from public.agent_runs as r
     where r.book_id = p_book
       and r.trigger = 'rewrite'
       and (
         r.ai_status = 'ok'
         or (r.state not in ('done', 'failed') and r.started_at > now() - interval '5 minutes')
       );
    if v_n >= p_cap then
      return jsonb_build_object('error', 'limit', 'limit', 'rewrites');
    end if;
  end if;

  insert into public.agent_runs (book_id, user_id, trigger, mode)
  values (p_book, p_user, 'rewrite', p_mode)
  returning id into v_id;

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_rewrite_run_capped(uuid, uuid, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.create_rewrite_run_capped(uuid, uuid, text, integer, boolean)
  to service_role;
