"use client";
// router.refresh() in a transition that is guaranteed to settle, even on routes with a loading.tsx.
// Use it instead of `startTransition(() => router.refresh())`. Without it, the refresh can stay
// pending forever: React drops a ping inside the route's loading Suspense boundary. The full root
// cause is in src/lib/app/refresh-nudge.ts.
import { useCallback, useEffect, useReducer, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startRefreshNudges } from "@/lib/app/refresh-nudge";

/** [pending, refresh]: `pending` is true from the refresh call until the fresh server render commits. */
export function useRefreshTransition(): [boolean, () => void] {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Each nudge is a normal-priority re-render of this component only. It makes React retry the
  // suspended refresh (see refresh-nudge.ts). The counter value itself is never read.
  const [, nudge] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!pending) return;
    return startRefreshNudges(nudge);
  }, [pending]);

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  return [pending, refresh];
}
