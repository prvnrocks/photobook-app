// Free link lifetime (D-002, D-039) in a dependency-free module, so client components (editor
// Share button) can show it without pulling the book schema in via rules.ts.

export const FREE_LINK_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where an unpaid book's link stands (D-039: expires_at is set at FIRST publish and never moves):
 * - "unpublished": never published → the 30 days start at the first share;
 * - "counting": the clock is running (live, or unpublished after a publish) → whole days left (≥ 1);
 * - "expired": past expires_at (or an unparsable value — fail closed, like rules.isExpired).
 */
export type FreeLinkState = { kind: "unpublished" } | { kind: "counting"; daysLeft: number } | { kind: "expired" };

export function freeLinkState(expiresAt: string | null | undefined, now: Date): FreeLinkState {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return { kind: "unpublished" };
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms) || ms <= now.getTime()) return { kind: "expired" };
  return { kind: "counting", daysLeft: Math.max(1, Math.ceil((ms - now.getTime()) / DAY_MS)) };
}
