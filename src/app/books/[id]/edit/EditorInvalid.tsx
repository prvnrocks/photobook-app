// docError 'invalid' screen of the editor (M22 T7, D-074): a cream card on the cream stage with
// emerald actions (no gold — there's nothing to share). Server component, no hooks.
import { BookX } from "lucide-react";
import Link from "next/link";
import { ED_CARD, ED_CTA_EMERALD, ED_CTA_QUIET, ED_PANEL_EYEBROW, ED_PANEL_HEADING, ED_STAGE } from "@/components/editor/editor-classes";
import { cn } from "@/lib/utils";

export function EditorInvalid({ bookId }: { bookId: string }) {
  return (
    <main className={cn(ED_STAGE, "flex min-h-dvh w-full items-center justify-center px-4 py-10")} data-testid="editor-invalid">
      <div className={cn(ED_CARD, "flex w-full max-w-md flex-col gap-4 sm:p-7")}>
        <span className="flex size-11 items-center justify-center rounded-full bg-[#e6efe9] text-[#0e3b2e] ring-1 ring-[#0e3b2e]/10" aria-hidden="true">
          <BookX className="size-5" />
        </span>
        <div className="flex flex-col gap-2">
          <p className={ED_PANEL_EYEBROW}>Editor</p>
          <h1 className={cn(ED_PANEL_HEADING, "text-2xl sm:text-[1.75rem]")}>We can&apos;t open this book</h1>
        </div>
        <p className="text-base text-[#56625a]">
          Something in this book&apos;s data doesn&apos;t look right, so the editor can&apos;t open it safely. Your photos
          are fine. You can go back to your photos and make the book again.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href={`/books/${bookId}/review`} className={cn(ED_CTA_EMERALD, "px-6 text-base")}>
            Back to photos
          </Link>
          <Link href="/dashboard" className={cn(ED_CTA_QUIET, "text-base")}>
            My books
          </Link>
        </div>
      </div>
    </main>
  );
}
