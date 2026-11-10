-- =============================================================================
-- 20261114001700_payments_hardening.sql — Milestone 9 T7: payments hardening +
-- comped demo books (D-045, D-061)
--
-- Additive only: 0100–1600 are committed (0100–1500 applied in production) and
-- must not be edited.
--
-- 1) public.orders
--      + note      text  — free-text audit note (comp reason, manual fixes);
--                          1..200 chars, no control characters. Readable by the
--                          book owner (orders_select_own) — write it for them.
--      + comped_by uuid  — the admin who comped the order (no FK: the audit
--                          value survives the admin account).
--    status check widened with 'comped'. orders_comp_shape: a 'comped' order
--    has comped_by set, amount 0, no Stripe session / payment intent.
--    (stripe_session_id is nullable; its unique constraint allows many nulls,
--    orders_one_pending_per_book only covers 'pending'.)
--
-- 2) public.fulfill_book_checkout — same signature / returns text, replaced in
--    place; grants re-asserted. Changes vs 1300 (re-review NICE 2):
--      * "money / entitlement already held by ANOTHER session's order" now means
--        status in ('paid', 'disputed', 'needs_review', 'comped'). needs_review =
--        Stripe took the money but we never fulfilled; comped = the book was given
--        away, so a real payment on top is redundant. 'refunded' still doesn't
--        count (money went back); pending / expired / failed never took money.
--      * A replay for a session whose order was ALREADY paid / disputed /
--        refunded before this call is a repeat of a recorded payment (e.g.
--        completed → async_payment_succeeded): it never reports a double
--        payment again — the extra session is flagged exactly once.
--      Results (exact semantics):
--        duplicate                    event id already processed; nothing else ran.
--        book_missing                 book missing / not p_user_id's: order kept
--                                     with book_id null, no book touched.
--        fulfilled                    book flipped to paid now; no other session's
--                                     order holds money for it.
--        fulfilled_after_review_order book flipped to paid now, BUT another
--                                     session's order for the book is
--                                     'needs_review' (money taken, not fulfilled)
--                                     → the user has paid twice; the webhook logs
--                                     double_payment for a manual refund of ONE of
--                                     them. Entitlement is granted either way.
--        already_paid                 book was already paid and either this event
--                                     repeats a payment already recorded for this
--                                     session, or no other session's order holds
--                                     money / a comp.
--        already_paid_other_session   book was already paid, this session's
--                                     payment is new, and another session's order
--                                     is paid / disputed / needs_review / comped
--                                     → double payment (refund this one).
--      The order for this session is always recorded 'paid' (a refunded /
--      disputed order is never moved back) and the no-op books update is still
--      skipped. 22023 on invalid arguments (unchanged).
--
-- 3) public.comp_book(p_book uuid, p_admin uuid, p_reason text) returns text
--    D-061: the ONE exception to "only the Stripe webhook sets books.is_paid" —
--    admin-only, used by scripts/comp-book.mjs (secret key; the script checks
--    p_admin against ADMIN_USER_IDS). SECURITY INVOKER, search_path '',
--    EXECUTE for service_role only (the column guard lets service_role write
--    the entitlement columns; anon / authenticated cannot even call it).
--      * 22023 when an argument is null, p_admin has no profile, or the trimmed
--        reason is not 1..200 chars / contains control characters;
--      * locks the book row; missing → 'not_found';
--      * already paid (webhook, earlier comp or manual) → 'already_paid', no
--        order written;
--      * else inserts ONE order (user = book owner, type 'digital', amount 0,
--        currency 'aed', status 'comped', paid_at now(), livemode false,
--        stripe ids null, note = trimmed reason, comped_by = p_admin) and sets
--        is_paid = true, max_pages = 100, expires_at = null → 'comped'.
--    Retention (1600) needs no change: comped books are protected through
--    books.is_paid. A reverted comp (runbook: is_paid = false + order note)
--    is an ordinary free book again.
--
-- 4) public.delete_book_guarded(p_book uuid, p_user uuid) returns text
--    Owner-initiated book delete (T6) that can never delete a book holding
--    money / entitlement. SECURITY INVOKER, search_path '', service_role only
--    (callers MUST pass the session user's id as p_user).
--      * 22023 when an argument is null;
--      * locks the book FOR UPDATE where id = p_book AND user_id = p_user;
--        no row → 'not_found' (missing or someone else's: indistinguishable);
--      * is_paid, or ANY order for the book in status pending / paid /
--        needs_review / disputed / comped → 'protected' (nothing changes);
--      * else deletes the book row → 'deleted'. FK cascades remove photos,
--        exports, unlock attempts, photo notes; orders / agent_runs keep their
--        rows with book_id null (set null). Storage objects are NOT removed here
--        — the caller removes {user}/{book}/ in 'photos' and 'exports' after
--        commit (row-then-storage, D-056; the orphan sweep is the safety net).
--    Race with a concurrent checkout: inserting an order takes FOR KEY SHARE on
--    the referenced books row (FK check), which conflicts with our FOR UPDATE.
--      - our lock first → the order insert waits, then fails 23503 after the
--        delete commits (no order for a deleted book);
--      - their insert first (uncommitted) → our FOR UPDATE waits for their
--        commit; the order check runs as a SEPARATE statement afterwards (fresh
--        READ COMMITTED snapshot) and sees the pending order → 'protected'.
--    So no advisory lock is needed (the checkout path takes none). Residual,
--    pre-existing: the Stripe Checkout Session is created BEFORE the pending
--    order insert, so a session for a just-deleted book can exist; paying it
--    reaches the webhook as 'book_missing' (order kept, warn log → RUNBOOK).
--
-- Deploy: safe before or after the T7 code. Old webhook + new function: the
-- unknown result 'fulfilled_after_review_order' makes fulfillBookCheckout throw
-- bad_result → 500 once, and Stripe's retry is a 'duplicate' (200) — the book
-- is paid either way, only the double_payment log line is lost. Apply → run
-- rls_check → deploy code.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) orders: note, comped_by, status 'comped'
-- ---------------------------------------------------------------------------
alter table public.orders
  add column note      text,
  add column comped_by uuid;

alter table public.orders
  add constraint orders_note_check check (
    note is null or (char_length(note) between 1 and 200 and note !~ '[[:cntrl:]]')
  );

alter table public.orders drop constraint orders_status_check;
alter table public.orders
  add constraint orders_status_check check (
    status in ('pending', 'paid', 'failed', 'expired', 'refunded', 'disputed', 'needs_review', 'comped')
  );

alter table public.orders
  add constraint orders_comp_shape check (
    status <> 'comped'
    or (comped_by is not null and amount = 0
        and stripe_session_id is null and stripe_payment_intent_id is null)
  );

-- ---------------------------------------------------------------------------
-- 2) fulfill_book_checkout — needs_review / comped count as money held elsewhere
-- ---------------------------------------------------------------------------
create or replace function public.fulfill_book_checkout(
  p_event_id       text,
  p_event_type     text,
  p_session_id     text,
  p_payment_intent text,
  p_book_id        uuid,
  p_user_id        uuid,
  p_amount         integer,
  p_currency       text,
  p_livemode       boolean
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_inserted  text;
  v_book      uuid;
  v_was_paid  boolean;
  v_max_pages integer;
  v_expires   timestamptz;
  v_user      uuid;
  v_prev      text;
  v_taken     boolean;
  v_review    boolean;
begin
  if p_event_id is null or p_event_type is null or p_session_id is null
     or p_book_id is null or p_user_id is null or p_amount is null
     or p_currency is null or p_livemode is null
     or char_length(p_event_id) = 0 or char_length(p_event_type) = 0
     or char_length(p_session_id) = 0 or char_length(p_currency) = 0
     or p_amount < 0
     or (p_payment_intent is not null and char_length(p_payment_intent) = 0) then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  insert into private.stripe_events (id, type)
  values (p_event_id, p_event_type)
  on conflict (id) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    return 'duplicate';
  end if;

  select b.id, b.is_paid, b.max_pages, b.expires_at
    into v_book, v_was_paid, v_max_pages, v_expires
    from public.books as b
   where b.id = p_book_id and b.user_id = p_user_id
     for update;

  -- status of this session's order BEFORE this event (null = first sight)
  select o.status into v_prev
    from public.orders as o
   where o.stripe_session_id = p_session_id
     for update;

  -- profiles row exists for every auth user (handle_new_user) and cascades with it
  select pr.id into v_user from public.profiles as pr where pr.id = p_user_id;

  insert into public.orders as o
    (user_id, book_id, type, amount, currency, status, stripe_session_id,
     stripe_payment_intent_id, paid_at, livemode)
  values
    (v_user, v_book, 'digital', p_amount, lower(p_currency), 'paid', p_session_id,
     p_payment_intent, now(), p_livemode)
  on conflict (stripe_session_id) do update
     set status = case when o.status in ('refunded', 'disputed') then o.status else 'paid' end,
         paid_at = coalesce(o.paid_at, excluded.paid_at),
         stripe_payment_intent_id = coalesce(excluded.stripe_payment_intent_id, o.stripe_payment_intent_id),
         amount = excluded.amount,
         currency = excluded.currency,
         livemode = excluded.livemode,
         user_id = excluded.user_id,
         book_id = excluded.book_id;

  update private.stripe_events as e set processed_at = now() where e.id = p_event_id;

  if v_book is null then
    return 'book_missing';
  end if;

  if not (v_was_paid and v_max_pages = 100 and v_expires is null) then
    update public.books as b
       set is_paid = true, max_pages = 100, expires_at = null
     where b.id = v_book and b.user_id = p_user_id;
  end if;

  -- separate statements (fresh snapshot after the writes above)
  select exists (select 1 from public.orders as o2
                  where o2.book_id = v_book
                    and o2.stripe_session_id is distinct from p_session_id
                    and o2.status in ('paid', 'disputed', 'needs_review', 'comped'))
    into v_taken;
  select exists (select 1 from public.orders as o3
                  where o3.book_id = v_book
                    and o3.stripe_session_id is distinct from p_session_id
                    and o3.status = 'needs_review')
    into v_review;

  if v_was_paid then
    if v_taken and coalesce(v_prev, '') not in ('paid', 'disputed', 'refunded') then
      return 'already_paid_other_session';
    end if;
    return 'already_paid';
  end if;
  if v_review then
    return 'fulfilled_after_review_order';
  end if;
  return 'fulfilled';
end;
$$;

revoke all on function public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3) comp_book — admin-only comped entitlement (D-061)
-- ---------------------------------------------------------------------------
create or replace function public.comp_book(
  p_book   uuid,
  p_admin  uuid,
  p_reason text
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_reason text := btrim(p_reason);
  v_owner  uuid;
  v_paid   boolean;
begin
  if p_book is null or p_admin is null or v_reason is null
     or char_length(v_reason) not between 1 and 200
     or v_reason ~ '[[:cntrl:]]'
     or not exists (select 1 from public.profiles as pr where pr.id = p_admin) then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  select b.user_id, b.is_paid into v_owner, v_paid
    from public.books as b
   where b.id = p_book
     for update;
  if v_owner is null then
    return 'not_found';
  end if;
  if v_paid then
    return 'already_paid';
  end if;

  insert into public.orders
    (user_id, book_id, type, amount, currency, status, stripe_session_id,
     stripe_payment_intent_id, paid_at, livemode, note, comped_by)
  values
    (v_owner, p_book, 'digital', 0, 'aed', 'comped', null,
     null, now(), false, v_reason, p_admin);

  update public.books as b
     set is_paid = true, max_pages = 100, expires_at = null
   where b.id = p_book;

  return 'comped';
end;
$$;

revoke all on function public.comp_book(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.comp_book(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4) delete_book_guarded — owner delete that never removes a protected book
-- ---------------------------------------------------------------------------
create or replace function public.delete_book_guarded(
  p_book uuid,
  p_user uuid
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_book      uuid;
  v_paid      boolean;
  v_protected boolean;
begin
  if p_book is null or p_user is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  select b.id, b.is_paid into v_book, v_paid
    from public.books as b
   where b.id = p_book and b.user_id = p_user
     for update;
  if v_book is null then
    return 'not_found';
  end if;

  -- separate statement AFTER the lock: fresh snapshot sees orders committed while we waited
  select exists (select 1 from public.orders as o
                  where o.book_id = v_book
                    and o.status in ('pending', 'paid', 'needs_review', 'disputed', 'comped'))
    into v_protected;
  if v_paid or v_protected then
    return 'protected';
  end if;

  delete from public.books as b where b.id = v_book and b.user_id = p_user;
  return 'deleted';
end;
$$;

revoke all on function public.delete_book_guarded(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_book_guarded(uuid, uuid) to service_role;
