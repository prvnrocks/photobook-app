-- Dry-run check for the 20261115001900_design.sql backfill; pairs with scripts/pglite/seeds/1900_design.sql
-- (see that file for the command). Ends with the intentional "RLS OK" exception like rls_check.sql.
do $chk$
declare
  r record;
  n integer;
begin
  select count(*) into n from dry_run.expect;
  if n <> 7 then raise exception 'BACKFILL FAIL: seed missing (% rows)', n; end if;
  for r in
    select e.id, e.format as want_f, e.design_style as want_s, b.format, b.design_style,
           b.doc = e.doc as doc_same, b.doc_rev, e.doc_rev as want_rev, b.updated_at, e.updated_at as want_ts
      from dry_run.expect as e join public.books as b on b.id = e.id
  loop
    if r.format <> r.want_f or r.design_style <> r.want_s then
      raise exception 'BACKFILL FAIL [%]: got % / %, want % / %', r.id, r.format, r.design_style, r.want_f, r.want_s;
    end if;
    if not r.doc_same or r.doc_rev <> r.want_rev or r.updated_at <> r.want_ts then
      raise exception 'BACKFILL FAIL [%]: doc / doc_rev / updated_at changed (rev %, updated_at %)', r.id, r.doc_rev, r.updated_at;
    end if;
  end loop;
  -- the updated_at trigger is back on after the backfill
  update public.books set title = 'touched' where id = '00000000-0000-4000-8000-000000000004';
  if exists (select 1 from public.books where id = '00000000-0000-4000-8000-000000000004'
               and updated_at = '2026-01-01T00:00:00Z') then
    raise exception 'BACKFILL FAIL: books_set_updated_at left disabled';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.books'::regclass and not tgisinternal and tgenabled = 'D') then
    raise exception 'BACKFILL FAIL: a books trigger is disabled';
  end if;
  raise exception 'RLS OK — all 3 checks passed (1900 backfill)';
end
$chk$;
