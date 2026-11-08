// Browser side of POST /api/books/[id]/finalize (T9): one call, plus up to
// `extraRuns` follow-up calls while places are still pending (the route caps
// geocoding per run). Counts only — nothing about the photos is sent or logged.
import type { FinalizeResult } from "@/lib/photos/finalize";
import { isUuid } from "@/lib/uuid";

export type { FinalizeResult };

export type FinalizeError = "signed_out" | "not_found" | "failed";

export type FinalizeOutcome =
  | { ok: true; result: FinalizeResult }
  | { ok: false; error: FinalizeError };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const NUMBER_KEYS = [
  "photos",
  "withDate",
  "withGps",
  "withPlace",
  "placesPending",
  "dupGroups",
  "dupPhotos",
  "pages",
] as const;

function isFinalizeResult(v: unknown): v is FinalizeResult {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    NUMBER_KEYS.every((k) => typeof o[k] === "number" && Number.isFinite(o[k])) &&
    typeof o.wroteDoc === "boolean"
  );
}

export async function callFinalize(
  bookId: string,
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
): Promise<FinalizeOutcome> {
  if (!isUuid(bookId)) return { ok: false, error: "not_found" };
  let res: Response;
  try {
    res = await fetchImpl(`/api/books/${bookId}/finalize`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "failed" };
  }
  if (res.status === 401) return { ok: false, error: "signed_out" };
  if (res.status === 404) return { ok: false, error: "not_found" };
  if (!res.ok) return { ok: false, error: "failed" };
  try {
    const body: unknown = await res.json();
    return isFinalizeResult(body) ? { ok: true, result: body } : { ok: false, error: "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/**
 * First call decides success. Follow-up calls (only while placesPending > 0)
 * improve the result; if one fails we keep the last good result.
 */
export async function finalizeWithPlaces(
  bookId: string,
  fetchImpl?: FetchLike,
  extraRuns = 2,
): Promise<FinalizeOutcome> {
  const first = await callFinalize(bookId, fetchImpl);
  if (!first.ok) return first;
  let result = first.result;
  for (let i = 0; i < extraRuns && result.placesPending > 0; i++) {
    const next = await callFinalize(bookId, fetchImpl);
    if (!next.ok) break;
    // Keep "wroteDoc" true if any run wrote the album.
    result = { ...next.result, wroteDoc: result.wroteDoc || next.result.wroteDoc };
  }
  return { ok: true, result };
}
