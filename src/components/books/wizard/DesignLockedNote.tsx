// Edit mode (M19 T8): shape + style are fixed once the album was edited or the AI started (D-070).
// Unreachable today: designLockReason === detailsLockReason and /books/new redirects a details-locked
// book to the editor, so `locked` is never true. Kept as defence in case the two locks diverge.
export function DesignLockedNote() {
  return (
    <p className="type-small text-center text-muted-foreground" data-testid="wizard-design-locked">
      Page shape and style are set for this book now, so they can&apos;t change.
    </p>
  );
}
