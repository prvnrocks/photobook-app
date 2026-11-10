// Dashboard "Delete book" (M9 T6 / T10, D-060): result shape of deleteBookAction and its copy.
// Pure + isomorphic — lives outside the "use server" file (those may only export async functions).

export type DeleteBookActionError = "unauthenticated" | "not_found" | "protected" | "failed";

export type DeleteBookActionResult = { ok: true } | { ok: false; error: DeleteBookActionError };

export const DELETE_BOOK_COPY = {
  menuLabel: "Book options",
  menuItem: "Delete book",
  title: "Delete this book?",
  detail: "The book, its photos, its share link and any PDF are deleted for good. This can't be undone.",
  cancel: "Cancel",
  confirm: "Delete book",
  deleting: "Deleting…",
} as const;

export function deleteBookErrorCopy(error: DeleteBookActionError | string | null | undefined): string {
  switch (error) {
    case "protected":
      return "This book has a payment — contact support to delete it.";
    case "unauthenticated":
      return "Your session has ended. Please sign in again.";
    case "not_found":
      return "This book was already deleted.";
    default:
      return "We couldn't delete this book. Please try again.";
  }
}
