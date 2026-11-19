// Book screen: declares the book font variables for this dev route only (like /dev-book-page).
import { BookFonts } from "@/components/book/BookFonts";

export default function BookFontsLayout({ children }: { children: React.ReactNode }) {
  return <BookFonts>{children}</BookFonts>;
}
