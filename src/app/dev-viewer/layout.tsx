// Book screen: declares the M10b book font variables (src/components/book/book-fonts.ts) for this
// route only — fonts load on book screens, not on marketing pages (M10b A3).
import { BookFonts } from "@/components/book/BookFonts";

export default function BookFontsLayout({ children }: { children: React.ReactNode }) {
  return <BookFonts>{children}</BookFonts>;
}
