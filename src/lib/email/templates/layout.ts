// Shared pieces for the reminder emails (D-057). Pure: no env, no server imports — callers pass
// the app origin and the unsubscribe URL, so templates are deterministic and testable.
//
// Mobile-first plain HTML: one 560 px column that shrinks to the screen, system fonts plus Cairo /
// Tajawal for Arabic titles, inline styles only (mail clients strip <style> and classes), one
// button. User text (book titles) is always escaped and wrapped in dir="auto".
import { APP_NAME, MADE_IN, SUPPORT_EMAIL } from "@/lib/brand";
import { clipCodePoints, stripLoneSurrogates } from "@/lib/text/clip";

export type EmailContent = { subject: string; html: string; text: string };

/** Inputs every reminder template needs besides its own facts. */
export type EmailLinks = {
  /** Canonical app origin, no trailing slash (getSiteUrl()). */
  appUrl: string;
  /** Absolute one-click unsubscribe URL (GET shows a confirmation page). */
  unsubscribeUrl: string;
};

/** Fallback when the book has no title. */
export const UNTITLED_BOOK = "your photobook";
const MAX_TITLE_CODE_POINTS = 120;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Title cleaned for display: control characters removed, whitespace collapsed, clipped; null → null. */
export function cleanTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const t = stripLoneSurrogates(title)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t ? clipCodePoints(t, MAX_TITLE_CODE_POINTS) : null;
}

/** HTML for the book title: `“<span dir="auto">Title</span>”`, or the plain fallback. */
export function titleHtml(title: string | null | undefined): string {
  const t = cleanTitle(title);
  if (!t) return UNTITLED_BOOK;
  return `“<span dir="auto" style="font-weight:600;">${escapeHtml(t)}</span>”`;
}

/** Plain-text title: `“Title”` (FSI/PDI isolates keep Arabic in order), or the fallback. */
export function titleText(title: string | null | undefined): string {
  const t = cleanTitle(title);
  return t ? `“\u2068${t}\u2069”` : UNTITLED_BOOK;
}

/** "17 December 2026" in the UAE calendar. */
export function formatEmailDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) throw new RangeError("formatEmailDate: invalid date");
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Dubai",
  }).format(d);
}

/** Absolute URL on the app origin for an internal path ("/books/…"). */
export function appLink(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, "")}${path}`;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Cairo,Tajawal,Helvetica,Arial,sans-serif";

export type LayoutInput = {
  /** Hidden inbox preview line (plain text). */
  preheader: string;
  heading: string;
  /** Paragraphs as trusted HTML (callers escape user text). */
  paragraphsHtml: string[];
  cta: { label: string; href: string };
  /** Short line under the button (trusted HTML). */
  afterCtaHtml?: string;
  /** Why the reader got this email (plain text). */
  reason: string;
  links: EmailLinks;
};

export function renderHtml(input: LayoutInput): string {
  const p = (html: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#1f2937;">${html}</p>`;
  const support = escapeHtml(SUPPORT_EMAIL);
  return [
    "<!doctype html>",
    '<html lang="en" dir="ltr">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${escapeHtml(input.heading)}</title>`,
    "</head>",
    `<body style="margin:0;padding:0;background:#f5f5f4;font-family:${FONT};">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f4;">',
    '<tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;">',
    '<tr><td style="padding:28px 24px;">',
    `<p style="margin:0 0 20px;font-size:14px;font-weight:700;letter-spacing:0.02em;color:#57534e;">${escapeHtml(APP_NAME)}</p>`,
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;">${escapeHtml(input.heading)}</h1>`,
    ...input.paragraphsHtml.map(p),
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;"><tr>',
    `<td style="border-radius:8px;background:#111827;"><a href="${escapeHtml(input.cta.href)}" style="display:inline-block;padding:14px 22px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(input.cta.label)}</a></td>`,
    "</tr></table>",
    input.afterCtaHtml ? p(input.afterCtaHtml) : "",
    "</td></tr>",
    "</table>",
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">',
    '<tr><td style="padding:16px 24px;font-size:13px;line-height:1.5;color:#78716c;">',
    `<p style="margin:0 0 8px;">${escapeHtml(input.reason)}</p>`,
    `<p style="margin:0 0 8px;"><a href="${escapeHtml(input.links.unsubscribeUrl)}" style="color:#57534e;">Unsubscribe from reminder emails</a> · Questions? <a href="mailto:${support}" style="color:#57534e;">${support}</a></p>`,
    `<p style="margin:0;">${escapeHtml(APP_NAME)} · ${escapeHtml(MADE_IN)}</p>`,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");
}

export type TextInput = {
  heading: string;
  paragraphs: string[];
  cta: { label: string; href: string };
  afterCta?: string;
  reason: string;
  links: EmailLinks;
};

export function renderText(input: TextInput): string {
  return [
    input.heading,
    "",
    ...input.paragraphs.flatMap((p) => [p, ""]),
    `${input.cta.label}:`,
    input.cta.href,
    "",
    ...(input.afterCta ? [input.afterCta, ""] : []),
    "--",
    input.reason,
    `Unsubscribe from reminder emails: ${input.links.unsubscribeUrl}`,
    `Questions? ${SUPPORT_EMAIL}`,
    `${APP_NAME} · ${MADE_IN}`,
    "",
  ].join("\n");
}

/** List-Unsubscribe headers (RFC 8058 one-click). */
export function unsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
