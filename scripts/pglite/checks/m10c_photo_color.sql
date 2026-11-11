-- Dry-run check for M10c T4 (no migration): the exact statement src/lib/db/photos.ts setPhotosColor
-- sends through PostgREST as service_role —
--   update photos set color = $hex where book_id = $book and color is null and id in ($ids)
-- writes only the given book's photos whose colour is null (a foreign id in the list matches nothing,
-- an existing colour is never overwritten), and an owner's own update still can't set it (1900 guard).
--   npm run db:dry-run -- --rls=scripts/pglite/checks/m10c_photo_color.sql
-- Ends with the intentional "RLS OK" exception like rls_check.sql (rolls everything back).
do $chk$
declare
  uid_a constant uuid := '00000000-0000-4000-8000-00000000c0a1';
  uid_b constant uuid := '00000000-0000-4000-8000-00000000c0b1';
  book_a uuid;
  book_b uuid;
  p_own uuid;
  p_set uuid;
  p_foreign uuid;
  n integer;
begin
  insert into auth.users (id, email) values (uid_a, 'm10c-a@example.test'), (uid_b, 'm10c-b@example.test');
  insert into public.books (user_id, title) values (uid_a, 'm10c a') returning id into book_a;
  insert into public.books (user_id, title) values (uid_b, 'm10c b') returning id into book_b;
  insert into public.photos (user_id, book_id, fingerprint) values (uid_a, book_a, 'm10c-color-fp-own-1') returning id into p_own;
  insert into public.photos (user_id, book_id, fingerprint) values (uid_a, book_a, 'm10c-color-fp-set-1') returning id into p_set;
  insert into public.photos (user_id, book_id, fingerprint) values (uid_b, book_b, 'm10c-color-fp-foreign') returning id into p_foreign;
  update public.photos set color = '#112233' where id = p_set; -- postgres: an existing colour

  -- setPhotosColor for book A with all three ids (the foreign one smuggled in)
  set local role service_role;
  update public.photos set color = '#8a7f72'
   where book_id = book_a and color is null and id in (p_own, p_set, p_foreign);
  get diagnostics n = row_count;
  reset role;
  if n <> 1 then raise exception 'COLOR FAIL: % rows updated, want 1', n; end if;
  if not exists (select 1 from public.photos where id = p_own and color = '#8a7f72') then
    raise exception 'COLOR FAIL: own photo not coloured';
  end if;
  if not exists (select 1 from public.photos where id = p_set and color = '#112233') then
    raise exception 'COLOR FAIL: existing colour overwritten';
  end if;
  if not exists (select 1 from public.photos where id = p_foreign and color is null) then
    raise exception 'COLOR FAIL: another book''s photo coloured';
  end if;

  -- the owner (authenticated) still can't set it directly
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  update public.photos set color = '#000000' where id = p_own;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from public.photos where id = p_own and color = '#8a7f72') then
    raise exception 'COLOR FAIL: owner changed color';
  end if;

  raise exception 'RLS OK — all 2 checks passed (m10c photo colour)';
end
$chk$;
