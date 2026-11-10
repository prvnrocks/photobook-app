# PGlite DB dry-run

Applies every migration and the RLS test script to an in-process Postgres (PGlite, WASM) — no Docker,
no Supabase project, ~seconds.

```sh
npm run db:dry-run                                   # stubs -> all migrations -> supabase/tests/rls_check.sql
npm run db:dry-run -- --until=20261111001100         # only migrations whose filename prefix <= value
npm run db:dry-run -- --rls=path/to/other_check.sql  # alternate RLS script
git show HEAD:supabase/tests/rls_check.sql | npm run db:dry-run -- --rls=-   # RLS script from stdin
npm run db:dry-run -- --no-rls                       # migrations only
# backfill dry run: seed rows right before a migration, then run a matching check instead of rls_check
npm run db:dry-run -- --seed=scripts/pglite/seeds/1900_design.sql --seed-before=20261115001900 \
  --rls=scripts/pglite/checks/1900_design.sql
```

`--seed=<file>` runs as `postgres` immediately before the first selected migration whose filename is
`>= --seed-before`. Seeds live in `scripts/pglite/seeds/`, their checks in `scripts/pglite/checks/`
(same "RLS OK — all N checks passed" convention as `rls_check.sql`).

Env vars `DRY_RUN_UNTIL` / `DRY_RUN_RLS` work too. Exit code 0 only when `rls_check.sql` raises its
intentional `RLS OK — all N checks passed` exception; otherwise it prints the failing file, the line
(when Postgres reports a position) and the error message/detail/hint/where.

## What `stubs.sql` fakes

- Roles `anon`, `authenticated`, `service_role` (`bypassrls`).
- `auth.users` (subset of columns), `auth.uid()` / `auth.role()` / `auth.jwt()` reading
  `request.jwt.claims` like PostgREST does.
- `storage.buckets` / `storage.objects` tables with RLS enabled, `storage.foldername()`.
- Supabase-like default privileges in `public` (tables, sequences, functions granted to all API roles),
  so missing `revoke`s in migrations show up.

## What it does NOT check

- Storage API behaviour: bucket `allowed_mime_types` / `file_size_limit` enforcement, signed URLs.
- Drift between these stubs and real Supabase grants/defaults (e.g. new platform defaults, `postgres`
  vs `supabase_admin` ownership, extensions installed in `extensions`).
- Auth (GoTrue) triggers/hooks, Realtime, `pg_cron`, `pg_net`, Vault, and any extension PGlite lacks.
- PostgREST behaviour (exposed schemas, `db-max-rows`, RPC argument parsing).
- Postgres version differences (PGlite tracks a recent PG 17).

Always still run `supabase/tests/rls_check.sql` against the real project after `npx supabase db push`.
