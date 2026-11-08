import "server-only";
// The signed-in user for the current request. React `cache` dedupes this per
// server request, so pages and src/lib/db/* share ONE Auth call (plus the one
// in middleware). getUser() verifies the session with Supabase Auth.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

export const getCurrentUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
});
