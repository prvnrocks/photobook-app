-- =============================================================================
-- 20261120002500_photo_organize.sql — quality scores, duplicate groups, moments
-- (Task 4)
--
-- Additive only: 0100–2400 must not be edited. No existing table, column,
-- constraint, policy, grant, trigger or function changes. photos.status,
-- photos.dup_group and the stored files are NOT touched by anything here:
-- duplicates and blurry photos are only described, never dropped or deleted.
--
-- 1) public.photo_quality — one row per scored photo: sharpness, exposure,
--    composition, overall (0–100), flags, the raw measurements and the scoring
--    version (src/lib/photos/quality.ts QUALITY_VERSION).
-- 2) public.photo_duplicate_groups — one row per duplicate group of a book:
--    kind (exact | near), member photo ids, the preferred photo and who chose
--    it (auto | user). A user choice survives regrouping.
-- 3) public.photo_moments — one row per moment of a book: member photo ids in
--    order, label + who wrote it (auto | user), the evidence behind the label,
--    hero photo + who chose it, time range, place, confidence and the reasons a
--    grouping is uncertain.
--
-- photo_ids are uuid[] without a foreign key per element: a deleted photo is
-- removed from the arrays the next time the book is organised, and readers
-- ignore ids that no longer exist. All three tables cascade on book delete and
-- on account delete; photo_quality also cascades on photo delete.
--
-- Access (same model as photo_ingest / storybooks): the owner may READ own
-- rows; every write is server-side with the service role after the book owner
-- was checked under RLS. anon has no access.
--
-- Deploy order: additive — apply BEFORE code that calls the Task 4 functions.
-- Nothing in the deployed app calls them yet. Rollback: dropping the three
-- tables is safe while no code uses them.
--
-- rls_check.sql: 181 → 184 checks (+1 each: owner reads own rows only, no
-- client writes, value checks, cascade).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) photo_quality
-- ---------------------------------------------------------------------------
create table public.photo_quality (
  photo_id    uuid primary key references public.photos (id) on delete cascade,
  book_id     uuid not null references public.books (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  version     smallint not null,
  sharpness   numeric(4, 1) not null,
  exposure    numeric(4, 1) not null,
  composition numeric(4, 1) not null,
  overall     numeric(4, 1) not null,
  flags       text[] not null default '{}',
  raw         jsonb not null default '{}'::jsonb,
  scored_at   timestamptz not null default now(),
  constraint photo_quality_version_check check (version >= 1),
  constraint photo_quality_scores_check check (
    sharpness between 0 and 100 and exposure between 0 and 100
    and composition between 0 and 100 and overall between 0 and 100
  ),
  constraint photo_quality_flags_check check (
    flags <@ array['blurry', 'soft', 'underexposed', 'overexposed', 'low_contrast', 'flat']::text[]
  ),
  constraint photo_quality_raw_size check (jsonb_typeof(raw) = 'object' and pg_column_size(raw) <= 2048)
);

create index photo_quality_book_id_idx on public.photo_quality (book_id);
create index photo_quality_user_id_idx on public.photo_quality (user_id);

-- ---------------------------------------------------------------------------
-- 2) photo_duplicate_groups
-- ---------------------------------------------------------------------------
create table public.photo_duplicate_groups (
  id                 uuid primary key default gen_random_uuid(),
  book_id            uuid not null references public.books (id) on delete cascade,
  user_id            uuid not null references auth.users (id) on delete cascade,
  group_key          uuid not null,
  kind               text not null,
  photo_ids          uuid[] not null,
  preferred_photo_id uuid not null,
  preferred_source   text not null default 'auto',
  updated_at         timestamptz not null default now(),
  constraint photo_duplicate_groups_book_key unique (book_id, group_key),
  constraint photo_duplicate_groups_kind_check check (kind in ('exact', 'near')),
  constraint photo_duplicate_groups_size_check check (cardinality(photo_ids) between 2 and 500),
  constraint photo_duplicate_groups_preferred_member check (preferred_photo_id = any (photo_ids)),
  constraint photo_duplicate_groups_source_check check (preferred_source in ('auto', 'user'))
);

create index photo_duplicate_groups_user_id_idx on public.photo_duplicate_groups (user_id);

create trigger photo_duplicate_groups_set_updated_at
  before update on public.photo_duplicate_groups
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) photo_moments
-- ---------------------------------------------------------------------------
create table public.photo_moments (
  id                uuid primary key default gen_random_uuid(),
  book_id           uuid not null references public.books (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  moment_key        text not null,
  position          integer not null,
  photo_ids         uuid[] not null,
  label             text not null,
  label_source      text not null default 'auto',
  date_label        text,
  label_evidence    jsonb not null default '[]'::jsonb,
  hero_photo_id     uuid,
  hero_source       text not null default 'auto',
  starts_at         timestamptz,
  ends_at           timestamptz,
  place             text,
  confidence        numeric(3, 2) not null,
  uncertain         boolean not null default false,
  uncertain_reasons text[] not null default '{}',
  version           smallint not null,
  updated_at        timestamptz not null default now(),
  constraint photo_moments_book_key unique (book_id, moment_key),
  constraint photo_moments_key_format check (moment_key ~ '^m:[0-9a-f-]{36}$'),
  constraint photo_moments_position_check check (position >= 0),
  constraint photo_moments_size_check check (cardinality(photo_ids) between 1 and 500),
  constraint photo_moments_label_length check (char_length(label) between 1 and 160),
  constraint photo_moments_date_label_length check (char_length(date_label) <= 60),
  constraint photo_moments_place_length check (char_length(place) <= 200),
  constraint photo_moments_sources_check check (label_source in ('auto', 'user') and hero_source in ('auto', 'user')),
  constraint photo_moments_hero_member check (hero_photo_id is null or hero_photo_id = any (photo_ids)),
  constraint photo_moments_evidence_check check (jsonb_typeof(label_evidence) = 'array' and pg_column_size(label_evidence) <= 4096),
  constraint photo_moments_confidence_check check (confidence between 0 and 1),
  constraint photo_moments_reasons_check check (
    uncertain_reasons <@ array['weak_boundary', 'weak_join', 'file_dates', 'no_timestamp',
                               'joined_by_content', 'joined_by_place', 'no_evidence']::text[]
  ),
  constraint photo_moments_time_order check (starts_at is null or ends_at is null or starts_at <= ends_at),
  constraint photo_moments_version_check check (version >= 1)
);

create index photo_moments_user_id_idx on public.photo_moments (user_id);

create trigger photo_moments_set_updated_at
  before update on public.photo_moments
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
alter table public.photo_quality          enable row level security;
alter table public.photo_duplicate_groups enable row level security;
alter table public.photo_moments          enable row level security;

revoke all on table public.photo_quality, public.photo_duplicate_groups, public.photo_moments from anon, authenticated, public;
grant all on table public.photo_quality, public.photo_duplicate_groups, public.photo_moments to service_role;

-- Owner may read own rows; all writes server-side.
grant select on table public.photo_quality, public.photo_duplicate_groups, public.photo_moments to authenticated;

create policy "photo_quality_select_own" on public.photo_quality
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "photo_duplicate_groups_select_own" on public.photo_duplicate_groups
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "photo_moments_select_own" on public.photo_moments
  for select to authenticated
  using (user_id = (select auth.uid()));
