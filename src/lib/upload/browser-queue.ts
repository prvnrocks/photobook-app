// Upload queue wired to the browser Supabase client. Loaded with a dynamic
// import from the upload screen on the first selection, so supabase-js, the
// queue and (one level deeper) exifr / heic2any stay out of the first load.
// Publishable-key client only (RLS enforced) — no secrets here.
import { createClient } from "@/lib/supabase/client";
import { createUploadQueue, type UploadQueue, type UploadQueueDeps } from "./queue";
import { createSupabaseUploadDeps } from "./supabase-adapters";

export type BrowserQueueOptions = Pick<
  UploadQueueDeps,
  "userId" | "bookId" | "isPaid" | "existing" | "onEvent"
>;

export function createBrowserUploadQueue(opts: BrowserQueueOptions): UploadQueue {
  const supabase = createClient();
  return createUploadQueue({
    ...opts,
    ...createSupabaseUploadDeps(supabase, opts.bookId),
    // heic2any / exifr live behind this import (and further lazy imports inside).
    process: async (file) => (await import("@/lib/image/process-photo")).processPhoto(file),
  });
}
