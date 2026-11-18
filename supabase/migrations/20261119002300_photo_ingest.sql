-- =============================================================================
-- 20261119002300_photo_ingest.sql — server-side photo ingestion status (Task 2)
--
-- Additive only: 0100–2200 must not be edited. No existing table, column,
-- constraint, policy, grant, trigger, function or bucket changes.
--
-- public.photo_ingest — one row per photo once the SERVER has checked the
-- stored bytes (src/lib/photos/ingest.ts):
--   state        'verified' | 'rejected'
--   reason       rejection code (src/lib/photos/ingest-verify.ts
--                INGEST_REJECT_REASONS); null when verified
--   fingerprint  the photos.fingerprint that was checked — the idempotency key:
--                a photo whose row already names its current fingerprint is
--                never downloaded or checked again
--   original_*   what the server actually found in storage (format, bytes)
--   ai_copy_*    SHA-256 + size of the metadata-free AI analysis copy, and
--                whether the server had to strip metadata from the upload
-- Transient failures (storage timeout) write NO row, so the next run retries.
--
-- Access: owner may READ own rows; every write is server-side (service role),
-- after the route proved book ownership under RLS. anon has no access. Rows go
-- away with the photo, the book or the account (cascade). No paths, names,
-- dates or coordinates are stored here.
--
-- Deploy order: additive — apply BEFORE the code that uses it. The code treats
-- a missing table as "not verified yet" (ingestion is skipped, uploads and AI
-- keep working), so either order is safe.
-- Rollback: older code never touches the table; dropping it is safe.
--
-- rls_check.sql: 179 → 180 checks (+1 photo ingest: owner reads own rows only,
-- no client writes, state / reason / hash checks, cascade on photo delete).
-- =============================================================================

create table public.photo_ingest (
  photo_id          uuid primary key references public.photos (id) on delete cascade,
  book_id           uuid not null references public.books (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  state             text not null,
  reason            text,
  fingerprint       text not null,
  original_format   text,
  original_bytes    integer,
  ai_copy_sha256    text,
  ai_copy_bytes     integer,
  ai_copy_sanitized boolean not null default false,
  attempts          integer not null default 1,
  checked_at        timestamptz not null default now(),
  constraint photo_ingest_state_check check (state in ('verified', 'rejected')),
  constraint photo_ingest_reason_check check (
    (state = 'verified' and reason is null)
    or (state = 'rejected' and reason is not null and reason ~ '^[a-z_]{3,40}$')
  ),
  constraint photo_ingest_fingerprint_length check (char_length(fingerprint) between 16 and 128),
  constraint photo_ingest_original_format_check check (original_format in ('jpeg', 'png', 'webp')),
  constraint photo_ingest_original_bytes_check check (original_bytes > 0),
  constraint photo_ingest_ai_copy_sha256_check check (ai_copy_sha256 ~ '^[0-9a-f]{64}$'),
  constraint photo_ingest_ai_copy_bytes_check check (ai_copy_bytes between 1 and 1048576),
  constraint photo_ingest_attempts_check check (attempts >= 1),
  constraint photo_ingest_verified_complete check (
    state <> 'verified'
    or (original_format is not null and original_bytes is not null
        and ai_copy_sha256 is not null and ai_copy_bytes is not null)
  )
);

create index photo_ingest_book_id_idx on public.photo_ingest (book_id);
create index photo_ingest_user_id_idx on public.photo_ingest (user_id);

alter table public.photo_ingest enable row level security;

revoke all on table public.photo_ingest from anon, authenticated, public;
grant all on table public.photo_ingest to service_role;

-- Owner may read own rows (upload summary); all writes server-side.
grant select on table public.photo_ingest to authenticated;

create policy "photo_ingest_select_own" on public.photo_ingest
  for select to authenticated
  using (user_id = (select auth.uid()));
