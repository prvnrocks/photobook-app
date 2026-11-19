// Opt-in timing of storybook run ticks (Task 8 follow-up: where does step 6's wait go?).
// Off unless STORY_TICK_TIMING=1 on the server (local measurement only). When on, every injected
// dependency call of one tick is timed and the tick logs ONE line: total ms, the stage it started /
// ended in, why it ended, and per-dependency call counts + summed ms. Never ids, text, photo data
// or anything from the book — only stage names, counts and milliseconds.

export function storyTimingOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.STORY_TICK_TIMING === "1";
}

export type TickTimer = {
  /** Summed ms + call count per dependency name. */
  calls: Map<string, { n: number; ms: number }>;
  record(name: string, ms: number): void;
  line(fields: Record<string, string | number>): string;
};

export function newTickTimer(): TickTimer {
  const calls = new Map<string, { n: number; ms: number }>();
  return {
    calls,
    record(name, ms) {
      const c = calls.get(name) ?? { n: 0, ms: 0 };
      c.n++;
      c.ms += ms;
      calls.set(name, c);
    },
    line(fields) {
      const head = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      const deps = [...calls]
        .sort((a, b) => b[1].ms - a[1].ms)
        .map(([k, c]) => `${k}:${c.n}x${Math.round(c.ms)}`)
        .join(",");
      return `[story-timing] ${head} deps=${deps}`;
    },
  };
}

/**
 * Wraps every function of `deps` so its (sync or async) duration is recorded on `timer` under its
 * key. Values that are not functions are passed through; results and errors are untouched.
 */
export function timeDeps<D extends object>(deps: D, timer: TickTimer, now: () => number = () => performance.now()): D {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(deps)) {
    if (typeof value !== "function") {
      out[key] = value;
      continue;
    }
    const fn = value as (...args: unknown[]) => unknown;
    out[key] = (...args: unknown[]) => {
      const t = now();
      let res: unknown;
      try {
        res = fn.apply(deps, args);
      } catch (e) {
        timer.record(key, now() - t);
        throw e;
      }
      if (res && typeof (res as Promise<unknown>).then === "function") {
        return (res as Promise<unknown>).finally(() => timer.record(key, now() - t));
      }
      timer.record(key, now() - t);
      return res;
    };
  }
  return out as D;
}
