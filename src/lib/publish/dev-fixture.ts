// Fixture PublishStates for the dev-only /dev-publish route and unit tests (M6 T8). Pure data.

import type { PublishState } from "@/app/books/[id]/publish/actions";

export const DEV_PUBLISH_STATES = [
  "draft",
  "draft-paid",
  "empty",
  "page_limit",
  "invalid_doc",
  "live",
  "live-paid",
  "changes",
  "password",
  "expired",
  "unpublished",
  // M21 share page fixture names (dev-publish screenshots): live with ≤ 7 days left, paid + live,
  // and a blocked draft (page limit).
  "expiring",
  "paid",
  "blocked",
] as const;
export type DevPublishStateName = (typeof DEV_PUBLISH_STATES)[number];

export const DEV_PUBLISH_URL = "https://photobook.example/b/sara-and-omar-wedding-7Hq2xYp9Kd";
const SLUG = "sara-and-omar-wedding-7Hq2xYp9Kd";
const EXPIRES = "2026-12-12T08:00:00.000Z";
const PUBLISHED = "2026-11-12T08:00:00.000Z";

const base: PublishState = {
  published: false,
  slug: null,
  url: null,
  hasChanges: false,
  expiresAt: null,
  expired: false,
  isPaid: false,
  hasPassword: false,
  publishedAt: null,
  lastPublishedAt: null,
  pageCount: 12,
  maxPages: 20,
  canPublishReason: null,
};

const live: PublishState = {
  ...base,
  published: true,
  slug: SLUG,
  url: DEV_PUBLISH_URL,
  expiresAt: EXPIRES,
  publishedAt: PUBLISHED,
  lastPublishedAt: PUBLISHED,
};

const DAY_MS = 86_400_000;

/** `now` only matters for "expiring" (expires 3 days from now). */
export function devPublishState(name: DevPublishStateName, now: Date = new Date()): PublishState {
  switch (name) {
    case "draft":
      return base;
    case "draft-paid":
      return { ...base, isPaid: true, maxPages: 100 };
    case "empty":
      return { ...base, pageCount: 0, canPublishReason: "empty" };
    case "page_limit":
      return { ...base, pageCount: 24, canPublishReason: "page_limit" };
    case "invalid_doc":
      return { ...base, canPublishReason: "invalid_doc" };
    case "live":
      return live;
    case "live-paid":
      return { ...live, isPaid: true, expiresAt: null, maxPages: 100 };
    case "changes":
      return { ...live, hasChanges: true };
    case "password":
      return { ...live, hasPassword: true };
    case "expired":
      return { ...live, expiresAt: "2026-11-01T08:00:00.000Z", expired: true, canPublishReason: "expired" };
    case "unpublished":
      return { ...base, slug: SLUG, url: DEV_PUBLISH_URL, expiresAt: EXPIRES, publishedAt: PUBLISHED, lastPublishedAt: PUBLISHED };
    case "expiring":
      return { ...live, expiresAt: new Date(now.getTime() + 3 * DAY_MS).toISOString() };
    case "paid":
      return { ...live, isPaid: true, expiresAt: null, maxPages: 100, pageCount: 32 };
    case "blocked":
      return { ...base, pageCount: 24, canPublishReason: "page_limit" };
  }
}

export function parseDevPublishState(v: unknown): DevPublishStateName {
  return (DEV_PUBLISH_STATES as readonly string[]).includes(String(v)) ? (v as DevPublishStateName) : "draft";
}
