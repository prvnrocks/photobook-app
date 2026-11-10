// Tiny self-contained HTML pages for /api/email/unsubscribe (D-057). Pure. The route answers with
// raw HTML (no app layout, no client JS): mail scanners and one-click POSTs hit it, so it must be
// cheap and must not set cookies.
import { APP_NAME, SUPPORT_EMAIL } from "@/lib/brand";
import { REMINDERS_OFF_NOTICE } from "@/lib/cleanup/rules";
import { escapeHtml } from "@/lib/email/templates/layout";

export type UnsubscribePageKind = "confirm" | "done" | "invalid" | "error";

export const UNSUBSCRIBE_PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  // The token is in the URL — never leak it through a Referer.
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en" dir="ltr">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)} · ${escapeHtml(APP_NAME)}</title>`,
    "</head>",
    `<body style="margin:0;padding:24px 16px;background:#f5f5f4;font-family:${FONT};color:#1f2937;">`,
    '<main style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px 24px;">',
    `<p style="margin:0 0 16px;font-size:14px;font-weight:700;color:#57534e;">${escapeHtml(APP_NAME)}</p>`,
    `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;">${escapeHtml(title)}</h1>`,
    body,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

const p = (html: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;">${html}</p>`;
const settingsLine = p('You can turn reminder emails back on any time in <a href="/settings" style="color:#111827;">Settings</a>.');

/**
 * `formAction` is the same-origin path + query the confirm form posts to (only used for
 * "confirm"; already a relative URL built by the route).
 */
export function unsubscribePage(kind: UnsubscribePageKind, formAction = ""): string {
  switch (kind) {
    case "confirm":
      return page(
        "Turn off reminder emails?",
        p("We'll stop emailing you when a free share link is about to expire or an unpublished draft is about to be deleted.") +
          p(escapeHtml(REMINDERS_OFF_NOTICE)) +
          `<form method="post" action="${escapeHtml(formAction)}" style="margin:0 0 16px;">` +
          '<input type="hidden" name="List-Unsubscribe" value="One-Click">' +
          '<button type="submit" style="font-size:16px;font-weight:600;padding:14px 22px;border:0;border-radius:8px;background:#111827;color:#fff;cursor:pointer;">Unsubscribe</button>' +
          "</form>",
      );
    case "done":
      return page(
        "You're unsubscribed",
        p(escapeHtml(REMINDERS_OFF_NOTICE)) + settingsLine,
      );
    case "invalid":
      return page(
        "This link doesn't work",
        p("This unsubscribe link is invalid or has expired.") +
          p('You can turn reminder emails off in <a href="/settings" style="color:#111827;">Settings</a> instead.'),
      );
    case "error":
      return page(
        "Something went wrong",
        p("We couldn't update your email settings just now. Please try again in a few minutes.") +
          p(`Still stuck? Email <a href="mailto:${escapeHtml(SUPPORT_EMAIL)}" style="color:#111827;">${escapeHtml(SUPPORT_EMAIL)}</a>.`),
      );
  }
}
