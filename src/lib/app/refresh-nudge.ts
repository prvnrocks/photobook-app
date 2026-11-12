// Keeps a router.refresh() transition from hanging on routes with a loading.tsx (fix-ai-off-rebuild).
//
// Root cause (Next 15.5.29, vendored React 19.2 canary): a route loading.tsx wraps the page in a
// Suspense boundary that is already showing content when router.refresh() re-renders it. The
// refresh's RSC payload streams in. Its root row arrives first, so React starts the transition render
// while later rows are still missing, and the page suspends inside that visible boundary. A
// transition may not swap visible content for a fallback, so React marks the render "suspended with
// delay" (renderDidSuspendDelayIfPossible) and only then attaches its ping listener. When the thrown
// Flight chunk already holds its data ("resolved_model"), chunk.then() initialises it and calls the
// ping synchronously, inside the render. pingSuspendedRoot ignores pings in render context once the
// exit status is "suspended with delay". So the ping is lost: the root keeps the refresh lanes
// suspended with nothing pending, the transition never commits, and useTransition's isPending stays
// true ("Rebuilding…" forever). Any later update un-suspends the lanes (markRootUpdated clears
// root.suspendedLanes), which is why the *next* refresh used to show the previous one.
//
// The fix: while a refresh transition is pending, the owning component schedules a tiny state update
// every REFRESH_NUDGE_MS. Each one is a normal-priority update that clears the suspended lanes, so
// React retries the refresh. Once the payload has fully arrived the retry commits, isPending turns
// false and the nudges stop. Nothing is faked: the UI only changes when the real refresh commits.
// Routes without a loading boundary never hit the lost ping, and there the nudges are a no-op re-render.

/** Gap between nudges while a refresh is pending. ≈4 cheap re-renders a second for about a second. */
export const REFRESH_NUDGE_MS = 250;

/** Nudging stops after this long, so a refresh that really is stuck (offline) doesn't re-render forever. */
export const REFRESH_NUDGE_MAX_MS = 60_000;

export type NudgeTimers = {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  now: () => number;
};

const defaultTimers: NudgeTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/**
 * Calls `nudge` every `intervalMs` until the returned stop function runs or `maxMs` has passed.
 * The first nudge comes one interval after the start (the refresh has only just been dispatched).
 */
export function startRefreshNudges(
  nudge: () => void,
  { intervalMs = REFRESH_NUDGE_MS, maxMs = REFRESH_NUDGE_MAX_MS, timers = defaultTimers }: {
    intervalMs?: number;
    maxMs?: number;
    timers?: NudgeTimers;
  } = {},
): () => void {
  const startedAt = timers.now();
  let stopped = false;
  const id = timers.setInterval(() => {
    if (stopped) return;
    if (timers.now() - startedAt > maxMs) {
      stop();
      return;
    }
    nudge();
  }, intervalMs);
  function stop() {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(id);
  }
  return stop;
}
