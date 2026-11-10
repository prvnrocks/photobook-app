-- =============================================================================
-- 20261111001100_unlock_tuning.sql — M6 review S2 (D-040)
--
-- Only FAILED password unlocks should count toward the rate limits, so a group of
-- guests on one network (wedding wifi, CGNAT) who all know the password is never
-- locked out. try_book_unlock (1000) still records every attempt BEFORE the scrypt
-- verify (atomic check + record); after a successful verify the server now calls
--
--   public.clear_unlock_attempt(p_book uuid, p_ip_hash text) → boolean
--
-- which deletes the NEWEST attempt row of that (book, ip_hash) pair recorded within
-- the last hour (the row the successful attempt itself inserted; rows of one pair are
-- interchangeable, so a concurrent attempt of the same pair can't be harmed).
-- Returns true when a row was deleted. Invalid args (null / empty ip hash) → 22023.
--
-- SECURITY INVOKER + fixed search_path: runs with the caller's privileges; only the
-- service role has EXECUTE (and table privileges on book_unlock_attempts). Takes the
-- same advisory locks as try_book_unlock, in the same order (book 4, ip 5).
--
-- Additive only; 1000 is applied in production and is not edited. Server code
-- tolerates this function being absent (PGRST202 / 42883 → ignored), so code may be
-- deployed before or after this migration.
-- =============================================================================

create or replace function public.clear_unlock_attempt(
  p_book    uuid,
  p_ip_hash text
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_book is null or p_ip_hash is null or char_length(p_ip_hash) = 0 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_book::text, 4));
  perform pg_advisory_xact_lock(hashtextextended(p_ip_hash, 5));

  delete from public.book_unlock_attempts as a
   where a.id = (
     select x.id
       from public.book_unlock_attempts as x
      where x.book_id = p_book
        and x.ip_hash = p_ip_hash
        and x.created_at > now() - interval '1 hour'
      order by x.created_at desc, x.id desc
      limit 1
   );
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke all on function public.clear_unlock_attempt(uuid, text)
  from public, anon, authenticated;
grant execute on function public.clear_unlock_attempt(uuid, text)
  to service_role;
