// Upgrade confirmation poller (M7 T7). Pure controller — no React, no DOM — so it can be tested
// with fake timers; src/components/upgrade/UpgradeStatusPoller.tsx wires it to React and to
// document.visibilityState. It only reads getUpgradeStatus: the Stripe webhook is the sole writer
// of books.is_paid, and the success page's session_id query param is never consulted.
//
// Rules:
//  - checks immediately, then every `intervalMs` (2 s) after each answer (no overlapping calls);
//  - gives up after `timeoutMs` (60 s) of *visible* polling → "timeout" (never claims success);
//  - while hidden: no timer, the budget clock stops; on show it checks right away and resumes;
//  - { error: 'failed' } (DB read error / network) → keep polling; thrown errors are treated the same;
//  - isPaid → "paid"; orderStatus failed / expired (and not paid) → "failed";
//  - { error: 'unauthenticated' } → "unauthenticated"; { error: 'not_found' } → "not_found";
//  - stop() (unmount) cancels the timer and ignores any in-flight answer.

import type { UpgradeStatusResult } from "./types";

export type UpgradePollPhase = "polling" | "paid" | "failed" | "timeout" | "unauthenticated" | "not_found";

export const UPGRADE_POLL_INTERVAL_MS = 2_000;
export const UPGRADE_POLL_TIMEOUT_MS = 60_000;

export type UpgradePollerOptions = {
  check: () => Promise<UpgradeStatusResult>;
  onPhase: (phase: UpgradePollPhase) => void;
  /** Whether the page is hidden right now (document.hidden); defaults to visible. */
  isHidden?: () => boolean;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
};

export type UpgradePoller = {
  start: () => void;
  stop: () => void;
  /** Call on visibilitychange. */
  setHidden: (hidden: boolean) => void;
};

/** Maps one status answer to a terminal phase, or null to keep polling. */
export function phaseFromStatus(res: UpgradeStatusResult): UpgradePollPhase | null {
  if ("error" in res) {
    if (res.error === "unauthenticated") return "unauthenticated";
    if (res.error === "not_found") return "not_found";
    return null; // failed → retry
  }
  if (res.isPaid) return "paid";
  if (res.orderStatus === "failed" || res.orderStatus === "expired") return "failed";
  return null;
}

export function createUpgradePoller(opts: UpgradePollerOptions): UpgradePoller {
  const intervalMs = opts.intervalMs ?? UPGRADE_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? UPGRADE_POLL_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());

  let started = false;
  let stopped = false;
  let done = false;
  let hidden = opts.isHidden?.() ?? false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeMs = 0;
  let activeSince: number | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const elapsed = () => activeMs + (activeSince === null ? 0 : now() - activeSince);

  const finish = (phase: UpgradePollPhase) => {
    done = true;
    clearTimer();
    if (activeSince !== null) activeMs += now() - activeSince;
    activeSince = null;
    opts.onPhase(phase);
  };

  const schedule = () => {
    clearTimer();
    if (stopped || done || hidden) return;
    const remaining = timeoutMs - elapsed();
    if (remaining <= 0) {
      finish("timeout");
      return;
    }
    timer = setTimeout(tick, Math.min(intervalMs, remaining));
  };

  async function tick(): Promise<void> {
    timer = null;
    if (stopped || done || hidden || inFlight) return;
    inFlight = true;
    let res: UpgradeStatusResult;
    try {
      res = await opts.check();
    } catch {
      res = { error: "failed" };
    }
    inFlight = false;
    if (stopped || done) return;
    const phase = phaseFromStatus(res);
    if (phase) {
      finish(phase);
      return;
    }
    if (elapsed() >= timeoutMs) {
      finish("timeout");
      return;
    }
    schedule();
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      opts.onPhase("polling");
      if (!hidden) {
        activeSince = now();
        void tick();
      }
    },
    stop() {
      stopped = true;
      clearTimer();
    },
    setHidden(next: boolean) {
      if (next === hidden) return;
      hidden = next;
      if (!started || stopped || done) return;
      if (hidden) {
        clearTimer();
        if (activeSince !== null) activeMs += now() - activeSince;
        activeSince = null;
      } else {
        activeSince = now();
        if (!inFlight) void tick();
      }
    },
  };
}
