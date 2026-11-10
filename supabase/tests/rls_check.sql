-- =============================================================================
-- supabase/tests/rls_check.sql — live RLS / trigger / storage check (Milestones 1–7)
--
-- HOW TO RUN
--   1. Apply the migrations first (`npm run db:push`) — including
--      20261108000300_hardening.sql (path checks, grants, id/created_at freeze)
--      and 20261108000400_photo_upload.sql (fingerprint/upload_state, photo cap)
--      and 20261108000500_photo_integrity.sql (ready CHECK, path formats,
--      photo column guard, pending-only storage writes, finalize rate limit)
--      and 20261108000600_agent_pipeline.sql (agent_runs / agent_steps /
--      user_memory, run lease RPCs, server-only books.ai_status, step scrub on
--      book delete)
--      and 20261109000700_agent_pipeline_hardening.sql (lease tokens, capped
--      run creation, agent_runs column grants, cursor scrub, cost precision)
--      and 20261109000800_cursor_size.sql (agent_runs.cursor limit 256 KB)
--      and 20261110000900_editor.sql (server-only doc / page_count / doc_rev,
--      doc_rev bump trigger, rewrite runs outside the one-active-run index,
--      'rewriting' state + claim_agent_run refuses rewrites,
--      create_rewrite_run_capped with stale reaping + per-user daily ceiling)
--      and 20261111001000_publish.sql (published_doc snapshot columns +
--      checks, server-only publish columns / password_hash,
--      book_unlock_attempts + try_book_unlock rate limit, get_published_book
--      reads the snapshot and is service-role only)
--      and 20261111001100_unlock_tuning.sql (clear_unlock_attempt: a successful
--      unlock removes its own attempt row; service-role only)
--      and 20261112001200_payments.sql (orders payment columns / statuses, one
--      pending order per book, private.stripe_events, fulfill_book_checkout +
--      record_stripe_order_event: service-role only, idempotent per event,
--      refunds never revoke books.is_paid)
--      and 20261112001300_payments_review.sql (orders status needs_review,
--      fulfil reports already_paid_other_session and skips no-op book updates).
--   Not checkable in SQL: the bucket allowed_mime_types (image/heic rejected) is
--   enforced by the Storage API, so only the bucket row is asserted here.
--   2. Supabase Dashboard → SQL Editor → New query → paste this WHOLE file → Run.
--      (The SQL Editor runs as `postgres`, which this script needs.)
--   Also works with psql: `psql "$DB_URL" -f supabase/tests/rls_check.sql`.
--
-- WHAT SUCCESS LOOKS LIKE
--   The editor shows an ERROR panel whose message starts with
--       RLS OK — all 121 checks passed
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
--   the 2 fake auth.users (A, B), their profiles, books, photo rows (incl. the
--   500 photo-cap test rows), storage object rows, agent runs/steps and
--   user_memory rows, unlock attempts, orders and stripe_events rows. Nothing is committed, so nothing needs cleaning up.
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
  photo_m    uuid;
  photo_r    uuid;
  photo_x    uuid;
  base_r     text;
  v_wait     integer;
  book_cap   uuid;
  v_hint     text;
  run_a      uuid;
  run_b      uuid;
  run_del    uuid;
  book_del   uuid;
  tok1       uuid;
  tok2       uuid;
  run_cap    uuid;
  book_c1    uuid;
  book_c2    uuid;
  book_c3    uuid;
  v_res      jsonb;
  book_e     uuid;
  run_rw     uuid;
  book_p     uuid;
  ip_1       text;
  ip_2       text;
  ip_3       text;
  ip_4       text;
  book_pay   uuid;
  book_pay2  uuid;
  sess_1     text;
  sess_2     text;
  sess_3     text;
  pi_1       text;
  evt_1      text;
  evt_2      text;
  v_txt      text;
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

  insert into public.photos (user_id, book_id, fingerprint)
  values (uid_a, book_a, 'rls-check-fp-photo-a')
  returning id into photo_a;
  checks := checks + 1; -- owner can add a (pending) photo to own book

  -- photo paths must sit under {own uid}/{book}/ (0300 check constraints)
  begin
    insert into public.photos (user_id, book_id, original_path, fingerprint)
    values (uid_a, book_a, uid_b || '/' || book_a || '/p-original.jpg', 'rls-check-fp-path-b');
    raise exception 'RLS FAIL [photo path]: A stored a photo path in B''s folder';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- As A: upload columns (0400)
  -- ---------------------------------------------------------------------------
  begin
    insert into public.photos (user_id, book_id, fingerprint)
    values (uid_a, book_a, 'rls-check-fp-photo-a');
    raise exception 'RLS FAIL [photo fingerprint]: duplicate (book_id, fingerprint) accepted';
  exception when unique_violation then null;
  end;
  checks := checks + 1;

  begin
    insert into public.photos (user_id, book_id, fingerprint, upload_state)
    values (uid_a, book_a, 'rls-check-fp-bogus-state', 'bogus');
    raise exception 'RLS FAIL [photo upload_state]: upload_state ''bogus'' accepted';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  begin
    insert into public.photos (user_id, book_id, fingerprint) values (uid_a, book_a, 'too-short');
    raise exception 'RLS FAIL [photo fingerprint]: fingerprint shorter than 16 chars accepted';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  begin
    insert into public.photos (user_id, book_id, fingerprint, original_mime)
    values (uid_a, book_a, 'rls-check-fp-heic-mime', 'image/heic');
    raise exception 'RLS FAIL [photo original_mime]: image/heic original accepted';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  insert into public.photos (user_id, book_id, fingerprint)
  values (uid_a, book_a, 'rls-check-fp-photo-m')
  returning id, upload_state into r;
  photo_m := r.id;
  if r.upload_state <> 'pending' then
    raise exception 'RLS FAIL [photo upload_state]: default should be pending, got %', r.upload_state;
  end if;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- As A: photo cap per book (0400 trigger) — free 150, paid 500
  -- ---------------------------------------------------------------------------
  insert into public.books (user_id, title) values (uid_a, 'RLS check cap') returning id into book_cap;

  -- (a) one multi-row insert of 151 into an empty free book: the trigger fires per
  --     row and counts the rows already inserted, so the 151st row aborts it all.
  begin
    insert into public.photos (user_id, book_id, fingerprint)
    select uid_a, book_cap, md5('rls-cap-' || g) from generate_series(1, 151) as g;
    raise exception 'RLS FAIL [photo cap]: 151 photos inserted into a free book in one statement';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'photo_limit_reached' then raise; end if;
  end;
  select count(*) into n from public.photos where book_id = book_cap;
  if n <> 0 then raise exception 'RLS FAIL [photo cap]: failed insert left % rows', n; end if;
  checks := checks + 1;

  -- (b) 150 succeed, the 151st raises photo_limit_reached with hint '150'
  insert into public.photos (user_id, book_id, fingerprint)
  select uid_a, book_cap, md5('rls-cap-' || g) from generate_series(1, 150) as g;
  get diagnostics n = row_count;
  if n <> 150 then raise exception 'RLS FAIL [photo cap]: only % of 150 photos inserted', n; end if;
  checks := checks + 1;

  v_hint := null;
  begin
    insert into public.photos (user_id, book_id, fingerprint) values (uid_a, book_cap, md5('rls-cap-151'));
    raise exception 'RLS FAIL [photo cap]: 151st photo accepted in a free book';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'photo_limit_reached' then raise; end if;
    get stacked diagnostics v_hint = pg_exception_hint;
  end;
  if v_hint is distinct from '150' then
    raise exception 'RLS FAIL [photo cap]: expected hint 150, got %', v_hint;
  end if;
  checks := checks + 1;

  -- (c) moving a photo into a full book is capped too (update of book_id)
  begin
    update public.photos set book_id = book_cap where id = photo_m;
    raise exception 'RLS FAIL [photo cap]: photo moved into a full free book';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'photo_limit_reached' then raise; end if;
  end;
  checks := checks + 1;

  -- (d) the service role is not exempt
  reset role;
  set local role service_role;
  begin
    insert into public.photos (user_id, book_id, fingerprint) values (uid_a, book_cap, md5('rls-cap-svc'));
    raise exception 'RLS FAIL [photo cap]: service role bypassed the free cap';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'photo_limit_reached' then raise; end if;
  end;
  checks := checks + 1;

  -- (e) paid book (is_paid set by a privileged caller): > 150 allowed, 501st rejected
  reset role;
  update public.books set is_paid = true where id = book_cap;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  insert into public.photos (user_id, book_id, fingerprint)
  select uid_a, book_cap, md5('rls-cap-' || g) from generate_series(151, 500) as g;
  select count(*) into n from public.photos where book_id = book_cap;
  if n <> 500 then raise exception 'RLS FAIL [photo cap paid]: paid book has % photos, expected 500', n; end if;
  checks := checks + 1;

  v_hint := null;
  begin
    insert into public.photos (user_id, book_id, fingerprint) values (uid_a, book_cap, md5('rls-cap-501'));
    raise exception 'RLS FAIL [photo cap paid]: 501st photo accepted in a paid book';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'photo_limit_reached' then raise; end if;
    get stacked diagnostics v_hint = pg_exception_hint;
  end;
  if v_hint is distinct from '500' then
    raise exception 'RLS FAIL [photo cap paid]: expected hint 500, got %', v_hint;
  end if;
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
    insert into public.photos (user_id, book_id, fingerprint)
    values (uid_b, book_a, 'rls-check-fp-hack-b');
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

  -- Publish = snapshot (1000, D-039): live means published_doc is not null.
  update public.books
     set slug = slug_pub, published_at = now(), expires_at = now() + interval '30 days',
         published_doc = '{"pages":[{"n":1},{"n":2}]}', published_rev = 0, last_published_at = now()
   where id = book_a;
  -- book_a2: has a slug and a first-publish time but no snapshot (= unpublished)
  update public.books set slug = slug_unpub, published_at = now() where id = book_a2;
  select count(*) into n from public.books
   where id = book_a and slug = slug_pub and published_at is not null and published_doc is not null;
  if n <> 1 then raise exception 'RLS FAIL [postgres publish]: privileged caller could not publish'; end if;
  checks := checks + 1;

  -- 1000: a snapshot needs slug + published_at, and a rev + last_published_at
  begin
    update public.books set published_doc = '{"pages":[]}', published_rev = 0, last_published_at = now(),
                            slug = null
     where id = book_a2;
    raise exception 'RLS FAIL [published_doc check]: snapshot without slug accepted';
  exception when check_violation then null;
  end;
  begin
    update public.books set published_doc = '{"pages":[]}' where id = book_a2;
    raise exception 'RLS FAIL [published_doc check]: snapshot without published_rev accepted';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- As anon: no table access, and (since 1000) no RPCs either — the viewer
  -- reads get_published_book with the admin client.
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

  if has_function_privilege('anon', 'public.get_published_book(text)', 'execute')
     or has_function_privilege('authenticated', 'public.get_published_book(text)', 'execute')
     or has_function_privilege('anon', 'public.try_book_unlock(uuid, text, integer, integer, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.try_book_unlock(uuid, text, integer, integer, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.get_published_book(text)', 'execute')
     or not has_function_privilege('service_role', 'public.try_book_unlock(uuid, text, integer, integer, integer)', 'execute') then
    raise exception 'RLS FAIL [publish RPC grants]: get_published_book / try_book_unlock EXECUTE not service-role only';
  end if;
  set local role anon;
  begin
    perform * from public.get_published_book(slug_pub);
    raise exception 'RLS FAIL [anon get_published_book]: anon could execute it';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.try_book_unlock(book_a, 'rls-check-ip-anon', 5, 5, 60);
    raise exception 'RLS FAIL [anon try_book_unlock]: anon could execute it';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- As service_role: get_published_book returns the snapshot (1000)
  -- ---------------------------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;

  select * into r from public.get_published_book(slug_pub);
  if not found then raise exception 'RLS FAIL [get_published_book]: published book not returned'; end if;
  if r.doc is distinct from '{"pages":[{"n":1},{"n":2}]}'::jsonb or r.is_expired or r.has_password
     or r.id <> book_a or r.page_count <> 2 or r.published_rev <> 0 or r.slug <> slug_pub then
    raise exception 'RLS FAIL [get_published_book]: expected live snapshot, got %', row_to_json(r);
  end if;
  checks := checks + 1;

  -- free + expired → row with is_expired, doc null
  update public.books set expires_at = now() - interval '1 minute' where id = book_a;
  select * into r from public.get_published_book(slug_pub);
  if not found or r.doc is not null or not r.is_expired then
    raise exception 'RLS FAIL [expired]: expected row with doc null + is_expired, got %', row_to_json(r);
  end if;
  checks := checks + 1;

  -- paid with a past expires_at → never expired (D-039)
  update public.books set is_paid = true where id = book_a;
  select * into r from public.get_published_book(slug_pub);
  if not found or r.doc is null or r.is_expired or not r.is_paid then
    raise exception 'RLS FAIL [paid expiry]: paid book with past expires_at treated as expired: %', row_to_json(r);
  end if;
  update public.books set is_paid = false where id = book_a;
  checks := checks + 1;

  -- password protected
  update public.books set expires_at = now() + interval '30 days', password_hash = 'not-a-real-hash'
   where id = book_a;
  select * into r from public.get_published_book(slug_pub);
  if not found or r.doc is not null or not r.has_password or r.is_expired then
    raise exception 'RLS FAIL [password]: expected row with doc null + has_password, got %', row_to_json(r);
  end if;
  checks := checks + 1;

  -- unpublished (slug + published_at but no snapshot) / unknown slug → no row
  select count(*) into n from public.get_published_book(slug_unpub);
  if n <> 0 then raise exception 'RLS FAIL [unpublished]: book without published_doc returned'; end if;
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

  -- ---------------------------------------------------------------------------
  -- As A: storage writes need an own PENDING photo row + exact name (0500)
  -- ---------------------------------------------------------------------------
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('photos', uid_a || '/' || book_a || '/' || gen_random_uuid() || '-web.jpg', uid_a);
    raise exception 'RLS FAIL [storage no row]: A uploaded for a photo id that does not exist';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('photos', uid_a || '/' || book_a || '/rls-check-web.jpg', uid_a);
    raise exception 'RLS FAIL [storage name]: A uploaded a loosely named object into own folder';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  base_r := uid_a || '/' || book_a || '/' || photo_a;
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('photos', base_r || '-original.jpg', uid_a),
           ('photos', base_r || '-web.jpg', uid_a),
           ('photos', base_r || '-thumb.jpg', uid_a);
  exception when others then
    raise exception 'RLS FAIL [storage A own]: A could not upload own pending photo: % (SQLSTATE %)', sqlerrm, sqlstate;
  end;
  select count(*) into n from storage.objects where bucket_id = 'photos' and name like uid_a || '/%';
  if n <> 3 then raise exception 'RLS FAIL [storage A own]: A sees % own objects, expected 3', n; end if;
  checks := checks + 1;

  update storage.objects set owner = uid_a where bucket_id = 'photos' and name = base_r || '-web.jpg';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RLS FAIL [storage upsert pending]: A could not overwrite own pending object'; end if;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- As A: photo integrity + server-only column guard (0500)
  -- ---------------------------------------------------------------------------
  -- becoming ready requires the three files to exist
  begin
    update public.photos
       set upload_state = 'ready',
           original_path = uid_a || '/' || book_a || '/' || photo_m || '-original.jpg',
           web_path = uid_a || '/' || book_a || '/' || photo_m || '-web.jpg',
           thumb_path = uid_a || '/' || book_a || '/' || photo_m || '-thumb.jpg',
           width = 10, height = 10, original_mime = 'image/jpeg', original_bytes = 1
     where id = photo_m;
    raise exception 'RLS FAIL [photo ready files]: A marked a photo ready without uploaded files';
  exception when check_violation then
    if sqlerrm <> 'photo_files_missing' then raise; end if;
  end;
  checks := checks + 1;

  begin
    insert into public.photos (user_id, book_id, fingerprint, upload_state)
    values (uid_a, book_a, 'rls-check-fp-ready-nopath', 'ready');
    raise exception 'RLS FAIL [photo ready insert]: client inserted a ready row without files';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  begin
    update public.photos
       set web_path = uid_a || '/' || book_a || '/' || gen_random_uuid() || '-web.jpg'
     where id = photo_a;
    raise exception 'RLS FAIL [photo path format]: web_path with another photo id accepted';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  insert into public.photos
    (user_id, book_id, fingerprint, ai, dup_group, place, place_checked_at, status, drop_reason, user_override)
  values
    (uid_a, book_a, 'rls-check-fp-forced', '{"x":1}', 5, 'Somewhere', now(), 'dropped', 'blurry', true)
  returning id, ai, dup_group, place, place_checked_at, status, drop_reason, user_override into r;
  photo_x := r.id;
  if r.ai is not null or r.dup_group is not null or r.place is not null or r.place_checked_at is not null
     or r.status <> 'kept' or r.drop_reason is not null or r.user_override then
    raise exception 'RLS FAIL [photo insert guard]: client set server-only columns: %', row_to_json(r);
  end if;
  checks := checks + 1;

  update public.photos
     set upload_state = 'ready',
         original_path = base_r || '-original.jpg',
         web_path = base_r || '-web.jpg',
         thumb_path = base_r || '-thumb.jpg',
         width = 3000, height = 4000, original_mime = 'image/jpeg', original_bytes = 1234,
         phash = '0123456789abcdef', blur_score = 12.5
   where id = photo_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RLS FAIL [photo ready]: A could not mark own uploaded photo ready'; end if;
  checks := checks + 1;

  update public.photos
     set ai = '{"x":1}', dup_group = 9, place = 'Elsewhere', place_checked_at = now(),
         status = 'dropped', drop_reason = 'mine', user_override = true,
         fingerprint = 'rls-check-fp-changed', book_id = book_a2, upload_state = 'pending',
         original_path = base_r || '-original.png', web_path = null, width = 1
   where id = photo_a;
  select * into r from public.photos where id = photo_a;
  if r.ai is not null or r.dup_group is not null or r.place is not null or r.place_checked_at is not null
     or r.fingerprint <> 'rls-check-fp-photo-a' or r.book_id <> book_a or r.upload_state <> 'ready'
     or r.original_path <> base_r || '-original.jpg' or r.web_path is null or r.width <> 3000 then
    raise exception 'RLS FAIL [photo update guard]: client changed server-only / frozen columns: %',
      json_build_object('ai', r.ai, 'dup_group', r.dup_group, 'place', r.place,
                        'fingerprint', r.fingerprint, 'upload_state', r.upload_state,
                        'same_book', r.book_id = book_a, 'width', r.width);
  end if;
  if r.status <> 'dropped' or r.drop_reason <> 'mine' or not r.user_override then
    raise exception 'RLS FAIL [photo user decision]: status/drop_reason/user_override not saved';
  end if;
  checks := checks + 1;

  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('photos', base_r || '-original.png', uid_a);
    raise exception 'RLS FAIL [storage after ready]: A uploaded a new object for a ready photo';
  exception when insufficient_privilege then null;
  end;
  update storage.objects set owner = uid_a where bucket_id = 'photos' and name = base_r || '-web.jpg';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS FAIL [storage after ready]: A overwrote an object of a ready photo'; end if;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- As service_role: CHECKs apply to everyone; server-only columns writable
  -- ---------------------------------------------------------------------------
  reset role;
  set local role service_role;
  begin
    insert into public.photos (user_id, book_id, fingerprint, upload_state)
    values (uid_a, book_a, 'rls-check-fp-svc-ready', 'ready');
    raise exception 'RLS FAIL [photo ready CHECK]: service role inserted a ready row without paths';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  begin
    update public.photos
       set ai = (select jsonb_agg(md5(g::text)) from generate_series(1, 1000) as g)
     where id = photo_x;
    raise exception 'RLS FAIL [photo ai size]: ai > 16 KiB accepted';
  exception when check_violation then null;
  end;
  begin
    update public.photos set phash = 'NOT-A-HASH' where id = photo_x;
    raise exception 'RLS FAIL [photo phash]: malformed phash accepted';
  exception when check_violation then null;
  end;
  begin
    update public.photos set width = 0 where id = photo_x;
    raise exception 'RLS FAIL [photo width]: width 0 accepted';
  exception when check_violation then null;
  end;
  begin
    update public.photos set blur_score = -1 where id = photo_x;
    raise exception 'RLS FAIL [photo blur_score]: negative blur_score accepted';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  update public.photos set place = 'Svc place', dup_group = 1, place_checked_at = now() where id = photo_x;
  select count(*) into n from public.photos
   where id = photo_x and place = 'Svc place' and dup_group = 1 and place_checked_at is not null;
  if n <> 1 then raise exception 'RLS FAIL [photo server write]: service role could not set place/dup_group'; end if;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- Finalize rate limit (0500): private.finalize_runs + service-role-only RPCs
  -- ---------------------------------------------------------------------------
  v_wait := public.claim_finalize_run(book_a, 10);
  if v_wait <> 0 then raise exception 'RLS FAIL [finalize claim]: first claim returned %', v_wait; end if;
  v_wait := public.claim_finalize_run(book_a, 10);
  if v_wait not between 1 and 10 then
    raise exception 'RLS FAIL [finalize claim]: second claim within 10 s returned %', v_wait;
  end if;
  checks := checks + 1;

  n := public.reserve_geocode_calls(book_a, 150, 200);
  if n <> 150 then raise exception 'RLS FAIL [geocode cap]: reserved % of 150', n; end if;
  n := public.reserve_geocode_calls(book_a, 100, 200);
  if n <> 50 then raise exception 'RLS FAIL [geocode cap]: reserved % (expected 50 left today)', n; end if;
  n := public.reserve_geocode_calls(book_a, 5, 200);
  if n <> 0 then raise exception 'RLS FAIL [geocode cap]: reserved % beyond the daily cap', n; end if;
  n := public.reserve_geocode_calls(book_a2, 5, 200);
  if n <> 0 then raise exception 'RLS FAIL [geocode cap]: reserved % without a claimed run', n; end if;
  checks := checks + 1;

  reset role;
  if has_table_privilege('authenticated', 'private.finalize_runs', 'select')
     or has_table_privilege('authenticated', 'private.finalize_runs', 'insert')
     or has_table_privilege('authenticated', 'private.finalize_runs', 'update')
     or has_table_privilege('anon', 'private.finalize_runs', 'select')
     or has_function_privilege('authenticated', 'public.claim_finalize_run(uuid, integer)', 'execute')
     or has_function_privilege('anon', 'public.claim_finalize_run(uuid, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.reserve_geocode_calls(uuid, integer, integer)', 'execute')
     or has_function_privilege('anon', 'public.reserve_geocode_calls(uuid, integer, integer)', 'execute') then
    raise exception 'RLS FAIL [finalize_runs grants]: a client role can use finalize_runs or its RPCs';
  end if;
  checks := checks + 1;

  select count(*) into n from storage.buckets
   where id = 'photos'
     and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']
     and array['image/jpeg', 'image/png', 'image/webp'] @> allowed_mime_types;
  if n <> 1 then raise exception 'RLS FAIL [bucket mimes]: photos bucket must allow only jpeg/png/webp'; end if;
  checks := checks + 1;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  begin
    select count(*) into n from private.finalize_runs;
    raise exception 'RLS FAIL [finalize_runs read]: authenticated can read finalize_runs (% rows)', n;
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_finalize_run(book_a, 0);
    raise exception 'RLS FAIL [finalize claim]: authenticated could call claim_finalize_run';
  exception when insufficient_privilege then null;
  end;
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
  -- AI pipeline (0600): agent_runs / agent_steps / user_memory, lease RPCs,
  -- server-only books.ai_status, scrub-on-book-delete
  -- ---------------------------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims', '', true);

  insert into public.agent_runs (book_id, user_id, trigger, mode, state)
  values (book_a, uid_a, 'build', 'replay', 'curating')
  returning id into run_a;
  insert into public.agent_runs (user_id, trigger, mode)
  values (uid_b, 'build', 'replay')
  returning id into run_b;
  insert into public.agent_steps (run_id, agent, step_key, status, output, input_summary, cost_usd)
  values (run_a, 'curator', 'curator:1', 'ok', '{"keep":["p1"]}', '{"photos":1}', 0.0123);
  insert into public.user_memory (user_id, prefs) values (uid_a, '{"tone":"warm"}'), (uid_b, '{"tone":"fun"}');

  -- one active run per book (unique partial index); finished runs don't count
  begin
    insert into public.agent_runs (book_id, user_id, trigger, mode)
    values (book_a, uid_a, 'rebuild', 'replay');
    raise exception 'RLS FAIL [agent_runs active]: a second active run for one book was accepted';
  exception when unique_violation then null;
  end;
  insert into public.agent_runs (book_id, user_id, trigger, mode, state)
  values (book_a, uid_a, 'rebuild', 'rule', 'done');
  checks := checks + 1;

  -- 'partial' is a valid books.ai_status for privileged callers; bogus values are not
  update public.books set ai_status = 'partial' where id = book_a;
  select count(*) into n from public.books where id = book_a and ai_status = 'partial';
  if n <> 1 then raise exception 'RLS FAIL [books ai_status]: postgres could not set ai_status = partial'; end if;
  begin
    update public.books set ai_status = 'bogus' where id = book_a;
    raise exception 'RLS FAIL [books ai_status]: ai_status ''bogus'' accepted';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  if has_table_privilege('anon', 'public.agent_runs', 'select')
     or has_table_privilege('anon', 'public.agent_steps', 'select')
     or has_table_privilege('anon', 'public.user_memory', 'select')
     or has_table_privilege('authenticated', 'public.agent_runs', 'insert')
     or has_table_privilege('authenticated', 'public.agent_runs', 'update')
     or has_table_privilege('authenticated', 'public.agent_runs', 'delete')
     or has_table_privilege('authenticated', 'public.agent_steps', 'select')
     or has_table_privilege('authenticated', 'public.agent_steps', 'insert')
     or has_table_privilege('authenticated', 'public.user_memory', 'insert')
     or has_table_privilege('authenticated', 'public.user_memory', 'update')
     or has_function_privilege('authenticated', 'public.claim_agent_run(uuid, integer)', 'execute')
     or has_function_privilege('anon', 'public.claim_agent_run(uuid, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.release_agent_run(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.release_agent_run(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated',
          'public.create_agent_run_capped(uuid, uuid, text, text, integer, integer, boolean)', 'execute')
     or has_function_privilege('anon',
          'public.create_agent_run_capped(uuid, uuid, text, text, integer, integer, boolean)', 'execute') then
    raise exception 'RLS FAIL [agent grants]: a client role has a write/step/RPC privilege it must not have';
  end if;
  checks := checks + 1;

  -- 0700: authenticated reads agent_runs through column grants only (no cursor,
  -- lease, attempts, costs or tokens); the table-level SELECT is gone.
  if has_table_privilege('authenticated', 'public.agent_runs', 'select')
     or has_column_privilege('authenticated', 'public.agent_runs', 'cursor', 'select')
     or has_column_privilege('authenticated', 'public.agent_runs', 'lease_token', 'select')
     or has_column_privilege('authenticated', 'public.agent_runs', 'lease_until', 'select')
     or has_column_privilege('authenticated', 'public.agent_runs', 'attempts', 'select')
     or has_column_privilege('authenticated', 'public.agent_runs', 'total_cost_usd', 'select')
     or has_column_privilege('authenticated', 'public.agent_runs', 'total_input_tokens', 'select')
     or has_column_privilege('authenticated', 'public.agent_runs', 'total_output_tokens', 'select')
     or has_column_privilege('authenticated', 'public.agent_runs', 'critic_score', 'select')
     or not has_column_privilege('authenticated', 'public.agent_runs', 'progress', 'select')
     or not has_column_privilege('authenticated', 'public.agent_runs', 'state', 'select')
     or not has_column_privilege('authenticated', 'public.agent_runs', 'finished_at', 'select') then
    raise exception 'RLS FAIL [agent_runs column grants]: authenticated column privileges are wrong';
  end if;
  checks := checks + 1;

  -- As A ----------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);

  select count(*) into n from public.agent_runs where id in (run_a, run_b);
  if n <> 1 or not exists (select 1 from public.agent_runs where id = run_a) then
    raise exception 'RLS FAIL [agent_runs select]: A sees % of (own, B''s) runs, expected only own', n;
  end if;
  checks := checks + 1;

  -- 0700 column grants: the progress-screen columns are readable, internals are not
  select * into r from (
    select id, book_id, user_id, state, ai_status, progress, error_code, mode, trigger, started_at, finished_at
      from public.agent_runs where id = run_a
  ) as owner_cols;
  if r.id is distinct from run_a or r.state <> 'curating' then
    raise exception 'RLS FAIL [agent_runs owner columns]: A could not read own run''s allowed columns';
  end if;
  begin
    select count(*) into n from public.agent_runs where id = run_a and cursor is not null;
    raise exception 'RLS FAIL [agent_runs cursor]: A can read agent_runs.cursor';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into n from public.agent_runs where id = run_a and total_cost_usd >= 0;
    raise exception 'RLS FAIL [agent_runs cost]: A can read agent_runs.total_cost_usd';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into n from public.agent_runs where id = run_a and lease_token is null;
    raise exception 'RLS FAIL [agent_runs lease_token]: A can read agent_runs.lease_token';
  exception when insufficient_privilege then null;
  end;
  begin
    select * into r from public.agent_runs where id = run_a;
    raise exception 'RLS FAIL [agent_runs select *]: A can select * from agent_runs';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  begin
    insert into public.agent_runs (book_id, user_id, trigger, mode) values (book_a2, uid_a, 'build', 'live');
    raise exception 'RLS FAIL [agent_runs insert]: a client created a run';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.agent_runs set state = 'done', total_cost_usd = 0 where id = run_a;
    raise exception 'RLS FAIL [agent_runs update]: a client changed a run (counters must be server-only)';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.agent_runs where id = run_a;
    raise exception 'RLS FAIL [agent_runs delete]: a client deleted a run (would reset usage counts)';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  begin
    select count(*) into n from public.agent_steps;
    raise exception 'RLS FAIL [agent_steps read]: authenticated can read agent_steps (% rows)', n;
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  -- ai_status is server-only (D-021): forced on insert, frozen on update
  update public.books set ai_status = 'idle', title = 'RLS check A (ai)' where id = book_a;
  select * into r from public.books where id = book_a;
  if r.ai_status <> 'partial' or r.title <> 'RLS check A (ai)' then
    raise exception 'RLS FAIL [books ai_status update]: client reset ai_status to % (or title not saved)', r.ai_status;
  end if;
  insert into public.books (user_id, title, ai_status) values (uid_a, 'RLS check ai insert', 'done')
  returning ai_status into r;
  if r.ai_status <> 'idle' then
    raise exception 'RLS FAIL [books ai_status insert]: client inserted ai_status = %', r.ai_status;
  end if;
  checks := checks + 1;

  -- user_memory: own select / delete only
  select count(*) into n from public.user_memory where user_id in (uid_a, uid_b);
  if n <> 1 or not exists (select 1 from public.user_memory where user_id = uid_a) then
    raise exception 'RLS FAIL [user_memory select]: A sees % memory rows, expected only own', n;
  end if;
  begin
    insert into public.user_memory (user_id, prefs) values (gen_random_uuid(), '{}');
    raise exception 'RLS FAIL [user_memory insert]: a client wrote user_memory';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.user_memory set prefs = '{"tone":"hacked"}' where user_id = uid_a;
    raise exception 'RLS FAIL [user_memory update]: a client updated user_memory';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  delete from public.user_memory where user_id = uid_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS FAIL [user_memory delete]: A deleted B''s memory'; end if;
  delete from public.user_memory where user_id = uid_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RLS FAIL [user_memory delete own]: A could not forget own memory'; end if;
  checks := checks + 1;

  begin
    perform public.claim_agent_run(run_a, 30);
    raise exception 'RLS FAIL [claim_agent_run]: authenticated could call claim_agent_run';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.release_agent_run(run_a, gen_random_uuid());
    raise exception 'RLS FAIL [release_agent_run]: authenticated could call release_agent_run';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.create_agent_run_capped(book_a2, uid_a, 'build', 'live', 100, 100, false);
    raise exception 'RLS FAIL [create_agent_run_capped]: authenticated could call create_agent_run_capped';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  -- owner deletes a book that has runs: allowed; steps scrubbed, costs kept (D-027)
  insert into public.books (user_id, title) values (uid_a, 'RLS check delete') returning id into book_del;
  reset role;
  insert into public.agent_runs (book_id, user_id, trigger, mode, state, total_cost_usd, cursor, progress)
  values (book_del, uid_a, 'build', 'replay', 'done', 0.5,
          '{"aliasIds":["p1"],"plan":{"title":"x"}}', '{"phase":"done","photosTotal":1}')
  returning id into run_del;
  insert into public.agent_steps (run_id, agent, step_key, status, output, input_summary, cost_usd)
  values (run_del, 'curator', 'curator:1', 'ok', '{"keep":["p1"]}', '{"photos":1}', 0.25),
         (run_del, 'storyteller', 'storyteller', 'ok', '{"pages":[]}', '{"groups":1}', 0.25);
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  begin
    delete from public.books where id = book_del;
    get diagnostics n = row_count;
  exception when others then
    raise exception 'RLS FAIL [book delete with runs]: owner could not delete: % (SQLSTATE %)', sqlerrm, sqlstate;
  end;
  if n <> 1 then raise exception 'RLS FAIL [book delete with runs]: % rows deleted', n; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  select count(*) into n from public.agent_runs
   where id = run_del and book_id is null and user_id = uid_a and total_cost_usd = 0.5;
  if n <> 1 then raise exception 'RLS FAIL [book delete with runs]: run not kept with book_id = null'; end if;
  select count(*) into n from public.agent_runs
   where id = run_del and cursor = '{}'::jsonb and progress = '{}'::jsonb;
  if n <> 1 then raise exception 'RLS FAIL [scrub run cursor]: cursor/progress not cleared on book delete'; end if;
  select count(*) into n from public.agent_steps
   where run_id = run_del and output is null and input_summary is null and cost_usd = 0.25;
  if n <> 2 then raise exception 'RLS FAIL [scrub steps]: % of 2 steps scrubbed with costs kept', n; end if;
  checks := checks + 1;

  -- As service_role: lease claim returns a token once until it expires or is
  -- released; release / checkpoint with a stale token are no-ops (0700)
  set local role service_role;
  tok1 := public.claim_agent_run(run_a, 30);
  if tok1 is null then
    raise exception 'RLS FAIL [claim_agent_run]: first claim of an unleased run returned no token';
  end if;
  if public.claim_agent_run(run_a, 30) is not null then
    raise exception 'RLS FAIL [claim_agent_run]: second claim succeeded while the lease is held';
  end if;
  update public.agent_runs set lease_until = now() - interval '1 second' where id = run_a;
  tok2 := public.claim_agent_run(run_a, 100000);
  if tok2 is null or tok2 = tok1 then
    raise exception 'RLS FAIL [claim_agent_run]: claim after lease expiry failed or reused the token';
  end if;
  select * into r from public.agent_runs where id = run_a;
  if r.attempts <> 2 or r.lease_until > now() + interval '300 seconds' or r.lease_token is distinct from tok2 then
    raise exception 'RLS FAIL [claim_agent_run]: attempts % / lease % (expected 2, clamped to 300 s, token stored)',
      r.attempts, r.lease_until - now();
  end if;
  checks := checks + 1;

  -- stale tick (tok1) can neither release nor checkpoint
  perform public.release_agent_run(run_a, tok1);
  perform public.release_agent_run(run_a, null);
  select * into r from public.agent_runs where id = run_a;
  if r.lease_token is distinct from tok2 or r.lease_until is null then
    raise exception 'RLS FAIL [release_agent_run]: a stale / null token released the current lease';
  end if;
  update public.agent_runs set state = 'storytelling' where id = run_a and lease_token = tok1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS FAIL [checkpoint token]: a stale-token checkpoint wrote % rows', n; end if;
  update public.agent_runs set state = 'storytelling' where id = run_a and lease_token = tok2;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RLS FAIL [checkpoint token]: the current-token checkpoint wrote % rows', n; end if;
  checks := checks + 1;

  perform public.release_agent_run(run_a, tok2);
  select * into r from public.agent_runs where id = run_a;
  if r.lease_token is not null or r.lease_until is not null then
    raise exception 'RLS FAIL [release_agent_run]: the owning token did not clear the lease';
  end if;
  if public.claim_agent_run(run_a, 30) is null then
    raise exception 'RLS FAIL [release_agent_run]: claim after release failed';
  end if;
  update public.agent_runs set state = 'done', lease_until = null, lease_token = null where id = run_a;
  if public.claim_agent_run(run_a, 30) is not null then
    raise exception 'RLS FAIL [claim_agent_run]: a finished run was claimed';
  end if;
  checks := checks + 1;

  -- create_agent_run_capped (0700): per-user daily cap counts live runs that
  -- cost something or are still active; rebuild cap counts successful billed
  -- live rebuilds of the book; one active run per book → already_running.
  reset role;
  insert into public.books (user_id, title) values (uid_b, 'RLS cap 1') returning id into book_c1;
  insert into public.books (user_id, title) values (uid_b, 'RLS cap 2') returning id into book_c2;
  insert into public.books (user_id, title) values (uid_b, 'RLS cap 3') returning id into book_c3;
  -- B's earlier runs: a billed ok build (counts), a free failed build (doesn't),
  -- a replay build (doesn't), an old billed failed rebuild (not daily, not a successful rebuild)
  insert into public.agent_runs (book_id, user_id, trigger, mode, state, ai_status, total_cost_usd, started_at)
  values (book_c1, uid_b, 'build',   'live',   'done',   'ok',     0.01, now() - interval '1 hour'),
         (book_c1, uid_b, 'build',   'live',   'failed', 'failed', 0,    now() - interval '1 hour'),
         (book_c2, uid_b, 'build',   'replay', 'done',   'ok',     0,    now() - interval '1 hour'),
         (book_c1, uid_b, 'rebuild', 'live',   'failed', 'failed', 0.05, now() - interval '2 days');
  set local role service_role;

  v_res := public.create_agent_run_capped(book_c1, uid_b, 'rebuild', 'live', 3, 1, true);
  if v_res ->> 'id' is null then
    raise exception 'RLS FAIL [capped create]: 1st call (1 of 3 used) refused: %', v_res;
  end if;
  run_cap := (v_res ->> 'id')::uuid;
  v_res := public.create_agent_run_capped(book_c2, uid_b, 'build', 'live', 3, 1, true);
  if v_res ->> 'id' is null then
    raise exception 'RLS FAIL [capped create]: 2nd call (2 of 3 used) refused: %', v_res;
  end if;
  v_res := public.create_agent_run_capped(book_c3, uid_b, 'build', 'live', 3, 1, true);
  if v_res is distinct from '{"error":"limit","limit":"daily_builds"}'::jsonb then
    raise exception 'RLS FAIL [capped create]: 3rd call over the daily cap (active runs count) returned %', v_res;
  end if;
  select count(*) into n from public.agent_runs where book_id = book_c3;
  if n <> 0 then raise exception 'RLS FAIL [capped create]: a capped call inserted a run'; end if;
  checks := checks + 1;

  v_res := public.create_agent_run_capped(book_c1, uid_b, 'build', 'replay', 3, 1, false);
  if v_res is distinct from '{"error":"already_running"}'::jsonb then
    raise exception 'RLS FAIL [capped create]: second active run on a book returned %', v_res;
  end if;
  v_res := public.create_agent_run_capped(book_c3, uid_b, 'build', 'replay', 3, 1, false);
  if v_res ->> 'id' is null then
    raise exception 'RLS FAIL [capped create]: p_enforce = false still applied the cap: %', v_res;
  end if;
  checks := checks + 1;

  -- finish: the rebuild succeeded (billed), book_c2's run failed without cost,
  -- book_c3's replay run is done → daily = 2 billed live runs < 3
  update public.agent_runs set state = 'done', ai_status = 'ok', total_cost_usd = 0.02 where id = run_cap;
  update public.agent_runs set state = 'failed', ai_status = 'failed' where book_id = book_c2 and state = 'queued';
  update public.agent_runs set state = 'done' where book_id = book_c3 and state = 'queued';
  v_res := public.create_agent_run_capped(book_c1, uid_b, 'rebuild', 'live', 3, 1, true);
  if v_res is distinct from '{"error":"limit","limit":"rebuilds"}'::jsonb then
    raise exception 'RLS FAIL [capped create]: rebuild over the rebuild cap returned %', v_res;
  end if;
  v_res := public.create_agent_run_capped(book_c1, uid_b, 'rebuild', 'live', 3, 2, true);
  if v_res ->> 'id' is null then
    raise exception 'RLS FAIL [capped create]: rebuild under the cap (failed / free runs must not count) refused: %', v_res;
  end if;
  begin
    perform public.create_agent_run_capped(book_c2, null, 'build', 'live', 3, 1, true);
    raise exception 'RLS FAIL [capped create]: a null user id was accepted';
  exception when invalid_parameter_value then null;
  end;
  checks := checks + 1;

  -- 0800 (D-033): agent_runs.cursor may hold up to 256 KB (captions between
  -- ticks); bigger cursors are rejected. md5 strings keep the jsonb incompressible.
  reset role;
  perform set_config('request.jwt.claims', '', true);
  begin
    insert into public.agent_runs (book_id, user_id, trigger, mode, state, cursor)
    select book_a, uid_a, 'build', 'replay', 'done',
           jsonb_build_object('captions', jsonb_agg(md5(i::text || 'c')))
      from generate_series(1, 3000) as i;
  exception when check_violation then
    raise exception 'RLS FAIL [cursor size]: a ~100 KB cursor was rejected (0800 not applied?)';
  end;
  select count(*) into n from public.agent_runs
   where book_id = book_a and pg_column_size(cursor) > 65536 and pg_column_size(cursor) <= 262144;
  if n < 1 then raise exception 'RLS FAIL [cursor size]: a ~100 KB cursor was not stored'; end if;
  checks := checks + 1;
  begin
    insert into public.agent_runs (book_id, user_id, trigger, mode, state, cursor)
    select book_a, uid_a, 'build', 'replay', 'done',
           jsonb_build_object('captions', jsonb_agg(md5(i::text || 'c')))
      from generate_series(1, 9000) as i;
    raise exception 'RLS FAIL [cursor size]: a cursor over 256 KB was accepted';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- 0900 (D-036): books.doc / page_count / doc_rev are server-only; doc_rev is
  -- bumped by books_set_doc_rev only when doc changes.
  -- ---------------------------------------------------------------------------
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  insert into public.books (user_id, title, doc, page_count, doc_rev)
  values (uid_a, 'RLS editor', '{"pages":[{"n":1}]}', 5, 7)
  returning id, doc, page_count, doc_rev into r;
  book_e := r.id;
  if r.doc <> '{}'::jsonb or r.page_count <> 0 or r.doc_rev <> 0 then
    raise exception 'RLS FAIL [doc insert]: client set doc/page_count/doc_rev on insert: %', row_to_json(r);
  end if;
  checks := checks + 1;

  update public.books
     set doc = '{"pages":[{"n":2}]}', page_count = 3, doc_rev = 99, title = 'RLS editor (edited)'
   where id = book_e;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RLS FAIL [doc update]: A could not update own book (% rows)', n; end if;
  select doc, page_count, doc_rev, title into r from public.books where id = book_e;
  if r.doc <> '{}'::jsonb or r.page_count <> 0 or r.doc_rev <> 0 or r.title <> 'RLS editor (edited)' then
    raise exception 'RLS FAIL [doc update]: client changed doc/page_count/doc_rev or title not saved: %', row_to_json(r);
  end if;
  checks := checks + 1;

  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  update public.books set doc = '{"pages":[{"n":1}]}', page_count = 1 where id = book_e;
  select doc_rev into r from public.books where id = book_e;
  if r.doc_rev <> 1 then raise exception 'RLS FAIL [doc_rev]: service doc write left doc_rev at %', r.doc_rev; end if;
  update public.books set doc = '{"pages":[{"n":2}]}' where id = book_e and doc_rev = 1;
  get diagnostics n = row_count;
  select doc_rev into r from public.books where id = book_e;
  if n <> 1 or r.doc_rev <> 2 then
    raise exception 'RLS FAIL [doc_rev]: conditional save (rev 1) wrote % rows, doc_rev %', n, r.doc_rev;
  end if;
  update public.books set doc = '{"pages":[{"n":3}]}' where id = book_e and doc_rev = 1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS FAIL [doc_rev]: a stale-rev save wrote % rows', n; end if;
  checks := checks + 1;

  update public.books set title = 'RLS editor (svc)', ai_status = 'done' where id = book_e;
  update public.books set doc = '{"pages":[{"n":2}]}' where id = book_e; -- same doc: no bump
  update public.books set doc_rev = 50 where id = book_e;                -- never set directly
  select doc_rev into r from public.books where id = book_e;
  if r.doc_rev <> 2 then
    raise exception 'RLS FAIL [doc_rev]: non-doc / identical-doc / direct writes changed doc_rev to %', r.doc_rev;
  end if;
  checks := checks + 1;

  -- the client guard keeps the service-written doc and rev
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  update public.books set doc = '{}', page_count = 0, doc_rev = 0 where id = book_e;
  select doc, page_count, doc_rev into r from public.books where id = book_e;
  if r.doc <> '{"pages":[{"n":2}]}'::jsonb or r.page_count <> 1 or r.doc_rev <> 2 then
    raise exception 'RLS FAIL [doc update]: client reset a service-written doc: %', row_to_json(r);
  end if;
  checks := checks + 1;

  -- create_rewrite_run_capped: not executable by clients
  if has_function_privilege('authenticated', 'public.create_rewrite_run_capped(uuid, uuid, text, integer, integer, boolean)', 'execute')
     or has_function_privilege('anon', 'public.create_rewrite_run_capped(uuid, uuid, text, integer, integer, boolean)', 'execute') then
    raise exception 'RLS FAIL [rewrite rpc grants]: a client role can execute create_rewrite_run_capped';
  end if;
  begin
    perform public.create_rewrite_run_capped(book_e, uid_a, 'live', 100, 100, false);
    raise exception 'RLS FAIL [rewrite rpc]: authenticated could call create_rewrite_run_capped';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  -- rewrite runs are outside the one-active-run index (D-037 (6)); max 1 in
  -- flight per book; only ok rewrites count toward the cap.
  reset role;
  perform set_config('request.jwt.claims', '', true);
  insert into public.agent_runs (book_id, user_id, trigger, mode) values (book_e, uid_a, 'build', 'replay');
  set local role service_role;
  v_res := public.create_rewrite_run_capped(book_e, uid_a, 'replay', 2, 100, true);
  if v_res ->> 'id' is null then
    raise exception 'RLS FAIL [rewrite run]: refused while a build run is active: %', v_res;
  end if;
  run_rw := (v_res ->> 'id')::uuid;
  v_res := public.create_rewrite_run_capped(book_e, uid_a, 'replay', 2, 100, false);
  if v_res is distinct from '{"error":"already_running"}'::jsonb then
    raise exception 'RLS FAIL [rewrite run]: second in-flight rewrite returned %', v_res;
  end if;
  begin
    insert into public.agent_runs (book_id, user_id, trigger, mode) values (book_e, uid_a, 'rebuild', 'replay');
    raise exception 'RLS FAIL [one active run]: a second active build/rebuild run was accepted';
  exception when unique_violation then null;
  end;
  v_res := public.create_rewrite_run_capped(book_e, uid_b, 'replay', 2, 100, false);
  if v_res is distinct from '{"error":"not_found"}'::jsonb then
    raise exception 'RLS FAIL [rewrite run]: a rewrite run for another user''s book returned %', v_res;
  end if;
  checks := checks + 1;

  -- M5 review B1: a rewrite run is never 'queued' and never claimable by a build tick
  select state, cursor into r from public.agent_runs where id = run_rw;
  if r.state <> 'rewriting' or r.cursor <> '{}'::jsonb then
    raise exception 'RLS FAIL [rewrite state]: rewrite run inserted as % (expected rewriting)', r.state;
  end if;
  if public.claim_agent_run(run_rw, 30) is not null then
    raise exception 'RLS FAIL [rewrite claim]: claim_agent_run leased a rewrite run';
  end if;
  select attempts, lease_token into r from public.agent_runs where id = run_rw;
  if r.attempts <> 0 or r.lease_token is not null then
    raise exception 'RLS FAIL [rewrite claim]: a refused claim still touched the rewrite run';
  end if;
  begin
    insert into public.agent_runs (book_id, user_id, trigger, mode, state) values (book_e, uid_a, 'rewrite', 'replay', 'queued');
    raise exception 'RLS FAIL [rewrite state]: a queued rewrite run was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.agent_runs (book_id, user_id, trigger, mode, state) values (book_a, uid_a, 'build', 'replay', 'rewriting');
    raise exception 'RLS FAIL [rewrite state]: a build run in state rewriting was accepted';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  update public.agent_runs set state = 'done', ai_status = 'ok' where id = run_rw;
  v_res := public.create_rewrite_run_capped(book_e, uid_a, 'replay', 2, 100, true);   -- 1 ok of 2
  if v_res ->> 'id' is null then raise exception 'RLS FAIL [rewrite cap]: 1 of 2 used refused: %', v_res; end if;
  update public.agent_runs set state = 'failed', ai_status = 'failed' where id = (v_res ->> 'id')::uuid;
  v_res := public.create_rewrite_run_capped(book_e, uid_a, 'replay', 2, 100, true);   -- failed doesn't count
  if v_res ->> 'id' is null then raise exception 'RLS FAIL [rewrite cap]: a failed rewrite counted: %', v_res; end if;
  run_rw := (v_res ->> 'id')::uuid;
  update public.agent_runs set started_at = now() - interval '10 minutes' where id = run_rw;
  v_res := public.create_rewrite_run_capped(book_e, uid_a, 'replay', 2, 100, true);   -- stale run doesn't block/count
  if v_res ->> 'id' is null then raise exception 'RLS FAIL [rewrite cap]: a stale unfinished rewrite blocked: %', v_res; end if;
  update public.agent_runs set state = 'done', ai_status = 'ok' where id = (v_res ->> 'id')::uuid;
  v_res := public.create_rewrite_run_capped(book_e, uid_a, 'replay', 2, 100, true);   -- 2 ok of 2
  if v_res is distinct from '{"error":"limit","limit":"rewrites"}'::jsonb then
    raise exception 'RLS FAIL [rewrite cap]: over the cap returned %', v_res;
  end if;
  v_res := public.create_rewrite_run_capped(book_e, uid_a, 'replay', 2, 100, false);  -- not enforced
  if v_res ->> 'id' is null then raise exception 'RLS FAIL [rewrite cap]: p_enforce = false still capped: %', v_res; end if;
  begin
    perform public.create_rewrite_run_capped(book_e, null, 'replay', 2, 100, true);
    raise exception 'RLS FAIL [rewrite cap]: a null user id was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.create_rewrite_run_capped(book_e, uid_a, 'replay', 2, null, true);
    raise exception 'RLS FAIL [rewrite cap]: a null daily cap was accepted with p_enforce';
  exception when invalid_parameter_value then null;
  end;
  checks := checks + 1;

  -- M5 review B1 (c): the stale unfinished rewrite was failed by the RPC, not left active
  select state, ai_status, error_code, finished_at into r from public.agent_runs where id = run_rw;
  if r.state <> 'failed' or r.ai_status <> 'failed' or r.error_code <> 'stale' or r.finished_at is null then
    raise exception 'RLS FAIL [rewrite stale]: stale rewrite run left as %/%/%', r.state, r.ai_status, r.error_code;
  end if;
  -- ... and only that book's: a stale rewrite of another book is left for that book's next call
  insert into public.agent_runs (book_id, user_id, trigger, mode, state, started_at)
  values (book_a, uid_a, 'rewrite', 'replay', 'rewriting', now() - interval '10 minutes')
  returning id into run_rw;
  v_res := public.create_rewrite_run_capped(book_e, uid_a, 'replay', 100, 100, false);
  select state into r from public.agent_runs where id = run_rw;
  if r.state <> 'rewriting' then
    raise exception 'RLS FAIL [rewrite stale]: a rewrite of another book was reaped (%)', r.state;
  end if;
  v_res := public.create_rewrite_run_capped(book_a, uid_a, 'replay', 100, 100, false);
  select state, error_code into r from public.agent_runs where id = run_rw;
  if v_res ->> 'id' is null or r.state <> 'failed' or r.error_code <> 'stale' then
    raise exception 'RLS FAIL [rewrite stale]: own-book stale rewrite not failed (%, %)', r.state, v_res;
  end if;
  checks := checks + 1;

  -- M5 review S1: per-user daily ceiling over ALL rewrite runs (any book, any outcome)
  select count(*) into n from public.agent_runs
   where user_id = uid_a and trigger = 'rewrite' and started_at > now() - interval '24 hours';
  update public.agent_runs set state = 'failed', ai_status = 'failed'
   where user_id = uid_a and trigger = 'rewrite' and state not in ('done', 'failed');
  v_res := public.create_rewrite_run_capped(book_e, uid_a, 'replay', 1000, n, true);
  if v_res is distinct from '{"error":"daily_limit"}'::jsonb then
    raise exception 'RLS FAIL [rewrite daily]: % rewrites with daily cap % returned %', n, n, v_res;
  end if;
  update public.agent_runs set started_at = now() - interval '25 hours'
   where id = (select id from public.agent_runs
                where user_id = uid_a and trigger = 'rewrite' and ai_status = 'failed'
                order by started_at limit 1);
  v_res := public.create_rewrite_run_capped(book_e, uid_a, 'replay', 1000, n, true);
  if v_res ->> 'id' is null then
    raise exception 'RLS FAIL [rewrite daily]: a run older than 24 h still counted: %', v_res;
  end if;
  v_res := public.create_rewrite_run_capped(book_a2, uid_a, 'replay', 1000, n, true);
  if v_res is distinct from '{"error":"daily_limit"}'::jsonb then
    raise exception 'RLS FAIL [rewrite daily]: the ceiling is not per user across books: %', v_res;
  end if;
  v_res := public.create_rewrite_run_capped(book_a2, uid_a, 'replay', 1000, n, false);
  if v_res ->> 'id' is null then
    raise exception 'RLS FAIL [rewrite daily]: p_enforce = false still hit the daily ceiling: %', v_res;
  end if;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- 1000 (D-039 / D-040): published_doc / published_rev / last_published_at /
  -- password_hash are server-only; book_unlock_attempts is service-role only;
  -- try_book_unlock rate-limits per ip (window) and per book (1 hour).
  -- ---------------------------------------------------------------------------
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  insert into public.books (user_id, title, published_doc, published_rev, last_published_at, password_hash)
  values (uid_a, 'RLS publish', '{"pages":[]}', 3, now(), 'client-hash')
  returning id, published_doc, published_rev, last_published_at, password_hash into r;
  book_p := r.id;
  if r.published_doc is not null or r.published_rev is not null or r.last_published_at is not null
     or r.password_hash is not null then
    raise exception 'RLS FAIL [publish insert]: client set publish columns / password_hash: %', row_to_json(r);
  end if;
  checks := checks + 1;

  update public.books
     set published_doc = '{"pages":[]}', published_rev = 99, last_published_at = now() - interval '1 day',
         password_hash = null
   where id = book_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RLS FAIL [publish update]: A could not update own book (% rows)', n; end if;
  select published_doc, published_rev, last_published_at, password_hash into r from public.books where id = book_a;
  if r.published_doc is distinct from '{"pages":[{"n":1},{"n":2}]}'::jsonb or r.published_rev <> 0
     or r.last_published_at < now() - interval '1 hour' or r.password_hash is distinct from 'not-a-real-hash' then
    raise exception 'RLS FAIL [publish update]: client changed publish columns / password_hash: %', row_to_json(r);
  end if;
  checks := checks + 1;

  begin
    perform * from public.get_published_book(slug_pub);
    raise exception 'RLS FAIL [authenticated get_published_book]: authenticated could execute it';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.try_book_unlock(book_a, 'rls-check-ip-auth', 5, 5, 60);
    raise exception 'RLS FAIL [authenticated try_book_unlock]: authenticated could execute it';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  begin
    select count(*) into n from public.book_unlock_attempts;
    raise exception 'RLS FAIL [unlock attempts]: authenticated could read book_unlock_attempts (% rows)', n;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.book_unlock_attempts (book_id, ip_hash) values (book_a, 'rls-check-ip-auth');
    raise exception 'RLS FAIL [unlock attempts]: authenticated could insert into book_unlock_attempts';
  exception when insufficient_privilege then null;
  end;
  reset role;
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin
    select count(*) into n from public.book_unlock_attempts;
    raise exception 'RLS FAIL [unlock attempts]: anon could read book_unlock_attempts (% rows)', n;
  exception when insufficient_privilege then null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if has_table_privilege('anon', 'public.book_unlock_attempts', 'select, insert, update, delete')
     or has_table_privilege('authenticated', 'public.book_unlock_attempts', 'select, insert, update, delete')
     or not (select c.relrowsecurity from pg_class as c where c.oid = 'public.book_unlock_attempts'::regclass)
     or exists (select 1 from pg_policies as p
                 where p.schemaname = 'public' and p.tablename = 'book_unlock_attempts') then
    raise exception 'RLS FAIL [unlock attempts]: client grants, RLS off or a policy exists';
  end if;
  checks := checks + 1;

  -- try_book_unlock: ip limit (window, across books); refused attempts are not recorded
  set local role service_role;
  ip_1 := 'rls-check-ip1-' || md5(random()::text);
  ip_2 := 'rls-check-ip2-' || md5(random()::text);
  ip_3 := 'rls-check-ip3-' || md5(random()::text);
  for k in 1..3 loop
    if not public.try_book_unlock(book_a, ip_1, 3, 1000, 60) then
      raise exception 'RLS FAIL [unlock ip limit]: attempt % of 3 refused', k;
    end if;
  end loop;
  if public.try_book_unlock(book_a, ip_1, 3, 1000, 60) then
    raise exception 'RLS FAIL [unlock ip limit]: 4th attempt within the window allowed';
  end if;
  select count(*) into n from public.book_unlock_attempts where book_id = book_a and ip_hash = ip_1;
  if n <> 3 then raise exception 'RLS FAIL [unlock ip limit]: % attempts recorded (expected 3; refused must not count)', n; end if;
  if public.try_book_unlock(book_e, ip_1, 3, 1000, 60) then
    raise exception 'RLS FAIL [unlock ip limit]: the ip limit is not across books';
  end if;
  if not public.try_book_unlock(book_a, ip_2, 3, 1000, 60) then
    raise exception 'RLS FAIL [unlock ip limit]: another ip was refused on the same book';
  end if;
  checks := checks + 1;

  -- book limit (1 hour, across ips): book_e has no attempts yet
  if not public.try_book_unlock(book_e, ip_2, 100, 2, 60) or not public.try_book_unlock(book_e, ip_3, 100, 2, 60) then
    raise exception 'RLS FAIL [unlock book limit]: attempts under the book limit refused';
  end if;
  if public.try_book_unlock(book_e, 'rls-check-ip4-' || md5(random()::text), 100, 2, 60) then
    raise exception 'RLS FAIL [unlock book limit]: a 3rd ip got past a book limit of 2';
  end if;
  -- attempts older than the ip window but inside the hour still count for the book
  update public.book_unlock_attempts set created_at = now() - interval '30 minutes' where book_id = book_e;
  if public.try_book_unlock(book_e, ip_3, 100, 2, 60) then
    raise exception 'RLS FAIL [unlock book limit]: the book limit window is shorter than 1 hour';
  end if;
  checks := checks + 1;

  -- housekeeping: rows older than greatest(window, 1 h) are deleted; invalid args raise 22023
  update public.book_unlock_attempts set created_at = now() - interval '2 hours' where book_id = book_e;
  if not public.try_book_unlock(book_e, ip_3, 100, 2, 60) then
    raise exception 'RLS FAIL [unlock housekeeping]: attempts older than 1 hour still counted';
  end if;
  select count(*) into n from public.book_unlock_attempts
   where book_id = book_e and created_at < now() - interval '1 hour';
  if n <> 0 then raise exception 'RLS FAIL [unlock housekeeping]: % old attempts of the book left', n; end if;
  begin
    perform public.try_book_unlock(book_e, ip_3, 0, 2, 60);
    raise exception 'RLS FAIL [unlock args]: ip limit 0 accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.try_book_unlock(book_e, null, 5, 5, 60);
    raise exception 'RLS FAIL [unlock args]: null ip hash accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.try_book_unlock(book_e, ip_3, 5, 5, 0);
    raise exception 'RLS FAIL [unlock args]: window 0 accepted';
  exception when invalid_parameter_value then null;
  end;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- 1100 (M6 review S2): clear_unlock_attempt — service-role only; a successful
  -- unlock deletes the newest attempt row of its (book, ip) pair, so only failures
  -- count toward the limits.
  -- ---------------------------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if has_function_privilege('anon', 'public.clear_unlock_attempt(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.clear_unlock_attempt(uuid, text)', 'execute')
     or has_function_privilege('public', 'public.clear_unlock_attempt(uuid, text)', 'execute')
     or not has_function_privilege('service_role', 'public.clear_unlock_attempt(uuid, text)', 'execute')
     or not exists (select 1 from pg_proc as p
                     where p.oid = 'public.clear_unlock_attempt(uuid, text)'::regprocedure
                       and not p.prosecdef
                       and p.proconfig @> array['search_path=""']) then
    raise exception 'RLS FAIL [clear_unlock_attempt grants]: EXECUTE not service-role only, DEFINER, or search_path not fixed';
  end if;
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin
    perform public.clear_unlock_attempt(book_a, ip_1);
    raise exception 'RLS FAIL [anon clear_unlock_attempt]: anon could execute it';
  exception when insufficient_privilege then null;
  end;
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  begin
    perform public.clear_unlock_attempt(book_a, ip_1);
    raise exception 'RLS FAIL [authenticated clear_unlock_attempt]: the owner could execute it';
  exception when insufficient_privilege then null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  checks := checks + 1;

  -- behaviour: deletes exactly one (the newest) row of the pair; other pairs untouched
  set local role service_role;
  ip_4 := 'rls-check-ip5-' || md5(random()::text);
  delete from public.book_unlock_attempts where book_id = book_e;
  insert into public.book_unlock_attempts (book_id, ip_hash, created_at)
  values (book_e, ip_4, now() - interval '10 minutes'),
         (book_e, ip_4, now() - interval '1 minute'),
         (book_e, ip_3, now()),
         (book_a, ip_4, now());
  if not public.clear_unlock_attempt(book_e, ip_4) then
    raise exception 'RLS FAIL [clear_unlock_attempt]: returned false with rows present';
  end if;
  select count(*) into n from public.book_unlock_attempts where book_id = book_e and ip_hash = ip_4;
  if n <> 1 then raise exception 'RLS FAIL [clear_unlock_attempt]: % rows of the pair left (expected 1)', n; end if;
  if not exists (select 1 from public.book_unlock_attempts
                  where book_id = book_e and ip_hash = ip_4 and created_at < now() - interval '5 minutes') then
    raise exception 'RLS FAIL [clear_unlock_attempt]: did not delete the newest row of the pair';
  end if;
  select count(*) into n from public.book_unlock_attempts
   where (book_id = book_e and ip_hash = ip_3) or (book_id = book_a and ip_hash = ip_4);
  if n <> 2 then raise exception 'RLS FAIL [clear_unlock_attempt]: touched another pair (% of 2 left)', n; end if;
  -- rows older than 1 hour are never cleared; no row → false
  update public.book_unlock_attempts set created_at = now() - interval '2 hours'
   where book_id = book_e and ip_hash = ip_4;
  if public.clear_unlock_attempt(book_e, ip_4) then
    raise exception 'RLS FAIL [clear_unlock_attempt]: cleared a row older than 1 hour';
  end if;
  if public.clear_unlock_attempt(book_e, 'rls-check-ip6-' || md5(random()::text)) then
    raise exception 'RLS FAIL [clear_unlock_attempt]: returned true for an unknown pair';
  end if;
  checks := checks + 1;

  -- success flow: attempt → clear keeps the book under its limit (only failures count)
  delete from public.book_unlock_attempts where book_id = book_e;
  for k in 1..5 loop
    if not public.try_book_unlock(book_e, ip_4, 100, 2, 60) then
      raise exception 'RLS FAIL [clear_unlock_attempt flow]: successful attempt % refused', k;
    end if;
    perform public.clear_unlock_attempt(book_e, ip_4);
  end loop;
  select count(*) into n from public.book_unlock_attempts where book_id = book_e;
  if n <> 0 then raise exception 'RLS FAIL [clear_unlock_attempt flow]: % attempts left after cleared successes', n; end if;
  begin
    perform public.clear_unlock_attempt(book_e, '');
    raise exception 'RLS FAIL [clear_unlock_attempt args]: empty ip hash accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.clear_unlock_attempt(null, ip_4);
    raise exception 'RLS FAIL [clear_unlock_attempt args]: null book accepted';
  exception when invalid_parameter_value then null;
  end;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- 1200 (M7 payments): orders payment columns + statuses, one pending order per
  -- book, private.stripe_events (service role only), fulfill_book_checkout and
  -- record_stripe_order_event (INVOKER, service-role only, idempotent per event).
  -- ---------------------------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims', '', true);
  -- fresh books (as postgres): book_pay published free (expiry set), book_pay2 plain
  insert into public.books (user_id, title, slug, published_at, expires_at)
  values (uid_a, 'RLS pay', 'rls-check-pay-' || substr(md5(random()::text), 1, 12), now(),
          now() + interval '30 days')
  returning id into book_pay;
  insert into public.books (user_id, title) values (uid_a, 'RLS pay 2') returning id into book_pay2;
  sess_1 := 'cs_test_rls_' || md5(random()::text);
  pi_1   := 'pi_test_rls_' || md5(random()::text);
  evt_1  := 'evt_test_rls_' || md5(random()::text);

  if has_function_privilege('anon', 'public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)', 'execute')
     or has_function_privilege('public', 'public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)', 'execute')
     or has_function_privilege('anon', 'public.record_stripe_order_event(text, text, text, text, text, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.record_stripe_order_event(text, text, text, text, text, boolean)', 'execute')
     or has_function_privilege('public', 'public.record_stripe_order_event(text, text, text, text, text, boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.record_stripe_order_event(text, text, text, text, text, boolean)', 'execute')
     or (select count(*) from pg_proc as p
          where p.oid in ('public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)'::regprocedure,
                          'public.record_stripe_order_event(text, text, text, text, text, boolean)'::regprocedure)
            and not p.prosecdef
            and p.proconfig @> array['search_path=""']) <> 2 then
    raise exception 'RLS FAIL [payments rpc grants]: EXECUTE not service-role only, DEFINER, or search_path not fixed';
  end if;
  checks := checks + 1;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  begin
    perform public.fulfill_book_checkout(evt_1, 'checkout.session.completed', sess_1, pi_1,
                                         book_pay, uid_a, 3900, 'aed', false);
    raise exception 'RLS FAIL [authenticated fulfill_book_checkout]: the owner could execute it';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_stripe_order_event(evt_1, 'charge.refunded', null, pi_1, 'refunded', false);
    raise exception 'RLS FAIL [authenticated record_stripe_order_event]: the owner could execute it';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  begin
    select count(*) into n from private.stripe_events;
    raise exception 'RLS FAIL [stripe_events]: authenticated could read private.stripe_events (% rows)', n;
  exception when insufficient_privilege then null;
  end;
  reset role;
  if has_table_privilege('anon', 'private.stripe_events', 'select, insert, update, delete')
     or has_table_privilege('authenticated', 'private.stripe_events', 'select, insert, update, delete')
     or has_schema_privilege('anon', 'private', 'usage')
     or has_schema_privilege('authenticated', 'private', 'usage')
     or not (select c.relrowsecurity from pg_class as c where c.oid = 'private.stripe_events'::regclass)
     or exists (select 1 from pg_policies as p
                 where p.schemaname = 'private' and p.tablename = 'stripe_events') then
    raise exception 'RLS FAIL [stripe_events]: client grants / schema usage, RLS off or a policy exists';
  end if;
  checks := checks + 1;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'role', 'authenticated')::text, true);
  begin
    insert into public.orders (user_id, book_id, type, amount, status, stripe_session_id)
    values (uid_a, book_pay, 'digital', 0, 'paid', 'cs_client_' || md5(random()::text));
    raise exception 'RLS FAIL [orders insert]: authenticated could insert a paid order';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.orders set status = 'paid' where user_id = uid_a;
    raise exception 'RLS FAIL [orders update]: authenticated could update orders';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  update public.books set is_paid = true, max_pages = 100, expires_at = null where id = book_pay;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RLS FAIL [payments guard]: A could not update own book (% rows)', n; end if;
  select is_paid, max_pages, expires_at into r from public.books where id = book_pay;
  if r.is_paid or r.max_pages <> 20 or r.expires_at is null then
    raise exception 'RLS FAIL [payments guard]: client changed entitlement columns: %', row_to_json(r);
  end if;
  checks := checks + 1;

  -- service role: fulfil flips the book and records a paid order
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  v_txt := public.fulfill_book_checkout(evt_1, 'checkout.session.completed', sess_1, pi_1,
                                        book_pay, uid_a, 3900, 'AED', false);
  if v_txt is distinct from 'fulfilled' then
    raise exception 'RLS FAIL [fulfil]: expected fulfilled, got %', v_txt;
  end if;
  select is_paid, max_pages, expires_at into r from public.books where id = book_pay;
  if not r.is_paid or r.max_pages <> 100 or r.expires_at is not null then
    raise exception 'RLS FAIL [fulfil]: book entitlement not applied: %', row_to_json(r);
  end if;
  select count(*) into n from public.orders
   where stripe_session_id = sess_1 and status = 'paid' and paid_at is not null and type = 'digital'
     and stripe_payment_intent_id = pi_1 and amount = 3900 and currency = 'aed' and livemode = false
     and user_id = uid_a and book_id = book_pay;
  if n <> 1 then raise exception 'RLS FAIL [fulfil]: paid order not recorded as expected (% rows)', n; end if;
  if not exists (select 1 from private.stripe_events where id = evt_1 and processed_at is not null) then
    raise exception 'RLS FAIL [fulfil]: event not recorded as processed';
  end if;
  checks := checks + 1;

  -- replay → duplicate; another event for the same session → already_paid, still one order
  v_txt := public.fulfill_book_checkout(evt_1, 'checkout.session.completed', sess_1, pi_1,
                                        book_pay, uid_a, 3900, 'aed', false);
  if v_txt is distinct from 'duplicate' then
    raise exception 'RLS FAIL [fulfil replay]: replayed event returned %', v_txt;
  end if;
  v_txt := public.fulfill_book_checkout('evt_test_rls_' || md5(random()::text),
                                        'checkout.session.async_payment_succeeded', sess_1, pi_1,
                                        book_pay, uid_a, 3900, 'aed', false);
  if v_txt is distinct from 'already_paid' then
    raise exception 'RLS FAIL [fulfil replay]: second event for a paid book returned %', v_txt;
  end if;
  select count(*) into n from public.orders where stripe_session_id = sess_1;
  if n <> 1 then raise exception 'RLS FAIL [fulfil replay]: % orders for one session', n; end if;
  checks := checks + 1;

  -- user/book mismatch (B paying for A's book) and a missing book never flip a book
  sess_2 := 'cs_test_rls_' || md5(random()::text);
  v_txt := public.fulfill_book_checkout('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                        sess_2, 'pi_test_rls_' || md5(random()::text),
                                        book_pay2, uid_b, 3900, 'aed', false);
  if v_txt is distinct from 'book_missing' then
    raise exception 'RLS FAIL [fulfil mismatch]: user/book mismatch returned %', v_txt;
  end if;
  select is_paid, max_pages into r from public.books where id = book_pay2;
  if r.is_paid or r.max_pages <> 20 then
    raise exception 'RLS FAIL [fulfil mismatch]: another user''s payment flipped the book: %', row_to_json(r);
  end if;
  select count(*) into n from public.orders
   where stripe_session_id = sess_2 and status = 'paid' and book_id is null and user_id = uid_b;
  if n <> 1 then raise exception 'RLS FAIL [fulfil mismatch]: order not kept with book_id null (% rows)', n; end if;
  v_txt := public.fulfill_book_checkout('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                        'cs_test_rls_' || md5(random()::text), null,
                                        gen_random_uuid(), uid_a, 3900, 'aed', false);
  if v_txt is distinct from 'book_missing' then
    raise exception 'RLS FAIL [fulfil mismatch]: missing book returned %', v_txt;
  end if;
  checks := checks + 1;

  -- refund (by payment intent) is logged, never revokes; dispute after refund is unchanged
  evt_2 := 'evt_test_rls_' || md5(random()::text);
  v_txt := public.record_stripe_order_event(evt_2, 'charge.refunded', null, pi_1, 'refunded', false);
  if v_txt is distinct from 'updated' then
    raise exception 'RLS FAIL [refund]: refund event returned %', v_txt;
  end if;
  select count(*) into n from public.orders
   where stripe_session_id = sess_1 and status = 'refunded' and refunded_at is not null and paid_at is not null;
  if n <> 1 then raise exception 'RLS FAIL [refund]: order not marked refunded'; end if;
  if not (select is_paid from public.books where id = book_pay) then
    raise exception 'RLS FAIL [refund]: refund revoked books.is_paid';
  end if;
  if public.record_stripe_order_event(evt_2, 'charge.refunded', null, pi_1, 'refunded', false) is distinct from 'duplicate'
     or public.record_stripe_order_event('evt_test_rls_' || md5(random()::text), 'charge.dispute.created',
                                         null, pi_1, 'disputed', false) is distinct from 'unchanged' then
    raise exception 'RLS FAIL [refund]: replay not duplicate or dispute overwrote a refund';
  end if;
  checks := checks + 1;

  -- one pending order per book; expired frees the slot; expired never downgrades paid
  insert into public.orders (user_id, book_id, type, amount, status, stripe_session_id)
  values (uid_a, book_pay2, 'digital', 3900, 'pending', 'cs_test_rls_p1_' || md5(random()::text))
  returning stripe_session_id into sess_3;
  begin
    insert into public.orders (user_id, book_id, type, amount, status, stripe_session_id)
    values (uid_a, book_pay2, 'digital', 3900, 'pending', 'cs_test_rls_p2_' || md5(random()::text));
    raise exception 'RLS FAIL [one pending]: a second pending order for the same book was accepted';
  exception when unique_violation then null;
  end;
  v_txt := public.record_stripe_order_event('evt_test_rls_' || md5(random()::text), 'checkout.session.expired',
                                            sess_3, null, 'expired', false);
  if v_txt is distinct from 'updated'
     or not exists (select 1 from public.orders where stripe_session_id = sess_3 and status = 'expired') then
    raise exception 'RLS FAIL [one pending]: expired event returned % / order not expired', v_txt;
  end if;
  insert into public.orders (user_id, book_id, type, amount, status, stripe_session_id)
  values (uid_a, book_pay2, 'digital', 3900, 'pending', 'cs_test_rls_p3_' || md5(random()::text));
  checks := checks + 1;

  if public.record_stripe_order_event('evt_test_rls_' || md5(random()::text), 'checkout.session.expired',
                                      sess_2, null, 'expired', false) is distinct from 'unchanged'
     or not exists (select 1 from public.orders where stripe_session_id = sess_2 and status = 'paid') then
    raise exception 'RLS FAIL [order events]: expired downgraded a paid order';
  end if;
  if public.record_stripe_order_event('evt_test_rls_' || md5(random()::text), 'charge.refunded',
                                      null, 'pi_test_rls_unknown_' || md5(random()::text), 'refunded', false)
     is distinct from 'order_missing' then
    raise exception 'RLS FAIL [order events]: unknown payment intent not reported as order_missing';
  end if;
  checks := checks + 1;

  begin
    perform public.fulfill_book_checkout(null, 'checkout.session.completed', sess_1, pi_1,
                                         book_pay, uid_a, 3900, 'aed', false);
    raise exception 'RLS FAIL [payments args]: null event id accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.fulfill_book_checkout('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                         sess_1, pi_1, null, uid_a, 3900, 'aed', false);
    raise exception 'RLS FAIL [payments args]: null book accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.record_stripe_order_event('evt_test_rls_' || md5(random()::text), 'charge.refunded',
                                             null, null, 'refunded', false);
    raise exception 'RLS FAIL [payments args]: no session id and no payment intent accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.record_stripe_order_event('evt_test_rls_' || md5(random()::text), 'x',
                                             sess_1, null, 'paid', false);
    raise exception 'RLS FAIL [payments args]: status paid accepted by record_stripe_order_event';
  exception when invalid_parameter_value then null;
  end;
  reset role;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- 1300 (M7 review): needs_review (paid but invalid session), double payment
  -- result, no books update when the entitlement already matches.
  -- State here: book_pay paid (sess_1 refunded); book_pay2 unpaid with sess_3
  -- expired + one pending order; sess_2 paid with book_id null.
  -- ---------------------------------------------------------------------------
  set local role service_role;
  v_txt := public.record_stripe_order_event('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                            sess_3, null, 'needs_review', false);
  if v_txt is distinct from 'updated'
     or not exists (select 1 from public.orders where stripe_session_id = sess_3 and status = 'needs_review') then
    raise exception 'RLS FAIL [needs_review]: expired → needs_review returned % / not stored', v_txt;
  end if;
  select stripe_session_id into v_txt from public.orders where book_id = book_pay2 and status = 'pending';
  -- (separate statements: a query's subqueries don't see writes made by a function it calls)
  v_txt := public.record_stripe_order_event('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                            v_txt, null, 'needs_review', false);
  if v_txt is distinct from 'updated'
     or exists (select 1 from public.orders where book_id = book_pay2 and status = 'pending') then
    raise exception 'RLS FAIL [needs_review]: pending → needs_review did not free the pending slot';
  end if;
  if public.record_stripe_order_event('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                      sess_2, null, 'needs_review', false) is distinct from 'unchanged'
     or not exists (select 1 from public.orders where stripe_session_id = sess_2 and status = 'paid')
     or public.record_stripe_order_event('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                         sess_1, null, 'needs_review', false) is distinct from 'unchanged' then
    raise exception 'RLS FAIL [needs_review]: a paid / refunded order was moved to needs_review';
  end if;
  if (select is_paid from public.books where id = book_pay2) then
    raise exception 'RLS FAIL [needs_review]: needs_review flipped books.is_paid';
  end if;
  checks := checks + 1;

  -- a later valid event for the reviewed session fulfils it; a replay with matching
  -- entitlement leaves the books row untouched (same ctid); a drifted row is repaired
  v_txt := public.fulfill_book_checkout('evt_test_rls_' || md5(random()::text), 'checkout.session.async_payment_succeeded',
                                        sess_3, 'pi_test_rls_' || md5(random()::text), book_pay2, uid_a, 3900, 'aed', false);
  if v_txt is distinct from 'fulfilled'
     or not exists (select 1 from public.orders where stripe_session_id = sess_3 and status = 'paid') then
    raise exception 'RLS FAIL [fulfil no-op]: needs_review session not fulfilled by a valid event (%)', v_txt;
  end if;
  select ctid::text into v_txt from public.books where id = book_pay2;
  if public.fulfill_book_checkout('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                  sess_3, null, book_pay2, uid_a, 3900, 'aed', false) is distinct from 'already_paid' then
    raise exception 'RLS FAIL [fulfil no-op]: already-paid replay was not already_paid';
  end if;
  if (select ctid::text from public.books where id = book_pay2) is distinct from v_txt then
    raise exception 'RLS FAIL [fulfil no-op]: already-paid replay rewrote the book row';
  end if;
  reset role;
  update public.books set max_pages = 50 where id = book_pay2;
  set local role service_role;
  v_txt := public.fulfill_book_checkout('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                        sess_3, null, book_pay2, uid_a, 3900, 'aed', false);
  if v_txt is distinct from 'already_paid'
     or (select max_pages from public.books where id = book_pay2) <> 100 then
    raise exception 'RLS FAIL [fulfil no-op]: drifted entitlement not re-asserted';
  end if;
  checks := checks + 1;

  -- second paid session for a book that already has a paid order → double payment;
  -- a refunded earlier order does not count
  sess_2 := 'cs_test_rls_dbl_' || md5(random()::text);
  v_txt := public.fulfill_book_checkout('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                        sess_2, null, book_pay2, uid_a, 3900, 'aed', false);
  if v_txt is distinct from 'already_paid_other_session'
     or not exists (select 1 from public.orders where stripe_session_id = sess_2 and status = 'paid' and book_id = book_pay2) then
    raise exception 'RLS FAIL [double payment]: second paid session returned % / order not recorded', v_txt;
  end if;
  v_txt := public.fulfill_book_checkout('evt_test_rls_' || md5(random()::text), 'checkout.session.completed',
                                        'cs_test_rls_' || md5(random()::text), null, book_pay, uid_a, 3900, 'aed', false);
  if v_txt is distinct from 'already_paid' then
    raise exception 'RLS FAIL [double payment]: refunded earlier order counted as a second payment (%)', v_txt;
  end if;
  reset role;
  checks := checks + 1;

  -- ---------------------------------------------------------------------------
  -- Done. Raise on purpose so the editor shows it AND everything rolls back.
  -- ---------------------------------------------------------------------------
  reset role;
  raise notice 'RLS OK';
  raise exception 'RLS OK — all % checks passed. (This error is intentional: it rolls back all test data.)', checks;
end
$rls$;
