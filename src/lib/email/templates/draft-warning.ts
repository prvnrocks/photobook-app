// "Your draft photobook will be deleted on <date>" (D-057). Pure — see layout.ts.
import { DRAFT_IDLE_DAYS } from "@/lib/cleanup/rules";
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

export type DraftWarningEmailInput = {
  bookId: string;
  title: string | null;
  /** Earliest deletion time returned by claim_draft_warnings (ISO). */
  deleteAfter: string;
  links: EmailLinks;
};

export const DRAFT_REASON =
  "You're getting this because you started a photobook that was never published and reminder emails are on for your account.";

export function draftWarningSubject(deleteDate: string): string {
  return `Your draft photobook will be deleted on ${deleteDate}`;
}

export function draftWarningEmail(input: DraftWarningEmailInput): EmailContent {
  const when = new Date(input.deleteAfter);
  if (Number.isNaN(when.getTime())) throw new RangeError("draftWarningEmail: invalid deleteAfter");
  const deleteDate = formatEmailDate(when);
  const href = appLink(input.links.appUrl, `/books/${input.bookId}/edit`);
  const cta = { label: "Open it to keep it", href };
  const heading = "Your draft photobook will be deleted soon";
  // Opening the editor of a warned draft touches it server-side (review S3), so the CTA is accurate.
  const after = `Opening it in the editor keeps it for another ${DRAFT_IDLE_DAYS} days. Publishing it keeps it too.`;

  const html = renderHtml({
    preheader: `Open it before ${deleteDate} to keep it.`,
    heading,
    paragraphsHtml: [
      `You haven't changed ${titleHtml(input.title)} for a while. Drafts that are never published are deleted after ${DRAFT_IDLE_DAYS} days without changes.`,
      `We'll delete this draft and its photos on <strong>${deleteDate}</strong>.`,
    ],
    cta,
    afterCtaHtml: after,
    reason: DRAFT_REASON,
    links: input.links,
  });

  const text = renderText({
    heading,
    paragraphs: [
      `You haven't changed ${titleText(input.title)} for a while. Drafts that are never published are deleted after ${DRAFT_IDLE_DAYS} days without changes.`,
      `We'll delete this draft and its photos on ${deleteDate}.`,
    ],
    cta,
    afterCta: after,
    reason: DRAFT_REASON,
    links: input.links,
  });

  return { subject: draftWarningSubject(deleteDate), html, text };
}
