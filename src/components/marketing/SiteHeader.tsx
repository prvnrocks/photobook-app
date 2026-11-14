// Top bar for public marketing + legal pages (signed-out friendly; no session reads).
// M15 "Confetti": one floating pill (Fishwife-style) with the logo, "How it works" and a "Sign in"
// pill. It takes no height in the flow (negative margin) so the home hero's blush runs behind it;
// pages under this layout start with HEADER_CLEARANCE of top padding.
import { BookOpen } from "lucide-react";
import Link from "next/link";
import { APP_NAME } from "@/lib/brand";
import { CTA_HREF } from "@/lib/marketing/copy";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-[#16121c] focus-visible:ring-offset-2 focus-visible:ring-offset-white";

export function SiteHeader() {
  return (
    <header className="pointer-events-none sticky top-0 z-30 -mb-[4.75rem] h-[4.75rem] px-3 pt-3 sm:px-6">
      <div className="pointer-events-auto mx-auto flex h-14 w-full max-w-[80rem] items-center gap-1 rounded-full bg-white/85 ps-2 pe-1.5 shadow-[0_10px_30px_-14px_rgb(22_18_28/0.35)] ring-1 ring-[#16121c]/10 backdrop-blur-md sm:gap-2">
        <Link
          href="/"
          className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full ps-1 pe-3 font-brand text-[1.35rem] font-extrabold tracking-[-0.03em] text-[#16121c] sm:text-2xl ${FOCUS}`}
        >
          <span aria-hidden="true" className="flex size-9 -rotate-6 items-center justify-center rounded-xl bg-[#d1006a] text-white shadow-[0_3px_0_#16121c]">
            <BookOpen className="size-5 stroke-[2]" />
          </span>
          {APP_NAME}
        </Link>
        <Link
          href="/#how"
          data-testid="header-how"
          className={`ms-auto hidden h-11 items-center rounded-full px-4 text-[0.95rem] font-semibold text-[#16121c] ring-1 ring-[#16121c]/15 transition-colors hover:bg-[#ffd1ea] motion-reduce:transition-none sm:inline-flex ${FOCUS}`}
        >
          How it works
        </Link>
        <Link
          href={CTA_HREF}
          data-testid="header-signin"
          className={`ms-auto inline-flex h-11 items-center rounded-full bg-[#16121c] px-5 text-[0.95rem] font-semibold text-white transition-colors hover:bg-[#3a2d3d] motion-reduce:transition-none sm:ms-0 ${FOCUS}`}
        >
          Sign in
        </Link>
      </div>
    </header>
  );
}
