// Edit mode (M19 T8): shape + style are fixed once the album was edited or the AI started (D-070).
export function DesignLockedNote() {
  return (
    <p className="type-small text-center text-muted-foreground" data-testid="wizard-design-locked">
      Page shape and style are set for this book now, so they can&apos;t change.
    </p>
  );
}
