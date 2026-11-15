import { describe, expect, it } from "vitest";
import { EXPIRING_SOON_DAYS, shareStatus, type ShareStatusInput } from "@/lib/publish/status";

// M21 T1: share-page status. kind = primary action, chip = badge (paid / link lifetime).

const NOW = new Date("2026-11-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function st(over: Partial<ShareStatusInput> = {}): ShareStatusInput {
  return { published: true, hasChanges: false, expiresAt: at(20 * DAY), expired: false, isPaid: false, ...over };
}

describe("shareStatus", () => {
  it("never published → draft / Draft / share step current", () => {
    expect(shareStatus(st({ published: false, expiresAt: null }), NOW)).toEqual({
      kind: "draft",
      chip: "Draft",
      step: "current",
      daysLeft: null,
    });
  });

  it("unpublished after a publish (clock still running) → draft", () => {
    expect(shareStatus(st({ published: false }), NOW)).toMatchObject({ kind: "draft", chip: "Draft" });
  });

  it("live free link with > 7 days → live / Live", () => {
    expect(shareStatus(st(), NOW)).toEqual({ kind: "live", chip: "Live", step: "done", daysLeft: 20 });
    expect(shareStatus(st({ expiresAt: at(7 * DAY + 1) }), NOW)).toMatchObject({ kind: "live", chip: "Live", daysLeft: 8 });
  });

  it("7-day edge: exactly 7 days left → expiring, 'Expires in 7 days'", () => {
    expect(EXPIRING_SOON_DAYS).toBe(7);
    expect(shareStatus(st({ expiresAt: at(7 * DAY) }), NOW)).toEqual({
      kind: "expiring",
      chip: "Expires in 7 days",
      step: "done",
      daysLeft: 7,
    });
  });

  it("partial days round up; the last day is singular", () => {
    expect(shareStatus(st({ expiresAt: at(2 * DAY + 1) }), NOW).chip).toBe("Expires in 3 days");
    expect(shareStatus(st({ expiresAt: at(1) }), NOW)).toMatchObject({ kind: "expiring", chip: "Expires in 1 day", daysLeft: 1 });
  });

  it("expired: at / past expiresAt, the expired flag, or an unparsable date (fail closed)", () => {
    const expired = { kind: "expired", chip: "Expired", step: "current", daysLeft: null };
    expect(shareStatus(st({ expiresAt: at(0) }), NOW)).toEqual(expired);
    expect(shareStatus(st({ expiresAt: at(-DAY) }), NOW)).toEqual(expired);
    expect(shareStatus(st({ expired: true }), NOW)).toEqual(expired);
    expect(shareStatus(st({ expiresAt: "not-a-date" }), NOW)).toEqual(expired);
    // expired wins over unpublished and over changes
    expect(shareStatus(st({ published: false, expiresAt: at(-1) }), NOW).kind).toBe("expired");
    expect(shareStatus(st({ hasChanges: true, expiresAt: at(-1) }), NOW).kind).toBe("expired");
  });

  it("free live with changes → kind changes; chip still shows the link lifetime", () => {
    expect(shareStatus(st({ hasChanges: true }), NOW)).toMatchObject({ kind: "changes", chip: "Live", step: "done" });
    expect(shareStatus(st({ hasChanges: true, expiresAt: at(3 * DAY) }), NOW)).toMatchObject({
      kind: "changes",
      chip: "Expires in 3 days",
      daysLeft: 3,
    });
  });

  it("paid: up to date → paid; with changes → kind changes but chip Paid · permanent", () => {
    expect(shareStatus(st({ isPaid: true, expiresAt: null }), NOW)).toEqual({
      kind: "paid",
      chip: "Paid · permanent",
      step: "done",
      daysLeft: null,
    });
    expect(shareStatus(st({ isPaid: true, hasChanges: true, expiresAt: null }), NOW)).toEqual({
      kind: "changes",
      chip: "Paid · permanent",
      step: "done",
      daysLeft: null,
    });
  });

  it("paid never expires, even with a stale free expiry; paid unpublished → draft", () => {
    expect(shareStatus(st({ isPaid: true, expiresAt: at(-30 * DAY), expired: true }), NOW).kind).toBe("paid");
    expect(shareStatus(st({ isPaid: true, expiresAt: at(2 * DAY) }), NOW).chip).toBe("Paid · permanent");
    expect(shareStatus(st({ isPaid: true, published: false, expiresAt: null }), NOW)).toMatchObject({ kind: "draft", chip: "Draft" });
  });

  it("live free with no expiry recorded → live, no daysLeft", () => {
    expect(shareStatus(st({ expiresAt: null }), NOW)).toEqual({ kind: "live", chip: "Live", step: "done", daysLeft: null });
  });
});
