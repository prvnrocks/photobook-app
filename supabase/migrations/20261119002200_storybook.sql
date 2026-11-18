-- =============================================================================
-- 20261119002200_storybook.sql — AI Balanced Storybook foundation (Task 1)
--
-- Additive only: 0100–2100 are applied in production and must not be edited.
-- No existing table, column, constraint, policy, grant, trigger or function
-- changes. Nothing in the deployed code reads or writes these tables yet.
--
-- 1) public.storybooks — one row per book: the user's memory context
--    (src/lib/storybook/schemas.ts MemoryContextSchema, {} until written), the
--    pointer to the current story version and the balance target (0.35
--    narrative = the 65 / 35 Balanced Storybook).
-- 2) public.storybook_versions — immutable snapshots of the whole story
--    (StorybookSchema JSON). Every AI run and every saved user edit appends a
--    version; rows are never updated (trigger), only pruned (delete) by the
--    service role. `origin` says who produced it (ai | user | merge | rule),
--    `run_id` links an AI version to agent_runs for cost / audit.
--
-- Access (same model as books.doc and agent_runs): the owner may READ own
-- rows; every write is server-side with the service role, after zod
-- validation. anon has no access. Narrative text and memory context are user
-- data: both tables cascade on book delete and on account delete.
--
-- Deploy order: additive — apply BEFORE any code that uses the tables. Old
-- code keeps working with or without this migration.
-- Rollback: redeploying older code needs no database change. Dropping the two
-- tables is safe while no code uses them.
--
-- rls_check.sql: 177 → 179 checks (+1 storybooks: owner reads own row only,
-- no client writes; +1 storybook versions: owner reads own versions only, no
-- client writes, versions are immutable, version numbers unique per book,
-- book delete cascades).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) storybooks
-- ---------------------------------------------------------------------------
create table public.storybooks (
  book_id                uuid primary key references public.books (id) on delete cascade,
  user_id                uuid not null references auth.users (id) on delete cascade,
  status                 text not null default 'empty',
  context                jsonb not null default '{}'::jsonb,
  context_rev            integer not null default 0,
  current_version        integer not null default 0,
  target_narrative_share numeric(3, 2) not null default 0.35,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint storybooks_status_check check (status in ('empty', 'drafting', 'ready', 'failed')),
  constraint storybooks_context_object check (jsonb_typeof(context) = 'object'),
  constraint storybooks_context_size check (pg_column_size(context) <= 16384),
  constraint storybooks_context_rev_check check (context_rev >= 0),
  constraint storybooks_current_version_check check (current_version >= 0),
  constraint storybooks_target_check check (target_narrative_share between 0 and 1)
);

create index storybooks_user_id_idx on public.storybooks (user_id);

create trigger storybooks_set_updated_at
  before update on public.storybooks
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) storybook_versions
-- ---------------------------------------------------------------------------
create table public.storybook_versions (
  id             uuid primary key default gen_random_uuid(),
  book_id        uuid not null references public.storybooks (book_id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  version        integer not null,
  parent_version integer,
  origin         text not null,
  run_id         uuid references public.agent_runs (id) on delete set null,
  schema_version smallint not null default 1,
  content        jsonb not null,
  generator      jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint storybook_versions_book_version_key unique (book_id, version),
  constraint storybook_versions_version_check check (version >= 1),
  constraint storybook_versions_parent_check check (parent_version is null or (parent_version >= 1 and parent_version < version)),
  constraint storybook_versions_origin_check check (origin in ('ai', 'user', 'merge', 'rule')),
  constraint storybook_versions_schema_version_check check (schema_version >= 1),
  constraint storybook_versions_content_object check (jsonb_typeof(content) = 'object'),
  constraint storybook_versions_content_size check (pg_column_size(content) <= 1048576),
  constraint storybook_versions_generator_size check (pg_column_size(generator) <= 4096)
);

create index storybook_versions_user_id_idx on public.storybook_versions (user_id);
create index storybook_versions_run_id_idx on public.storybook_versions (run_id) where run_id is not null;

-- Versions are append-only: the only UPDATE that may touch a row is the
-- ON DELETE SET NULL of run_id (an agent run being deleted).
create function private.storybook_versions_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id             is distinct from old.id
     or new.book_id        is distinct from old.book_id
     or new.user_id        is distinct from old.user_id
     or new.version        is distinct from old.version
     or new.parent_version is distinct from old.parent_version
     or new.origin         is distinct from old.origin
     or new.schema_version is distinct from old.schema_version
     or new.content        is distinct from old.content
     or new.generator      is distinct from old.generator
     or new.created_at     is distinct from old.created_at
     or (new.run_id is not null and new.run_id is distinct from old.run_id) then
    raise exception 'storybook_versions rows are immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.storybook_versions_immutable() from public, anon, authenticated;

create trigger storybook_versions_immutable
  before update on public.storybook_versions
  for each row execute function private.storybook_versions_immutable();

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
alter table public.storybooks         enable row level security;
alter table public.storybook_versions enable row level security;

revoke all on table public.storybooks, public.storybook_versions from anon, authenticated, public;
grant all on table public.storybooks, public.storybook_versions to service_role;

-- Owner may read own rows; all writes server-side.
grant select on table public.storybooks, public.storybook_versions to authenticated;

create policy "storybooks_select_own" on public.storybooks
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "storybook_versions_select_own" on public.storybook_versions
  for select to authenticated
  using (user_id = (select auth.uid()));
