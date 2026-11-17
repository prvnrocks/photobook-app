// Dev share page (fixture): declares the M10b book font variables (src/components/book/book-fonts.ts) for this
// route only, so the preview's real cover (<BookPage page="cover">) renders in the book's own
// faces — same as the editor and viewer routes. Browsers fetch only the faces the cover uses.
import { BookFonts } from "@/components/book/BookFonts";

export default function BookFontsLayout({ children }: { children: React.ReactNode }) {
  return <BookFonts>{children}</BookFonts>;
}
