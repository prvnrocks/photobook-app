// Share link builders. Pure. Never attach analytics/tracking params carrying the book slug.

/** WhatsApp share link: https://wa.me/?text=<title url>. */
export function whatsappShareUrl(title: string, url: string): string {
  const text = [title.trim(), url].filter(Boolean).join(" ");
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** Link target of the free-book footer / end card CTA. */
export const CREATE_YOURS_HREF = "/?ref=book";
