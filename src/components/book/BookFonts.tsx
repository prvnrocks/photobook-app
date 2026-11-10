// Wrapper for book screens (editor, viewer): declares the M10b font variables for everything
// below it without adding a layout box (display: contents; custom properties still inherit).
// Server component — no client JS.

import { BOOK_FONT_CLASSES } from "./book-fonts";

export function BookFonts({ children }: { children: React.ReactNode }) {
  return (
    <div className={`contents ${BOOK_FONT_CLASSES}`} data-book-fonts="">
      {children}
    </div>
  );
}
