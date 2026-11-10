// Dev-only fixture names for /dev-upgrade (plain module: constants exported from a "use client"
// file become client references on the server).

export const DEV_UPGRADE_STATES = ["polling", "paid", "paid-live", "failed", "timeout", "signed-out", "not-found"] as const;
export type DevUpgradeState = (typeof DEV_UPGRADE_STATES)[number];
export const DEV_UPGRADE_FLOWS = ["paid", "failed", "timeout"] as const;
export type DevUpgradeFlow = (typeof DEV_UPGRADE_FLOWS)[number];
