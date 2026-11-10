// "Your photobook link expires in 3 days" (D-057). Pure — see layout.ts.
import { EXPIRY_WARNING_DAYS_BEFORE, FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY, freeBookDeleteAfter } from "@/lib/cleanup/rules";
import { UPGRADE } from "@/lib/pricing";
import {
  appLink,
  formatEmailDate,
  renderHtml,
  renderText,
  titleHtml,
  titleText,
  type EmailContent,
  type EmailLinks,
} from "./layout";

export type ExpiryEmailInput = {
  bookId: string;
  title: string | null;
  /** books.expires_at (ISO). */
  expiresAt: string;
  /** Epoch ms the email is built at (for "in N days"). */
  now: number;
  links: EmailLinks;
};

const DAY_MS = 86_400_000;

/** Whole days left, 1…EXPIRY_WARNING_DAYS_BEFORE (a late cron run never says "in 3 days" wrongly). */
export function daysLeft(expiresAt: string, now: number): number {
  const ms = new Date(expiresAt).getTime() - now;
  return Math.min(EXPIRY_WARNING_DAYS_BEFORE, Math.max(1, Math.ceil(ms / DAY_MS)));
}

export function expirySubject(days: number): string {
  return days === 1 ? "Your photobook link expires tomorrow" : `Your photobook link expires in ${days} days`;
}

export const EXPIRY_REASON =
  "You're getting this because you published a free photobook and reminder emails are on for your account.";

export function expiryEmail(input: ExpiryEmailInput): EmailContent {
  const expires = new Date(input.expiresAt);
  if (Number.isNaN(expires.getTime())) throw new RangeError("expiryEmail: invalid expiresAt");
  const days = daysLeft(input.expiresAt, input.now);
  const expiryDate = formatEmailDate(expires);
  const deleteDate = formatEmailDate(freeBookDeleteAfter(expires));
  const href = appLink(input.links.appUrl, `/books/${input.bookId}/publish`);
  const cta = { label: `Upgrade to keep it forever — ${UPGRADE.label}`, href };
  const grace = `${FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY} days`;
  const heading = "Your photobook link expires soon";
  const after = `It's a one-time payment of ${UPGRADE.label} for this book: no watermark, a link that never expires, and a PDF download.`;

  const html = renderHtml({
    preheader: `The share link stops working on ${expiryDate}.`,
    heading,
    paragraphsHtml: [
      `The free share link for ${titleHtml(input.title)} stops working on <strong>${expiryDate}</strong>. After that, people you shared it with will no longer be able to open it.`,
      `If you don't upgrade, the book and its photos are deleted ${grace} later, on <strong>${deleteDate}</strong>.`,
    ],
    cta,
    afterCtaHtml: after,
    reason: EXPIRY_REASON,
    links: input.links,
  });

  const text = renderText({
    heading,
    paragraphs: [
      `The free share link for ${titleText(input.title)} stops working on ${expiryDate}. After that, people you shared it with will no longer be able to open it.`,
      `If you don't upgrade, the book and its photos are deleted ${grace} later, on ${deleteDate}.`,
    ],
    cta,
    afterCta: after,
    reason: EXPIRY_REASON,
    links: input.links,
  });

  return { subject: expirySubject(days), html, text };
}
