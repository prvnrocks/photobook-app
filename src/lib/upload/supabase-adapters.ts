// Browser Supabase wiring for the upload queue: photos rows are inserted /
// updated directly under RLS (T8), files go straight to the private `photos`
// bucket. Safe for "use client" code: publishable-key client only, no secrets.
// Errors are passed through as codes/status only — never logged here.
import type { createClient } from "@/lib/supabase/client";
import type { ExistingPhoto, UploadQueueDeps } from "./queue";
import { ROW_MISSING_CODE } from "./queue";

type BrowserClient = ReturnType<typeof createClient>;

/**
 * 1 h. Paths contain the photo id and are overwritten only while the row is still
 * pending (retries / resume), but keep caches short so an overwrite never lingers.
 */
const CACHE_CONTROL = "3600";
const FIND_CHUNK = 100;

export function createSupabaseUploadDeps(
  supabase: BrowserClient,
  bookId: string,
): Pick<UploadQueueDeps, "db" | "storage"> {
  return {
    db: {
      async insertPending(rows) {
        const { data, error } = await supabase.from("photos").insert(rows).select("id, fingerprint");
        return { data: data ?? null, error: error ?? null };
      },

      async markReady(id, patch) {
        const { data, error } = await supabase
          .from("photos")
          .update(patch)
          .eq("id", id)
          .eq("book_id", bookId)
          .select("id");
        if (error) return { error };
        // 0 rows = the row was deleted meanwhile (e.g. "remove unfinished" in another tab).
        if (!data || data.length === 0) return { error: { code: ROW_MISSING_CODE } };
        return { error: null };
      },

      async findByFingerprints(fps) {
        const out: ExistingPhoto[] = [];
        for (let i = 0; i < fps.length; i += FIND_CHUNK) {
          const { data, error } = await supabase
            .from("photos")
            .select("id, fingerprint, upload_state")
            .eq("book_id", bookId)
            .in("fingerprint", fps.slice(i, i + FIND_CHUNK));
          if (error) throw new Error(`findByFingerprints failed (${error.code ?? "unknown"})`);
          for (const r of data ?? []) {
            out.push({
              id: r.id,
              fingerprint: r.fingerprint,
              upload_state: r.upload_state === "ready" ? "ready" : "pending",
            });
          }
        }
        return out;
      },
    },

    storage: {
      async upload(path, blob, contentType) {
        const { error } = await supabase.storage
          .from("photos")
          .upload(path, blob, { contentType, upsert: true, cacheControl: CACHE_CONTROL });
        if (!error) return { error: null };
        const e = error as { message?: string; statusCode?: string; status?: number };
        return {
          error: {
            message: e.message ?? "upload failed",
            statusCode: typeof e.statusCode === "string" ? e.statusCode : undefined,
            status: typeof e.status === "number" ? e.status : undefined,
          },
        };
      },
    },
  };
}
