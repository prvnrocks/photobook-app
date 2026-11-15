// Browser side of GET /api/books/[id]/wizard?step=5|6|7 (M20 T6, D-072): the data the wizard's steps
// 5 Photos, 6 Sorting and 7 Review need once they run inside /books/new without a page load.
// Client-safe and tiny: fetch only, no zod, no React; the data types are erased type imports.
// Only the book id travels; nothing about photos is logged.

import type { WizardStep5Data, WizardStep6Data, WizardStep7Data, WizardStepData } from "./wizard-data";

export type { WizardStep5Data, WizardStep6Data, WizardStep7Data, WizardStepData };

export type WizardDataStepNumber = 5 | 6 | 7;

export type WizardDataByStep = { 5: WizardStep5Data; 6: WizardStep6Data; 7: WizardStep7Data };

export type FetchWizardStepResult<S extends WizardDataStepNumber> =
  | { ok: true; data: WizardDataByStep[S] }
  | { ok: false; error: "signed_out" | "not_found" | "unavailable" | "failed" };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function wizardDataUrl(bookId: string, step: WizardDataStepNumber, auto = false): string {
  return `/api/books/${encodeURIComponent(bookId)}/wizard?step=${step}${auto ? "&auto=1" : ""}`;
}

/** Loads one step's data. Never throws (network / parse errors → "failed"). */
export async function fetchWizardStep<S extends WizardDataStepNumber>(
  bookId: string,
  step: S,
  opts: { auto?: boolean; signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<FetchWizardStepResult<S>> {
  const doFetch = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  let res: Response;
  try {
    res = await doFetch(wizardDataUrl(bookId, step, opts.auto), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
    });
  } catch {
    return { ok: false, error: "failed" };
  }
  if (res.status === 401) return { ok: false, error: "signed_out" };
  if (res.status === 404) return { ok: false, error: "not_found" };
  if (res.status === 503) return { ok: false, error: "unavailable" };
  if (!res.ok) return { ok: false, error: "failed" };
  try {
    const data = (await res.json()) as WizardStepData;
    if (!data || typeof data !== "object" || data.step !== step || data.bookId !== bookId) {
      return { ok: false, error: "failed" };
    }
    return { ok: true, data: data as WizardDataByStep[S] };
  } catch {
    return { ok: false, error: "failed" };
  }
}
