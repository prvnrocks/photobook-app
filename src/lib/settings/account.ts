// Settings → email reminders + delete account (M9 T6 / T10, D-057 / D-060). Result shapes of the
// settings server actions and their copy. Pure + isomorphic (no server imports): the "use server"
// file may only export async functions.

export type SetEmailRemindersResult =
  | { ok: true; on: boolean }
  | { ok: false; error: "unauthenticated" | "invalid" | "failed" };

export type DeleteAccountActionResult = {
  ok: false;
  error: "unauthenticated" | "confirm" | "payment_in_progress" | "failed";
};

/** The word the user must type to delete their account. */
export const DELETE_ACCOUNT_CONFIRM_WORD = "DELETE";

/** Exact match after trimming surrounding whitespace (case-sensitive). */
export function isDeleteConfirmed(value: unknown): boolean {
  return typeof value === "string" && value.trim() === DELETE_ACCOUNT_CONFIRM_WORD;
}

/** Query flag on "/" after a successful account deletion (read by AccountDeletedNotice). */
export const ACCOUNT_DELETED_PARAM = "account";
export const ACCOUNT_DELETED_VALUE = "deleted";
export const ACCOUNT_DELETED_HREF = `/?${ACCOUNT_DELETED_PARAM}=${ACCOUNT_DELETED_VALUE}`;

export const ACCOUNT_COPY = {
  remindersHeading: "Email reminders",
  remindersDetail:
    "We email you before a free book's link expires and before an unused draft is deleted. Turn this off to stop these emails.",
  remindersOn: "On",
  remindersOff: "Off",
  remindersSaved: "Saved.",
  remindersLoadError: "Couldn't load this setting right now. Please refresh the page to try again.",
  dangerHeading: "Delete account",
  dangerDetail:
    "Deletes your account and everything in it: all your books (paid books too), their photos, share links and PDFs, and what the AI learned about your choices. Share links stop working straight away. This can't be undone.",
  dangerPayments:
    "We keep a record of past payments (amount and date, without your name or email) for our accounts; Stripe keeps its own payment records. Deleting your account doesn't refund a payment.",
  confirmLabel: `Type ${DELETE_ACCOUNT_CONFIRM_WORD} to confirm`,
  button: "Delete my account",
  deleting: "Deleting…",
  deletedNotice: "Your account and all your books were deleted.",
} as const;

export function remindersErrorCopy(error: string | null | undefined): string {
  return error === "unauthenticated"
    ? "Your session has ended. Please sign in again."
    : "Couldn't save this right now. Please try again.";
}

export function deleteAccountErrorCopy(error: string | null | undefined): string {
  switch (error) {
    case "confirm":
      return `Please type ${DELETE_ACCOUNT_CONFIRM_WORD} to confirm.`;
    case "payment_in_progress":
      return "A payment is still being processed. Please try again in about 30 minutes, or contact support.";
    case "unauthenticated":
      return "Your session has ended. Please sign in again.";
    default:
      return "We couldn't delete your account. Please try again.";
  }
}
