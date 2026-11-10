-- Dry-run seed for 20261115001900_design.sql (run before it, as postgres):
--   npm run db:dry-run -- --seed=scripts/pglite/seeds/1900_design.sql --seed-before=20261115001900 \
--     --rls=scripts/pglite/checks/1900_design.sql
-- Books with docs the backfill must (and must not) copy from; dry_run.expect keeps what each
-- row must look like afterwards (doc / doc_rev / updated_at unchanged).
create schema dry_run;
create table dry_run.expect (
  id uuid primary key,
  format text not null,
  design_style text not null,
  doc jsonb not null,
  doc_rev bigint not null,
  updated_at timestamptz not null
);

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000001900', 'seed1900@example.test');

with seed (id, doc, format, design_style) as (values
  -- v2 landscape, modern → both copied
  ('00000000-0000-4000-8000-000000000001'::uuid,
   '{"version":2,"format":"A5_LANDSCAPE","style":{"background":{"kind":"color","hex":"#FFFFFF"},"designStyle":"modern","font":"Playfair"},"pages":[],"meta":{}}'::jsonb,
   'A5_LANDSCAPE', 'modern'),
  -- v2 landscape without designStyle → format only
  ('00000000-0000-4000-8000-000000000002',
   '{"version":2,"format":"A5_LANDSCAPE","style":{"background":{"kind":"color","hex":"#FFFFFF"},"font":"Playfair"},"pages":[]}',
   'A5_LANDSCAPE', 'classic'),
  -- v1 portrait → defaults (already equal, row not touched)
  ('00000000-0000-4000-8000-000000000003',
   '{"version":1,"format":"A5_PORTRAIT","style":{"background":"#FFFFFF","font":"Playfair"},"pages":[]}',
   'A5_PORTRAIT', 'classic'),
  -- empty draft → defaults
  ('00000000-0000-4000-8000-000000000004', '{}', 'A5_PORTRAIT', 'classic'),
  -- invalid values → defaults (never copied)
  ('00000000-0000-4000-8000-000000000005',
   '{"version":2,"format":"A4","style":{"designStyle":"baroque"}}',
   'A5_PORTRAIT', 'classic'),
  -- wrong JSON shapes → defaults, no error
  ('00000000-0000-4000-8000-000000000006', '{"format":7,"style":"modern"}', 'A5_PORTRAIT', 'classic'),
  -- portrait + geometric → style only
  ('00000000-0000-4000-8000-000000000007',
   '{"version":2,"format":"A5_PORTRAIT","style":{"background":{"kind":"color","hex":"#FFFFFF"},"designStyle":"geometric","font":"Playfair"},"pages":[]}',
   'A5_PORTRAIT', 'geometric')
)
insert into dry_run.expect (id, format, design_style, doc, doc_rev, updated_at)
select id, format, design_style, doc, 7, '2026-01-01T00:00:00Z' from seed;

insert into public.books (id, user_id, title, doc)
select id, '00000000-0000-4000-8000-000000001900', 'seed 1900', doc from dry_run.expect;
-- doc_rev / updated_at are trigger-managed; set the expected values without bumps.
alter table public.books disable trigger user;
update public.books as b set doc_rev = e.doc_rev, updated_at = e.updated_at from dry_run.expect as e where e.id = b.id;
alter table public.books enable trigger user;
