-- =============================================================================
-- 20261108000100_init_schema.sql — Milestone 1: core schema + RLS
--
-- Creates the four core tables from docs/PLAN.md → "Database tables":
--   profiles, books, photos, orders
-- (agent_runs / agent_steps / user_memory come in Milestone 3.)
--
-- Security model (see decisions D-002, D-011):
--   * RLS is ON for every table; all policies are owner-only and `to authenticated`.
--     There are NO anon/public policies. Public read of published books is added
--     in the next migration via a security-definer function (get_published_book).
--   * Server-only book columns (is_paid, max_pages, expires_at, slug, published_at)
--     and books.user_id are guarded by a trigger: non-privileged callers cannot set
--     or change them. Only the service role (Stripe webhook, publish step, cron)
--     and postgres/supabase_admin (migrations, SQL editor) can.
--   * orders are readable by their owner, written only by the service role.
--     orders.user_id/book_id are ON DELETE SET NULL so payment history survives.
--   * Helper functions live in schema `private`, which is not exposed via the API.
--     Every function uses `set search_path = ''` and fully-qualified names.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Private schema for helper / trigger functions (not exposed by PostgREST)
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text,
  created_at timestamptz not null default now()
);

create table public.books (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  title         text,
  occasion      text,
  tone          text,
  caption_lang  text not null default 'en',
  slug          text,
  doc           jsonb not null default '{}'::jsonb,
  page_count    integer not null default 0,
  ai_status     text not null default 'idle',
  is_paid       boolean not null default false,
  max_pages     integer not null default 20,
  password_hash text,
  published_at  timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint books_slug_key unique (slug),
  constraint books_title_length check (char_length(title) <= 120),
  constraint books_caption_lang_check check (caption_lang in ('en', 'ar')),
  constraint books_ai_status_check check (
    ai_status in ('idle', 'analyzing', 'planning', 'captioning', 'done', 'failed')
  ),
  constraint books_max_pages_check check (max_pages between 1 and 100),
  constraint books_page_count_check check (page_count >= 0)
);

create table public.photos (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  book_id       uuid not null references public.books (id) on delete cascade,
  original_path text,
  web_path      text,
  thumb_path    text,
  width         integer,
  height        integer,
  taken_at      timestamptz,
  date_source   text,
  lat           double precision,
  lng           double precision,
  place         text,
  camera        text,
  phash         text,
  blur_score    real,
  dup_group     integer,
  ai            jsonb,
  status        text not null default 'kept',
  drop_reason   text,
  user_override boolean not null default false,
  created_at    timestamptz not null default now(),
  constraint photos_date_source_check check (date_source in ('exif', 'file')),
  constraint photos_lat_check check (lat between -90 and 90),
  constraint photos_lng_check check (lng between -180 and 180),
  constraint photos_status_check check (status in ('kept', 'dropped'))
);

create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users (id) on delete set null,
  book_id           uuid references public.books (id) on delete set null,
  type              text not null,
  amount            integer not null,          -- minor units (fils); AED 39 = 3900
  currency          text not null default 'aed',
  status            text not null default 'pending',
  stripe_session_id text,
  created_at        timestamptz not null default now(),
  constraint orders_stripe_session_id_key unique (stripe_session_id),
  constraint orders_type_check check (type in ('digital', 'print')),
  constraint orders_status_check check (status in ('pending', 'paid', 'failed', 'refunded')),
  constraint orders_amount_check check (amount >= 0)
);

-- ---------------------------------------------------------------------------
-- Indexes (unique indexes on books.slug / orders.stripe_session_id come from
-- the unique constraints above)
-- ---------------------------------------------------------------------------
create index books_user_id_updated_at_idx on public.books (user_id, updated_at desc);
create index photos_book_id_taken_at_idx  on public.photos (book_id, taken_at);
create index photos_user_id_idx           on public.photos (user_id);
create index orders_user_id_idx           on public.orders (user_id);
create index orders_book_id_idx           on public.orders (book_id);

-- ---------------------------------------------------------------------------
-- Functions + triggers
-- ---------------------------------------------------------------------------

-- updated_at maintenance (security invoker: needs no extra privileges)
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger books_set_updated_at
  before update on public.books
  for each row execute function private.set_updated_at();

-- Create a profile row for every new auth user.
-- SECURITY DEFINER is required: the insert into auth.users runs as
-- supabase_auth_admin, which has no privileges on public.profiles.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Guard server-only book columns (D-011).
--
-- Privilege check: `current_user`.
--   * Must be SECURITY INVOKER — under SECURITY DEFINER current_user would be the
--     function owner (postgres) and every caller would look privileged.
--   * PostgREST does `SET ROLE` to the role of the request: requests made with the
--     secret key (sb_secret_…) or the legacy service_role JWT run as the
--     `service_role` Postgres role; browser/user requests run as `anon` /
--     `authenticated`. That role switch cannot be faked by the client.
--   * Migrations, SQL editor and pg_cron run as postgres / supabase_admin.
--   * We deliberately do NOT rely on auth.role() / JWT claims: with the new
--     secret keys there is no user-supplied JWT, and request.jwt.claims is a
--     GUC whose content says nothing about the actual executing role (it is
--     also empty for direct DB connections). current_user is the ground truth.
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
  elsif tg_op = 'UPDATE' then
    new.is_paid      := old.is_paid;
    new.max_pages    := old.max_pages;
    new.expires_at   := old.expires_at;
    new.slug         := old.slug;
    new.published_at := old.published_at;
    new.user_id      := old.user_id;
  end if;

  return new;
end;
$$;

create trigger books_protect_columns
  before insert or update on public.books
  for each row execute function private.protect_book_columns();

-- Functions are only invoked by triggers (trigger firing does not check EXECUTE).
revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.books    enable row level security;
alter table public.photos   enable row level security;
alter table public.orders   enable row level security;

-- TRUNCATE bypasses RLS; API roles never need it.
revoke truncate on public.profiles, public.books, public.photos, public.orders
  from anon, authenticated;

-- profiles: read/update own. No insert (trigger) / delete (cascade from auth.users).
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- books: full CRUD on own rows (server-only columns guarded by trigger).
create policy "books_select_own" on public.books
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "books_insert_own" on public.books
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "books_update_own" on public.books
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "books_delete_own" on public.books
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- photos: own rows, and the target book must also be owned by the caller.
create policy "photos_select_own" on public.photos
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "photos_insert_own" on public.photos
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.books b
      where b.id = book_id and b.user_id = (select auth.uid())
    )
  );

create policy "photos_update_own" on public.photos
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.books b
      where b.id = book_id and b.user_id = (select auth.uid())
    )
  );

create policy "photos_delete_own" on public.photos
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- orders: owner can read; only the service role writes (Stripe webhook).
create policy "orders_select_own" on public.orders
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke insert, update, delete on public.orders from anon, authenticated;
