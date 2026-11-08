-- =============================================================================
-- supabase/tests/rls_check.sql — live RLS / trigger / storage check (Milestone 1)
--
-- HOW TO RUN
--   1. Apply the migrations first (`npm run db:push`) — including
--      20261108000300_hardening.sql (path checks, grants, id/created_at freeze).
--   2. Supabase Dashboard → SQL Editor → New query → paste this WHOLE file → Run.
--      (The SQL Editor runs as `postgres`, which this script needs.)
--   Also works with psql: `psql "$DB_URL" -f supabase/tests/rls_check.sql`.
--
-- WHAT SUCCESS LOOKS LIKE
--   The editor shows an ERROR panel whose message starts with
--       RLS OK — all NN checks passed
--   That error is raised ON PURPOSE as the very last step: it is the one thing
--   the SQL Editor always displays (it does not show RAISE NOTICE output, and it
--   only shows the result of the last statement), and it guarantees rollback.
--
--   Anything else is a failure:
--     * "RLS FAIL [..]: <what leaked>"  → a security check failed (report it);
--     * any other error (e.g. permission denied for table users, relation does
--       not exist) → the script could not run — usually migrations not applied
--       or not running as postgres.
--
-- IT LEAVES NO DATA
--   The whole script is ONE `do` statement, i.e. one transaction. It always ends
--   in an exception (pass or fail), so Postgres rolls back everything it did:
--   the 2 fake auth.users (A, B), their profiles, books, photo row and storage
--   object row. Nothing is committed, so nothing needs cleaning up.
--   (We deliberately do NOT use `begin; … rollback;`: when a statement errors,
--   Postgres skips the rest of the batch, so a trailing `rollback;` would never
--   run and the editor's connection would be left in an aborted transaction.)
--
-- Roles are impersonated the way PostgREST does it:
--   set local role authenticated|anon + request.jwt.claims = {"sub": <uid>, "role": ...}
-- =============================================================================

do $rls$
declare
  uid_a      uuid := gen_random_uuid();
  uid_b      uuid := gen_random_uuid();
  book_a     uuid;
  book_a2    uuid;
  photo_a    uuid;
  slug_pub   text := 'rls-check-pub-'   || substr(md5(random()::text), 1, 12);
  slug_unpub text := 'rls-check-unpub-' || substr(md5(random()::text), 1, 12);
  r          record;
  a2_created timestamptz;
  n          integer;
  checks     integer := 0;
begin
  if current_user not in ('postgres', 'supabase_admin') then
    raise exception 'Run this as postgres (Supabase SQL Editor). current_user = %', current_user;
  end if;

  -- ---------------------------------------------------------------------------
  -- Setup (postgres): two fake users → profiles via trigger
  -- ---------------------------------------------------------------------------
  insert into auth.users
    (instance_id, id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000', uid_a, 'authenticated', 'authenticated',
     'rls-check-a-' || uid_a || '@example.invalid', '{"full_name":"Test A"}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', uid_b, 'authenticated', 'authenticated',
     'rls-check-b-' || uid_b || '@example.invalid', '{"full_name":"Test B"}', '{}', now(), now());

  select count(*) into n from public.profiles
   where (id = uid_a and name = 'Test A') or (id = uid_b and name = 'Test B');
  if n <> 2 then raise exception 'RLS FAIL [profiles]: handle_new_user created % of 2 profiles', n; end if;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- As A (authenticated): server-only columns are forced / frozen
  -- ---------------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);

  insert into public.books (user_id, title, doc, is_paid, max_pages, slug, published_at, expires_at)
  values (uid_a, 'RLS check A', '{"pages":[{"n":1}]}', true, 100, 'x', now(), now() + interval '1 year')
  returning id, is_paid, max_pages, slug, published_at, expires_at into r;
  book_a := r.id;
  if r.is_paid or r.max_pages <> 20 or r.slug is not null or r.published_at is not null
     or r.expires_at is not null then
    raise exception 'RLS FAIL [books insert]: client set server-only columns: %', row_to_json(r);
  end if;
  checks := checks + 1;

  update public.books
     set is_paid = true, max_pages = 100, slug = 'x', published_at = now(),
         expires_at = now() + interval '1 year', title = 'RLS check A (edited)'
   where id = book_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RLS FAIL [books update own]: A could not update own book (% rows)', n; end if;
  select * into r from public.books where id = book_a;
  if r.is_paid or r.max_pages <> 20 or r.slug is not null or r.published_at is not null
     or r.expires_at is not null or r.title <> 'RLS check A (edited)' then
    raise exception 'RLS FAIL [books update]: server-only columns changed or title not saved: %',
      json_build_object('is_paid', r.is_paid, 'max_pages', r.max_pages, 'slug', r.slug,
                        'published_at', r.published_at, 'expires_at', r.expires_at, 'title', r.title);
  end if;
  checks := checks + 1;

  begin
    update public.books set user_id = uid_b where id = book_a;
  exception when insufficient_privilege then
    null; -- rejected by WITH CHECK is also fine; what matters is the owner below
  end;
  select user_id into r from public.books where id = book_a;
  if not found or r.user_id <> uid_a then
    raise exception 'RLS FAIL [books user_id]: A could move the book to another user';
  end if;
  checks := checks + 1;

  -- second (never published) book for the unpublished-slug check
  insert into public.books (user_id, title) values (uid_a, 'RLS check A2')
  returning id, created_at into book_a2, a2_created;

  -- id / created_at are frozen for clients (0300). book_a2 has no photos, so a
  -- missing guard shows up as a changed id rather than an FK error.
  update public.books
     set id = gen_random_uuid(), created_at = now() - interval '10 years', title = 'RLS check A2 (edited)'
   where id = book_a2;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RLS FAIL [books id freeze]: A could not update own book (% rows)', n; end if;
  select count(*) into n from public.books
   where id = book_a2 and created_at = a2_created and title = 'RLS check A2 (edited)';
  if n <> 1 then
    raise exception 'RLS FAIL [books id freeze]: A changed id or created_at of own book';
  end if;
  checks := checks + 1;

  insert into public.photos (user_id, book_id, web_path)
  values (uid_a, book_a, uid_a || '/' || book_a || '/p-web.jpg')
  returning id into photo_a;
  checks := checks + 1; -- owner can add a photo to own book

  -- photo paths must sit under {own uid}/{book}/ (0300 check constraints)
  begin
    insert into public.photos (user_id, book_id, original_path)
    values (uid_a, book_a, uid_b || '/' || book_a || '/p-original.jpg');
    raise exception 'RLS FAIL [photo path]: A stored a photo path in B''s folder';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- As B (authenticated): cannot see / change A's data
  -- ---------------------------------------------------------------------------
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_b, 'role', 'authenticated')::text, true);

  select count(*) into n from public.books where id in (book_a, book_a2);
  if n <> 0 then raise exception 'RLS FAIL [B select books]: B sees % of A''s books', n; end if;
  checks := checks + 1;

  select count(*) into n from public.profiles where id = uid_a;
  if n <> 0 then raise exception 'RLS FAIL [B select profile]: B sees A''s profile'; end if;
  checks := checks + 1;

  select count(*) into n from public.photos where id = photo_a;
  if n <> 0 then raise exception 'RLS FAIL [B select photos]: B sees A''s photo'; end if;
  checks := checks + 1;

  update public.books set title = 'hacked by B' where id = book_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS FAIL [B update book]: % rows updated', n; end if;
  checks := checks + 1;

  delete from public.books where id = book_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS FAIL [B delete book]: % rows deleted', n; end if;
  checks := checks + 1;

  update public.profiles set name = 'hacked by B' where id = uid_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS FAIL [B update profile]: % rows updated', n; end if;
  checks := checks + 1;

  delete from public.photos where id = photo_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS FAIL [B delete photo]: % rows deleted', n; end if;
  checks := checks + 1;

  begin
    -- path is well-formed for B so only RLS (book owned by A) can reject it
    insert into public.photos (user_id, book_id, web_path)
    values (uid_b, book_a, uid_b || '/' || book_a || '/hack.jpg');
    raise exception 'RLS FAIL [B insert photo]: B added a photo to A''s book';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  begin
    insert into public.books (user_id, title) values (uid_a, 'planted by B');
    raise exception 'RLS FAIL [B insert book for A]: B created a book owned by A';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  begin
    insert into public.orders (user_id, book_id, type, amount, status)
    values (uid_b, book_a, 'digital', 0, 'paid');
    raise exception 'RLS FAIL [B insert order]: a client could write to orders';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- As postgres: publish A's book (privileged caller bypasses the column guard)
  -- ---------------------------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims', '', true);

  select count(*) into n from public.books where id = book_a and title = 'RLS check A (edited)';
  if n <> 1 then raise exception 'RLS FAIL [B side effects]: A''s book was changed or deleted by B'; end if;
  select count(*) into n from public.profiles where id = uid_a and name = 'Test A';
  if n <> 1 then raise exception 'RLS FAIL [B side effects]: A''s profile was changed by B'; end if;
  checks := checks + 1;

  update public.books
     set slug = slug_pub, published_at = now(), expires_at = now() + interval '30 days'
   where id = book_a;
  update public.books set slug = slug_unpub where id = book_a2; -- slug but not published
  select count(*) into n from public.books where id = book_a and slug = slug_pub and published_at is not null;
  if n <> 1 then raise exception 'RLS FAIL [postgres publish]: privileged caller could not publish'; end if;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- As anon: no table access; only get_published_book
  -- ---------------------------------------------------------------------------
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

  begin
    select count(*) into n from public.books;
    if n <> 0 then raise exception 'RLS FAIL [anon books]: anon sees % books', n; end if;
  exception when insufficient_privilege then null; -- expected since 0300 (no grant)
  end;
  checks := checks + 1;

  begin
    select (select count(*) from public.profiles) + (select count(*) from public.photos)
         + (select count(*) from public.orders) into n;
    if n <> 0 then raise exception 'RLS FAIL [anon tables]: anon sees % rows in profiles/photos/orders', n; end if;
  exception when insufficient_privilege then null; -- no grant at all is fine too
  end;
  checks := checks + 1;

  reset role;
  if has_table_privilege('anon', 'public.books', 'select')
     or has_table_privilege('anon', 'public.profiles', 'select')
     or has_table_privilege('anon', 'public.photos', 'select')
     or has_table_privilege('anon', 'public.orders', 'select') then
    raise exception 'RLS FAIL [anon grants]: anon still has SELECT on a core table';
  end if;
  checks := checks + 1;
  set local role anon;

  select * into r from public.get_published_book(slug_pub);
  if not found then raise exception 'RLS FAIL [anon get_published_book]: published book not returned'; end if;
  if r.doc is null or r.is_expired or r.has_password or r.id <> book_a then
    raise exception 'RLS FAIL [anon get_published_book]: expected live doc, got %', row_to_json(r);
  end if;
  checks := checks + 1;

  -- expired
  reset role;
  update public.books set expires_at = now() - interval '1 minute' where id = book_a;
  set local role anon;
  select * into r from public.get_published_book(slug_pub);
  if not found or r.doc is not null or not r.is_expired then
    raise exception 'RLS FAIL [expired]: expected row with doc null + is_expired, got %', row_to_json(r);
  end if;
  checks := checks + 1;

  -- password protected
  reset role;
  update public.books set expires_at = now() + interval '30 days', password_hash = 'not-a-real-hash'
   where id = book_a;
  set local role anon;
  select * into r from public.get_published_book(slug_pub);
  if not found or r.doc is not null or not r.has_password or r.is_expired then
    raise exception 'RLS FAIL [password]: expected row with doc null + has_password, got %', row_to_json(r);
  end if;
  checks := checks + 1;

  select count(*) into n from public.get_published_book(slug_unpub);
  if n <> 0 then raise exception 'RLS FAIL [unpublished]: unpublished book returned'; end if;
  select count(*) into n from public.get_published_book('rls-check-does-not-exist');
  if n <> 0 then raise exception 'RLS FAIL [unknown slug]: rows returned for unknown slug'; end if;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- Storage: owner-folder policies
  -- ---------------------------------------------------------------------------
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_b, 'role', 'authenticated')::text, true);
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('photos', uid_a || '/x/y.jpg', uid_b);
    raise exception 'RLS FAIL [storage B→A]: B wrote into A''s photos folder';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('photos', uid_a || '/' || book_a || '/rls-check-web.jpg', uid_a);
  exception when others then
    raise exception 'RLS FAIL [storage A own]: A could not write own folder: % (SQLSTATE %)', sqlerrm, sqlstate;
  end;
  select count(*) into n from storage.objects where bucket_id = 'photos' and name like uid_a || '/%';
  if n <> 1 then raise exception 'RLS FAIL [storage A own]: A sees % own objects, expected 1', n; end if;
  checks := checks + 1;

  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('exports', uid_a || '/' || book_a || '/book.pdf', uid_a);
    raise exception 'RLS FAIL [storage exports]: client wrote to the exports bucket';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_b, 'role', 'authenticated')::text, true);
  select count(*) into n from storage.objects where name like uid_a || '/%';
  if n <> 0 then raise exception 'RLS FAIL [storage B read]: B sees % of A''s objects', n; end if;
  checks := checks + 1;

  reset role;
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin
    select count(*) into n from storage.objects where name like uid_a || '/%';
    if n <> 0 then raise exception 'RLS FAIL [storage anon read]: anon sees % of A''s objects', n; end if;
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- Done. Raise on purpose so the editor shows it AND everything rolls back.
  -- ---------------------------------------------------------------------------
  reset role;
  raise notice 'RLS OK';
  raise exception 'RLS OK — all % checks passed. (This error is intentional: it rolls back all test data.)', checks;
end
$rls$;
