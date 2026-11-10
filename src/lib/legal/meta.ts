// Legal pages state (M9 T12). Pure data.
//
// DRAFT — not legal advice. The Privacy Policy and Terms were drafted by the team and must be
// reviewed by a lawyer before launch (NEEDS-HUMAN, docs/LAUNCH.md). While LEGAL_DRAFT is true,
// both pages show a visible "Draft — under legal review" note. Flip it to false only after sign-off.

export const LEGAL_DRAFT = true;

/** Shown as "Last updated …" on both pages. Update whenever either text changes. */
export const LEGAL_LAST_UPDATED = "2026-11-10";

export const LEGAL_DRAFT_NOTE = "Draft — under legal review";

/** "10 November 2026" — fixed locale/timezone so server and client render the same text. */
export function formatLegalDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
