import "server-only";
// Print readiness for the owner's share page (Task 10): the same check the PDF route runs, on the
// saved doc, shown BEFORE the user taps "Download PDF". The owner is verified by getMyBook (RLS);
// photo sizes come from listPrintPhotoDims (the book's ready photos only). Never throws: a DB error
// or an unreadable doc → null (the page shows no checks; the PDF route still checks on POST).

import { parseBookDoc } from "@/lib/book/schema";
import { getMyBook } from "@/lib/db/books";
import { exportReadiness } from "@/lib/pdf/job";
import { readinessView, type ReadinessView } from "./copy";

export async function getPrintReadinessView(bookId: string): Promise<ReadinessView | null> {
  try {
    const book = await getMyBook(bookId);
    if (!book) return null;
    const parsed = parseBookDoc(book.doc);
    if (!parsed.ok || parsed.doc.pages.length === 0) return null;
    return readinessView(await exportReadiness(bookId, parsed.doc, book));
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) : "unknown";
    console.error(`[print-readiness] failed (${code || "unknown"})`);
    return null;
  }
}
