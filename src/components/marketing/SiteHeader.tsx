// Top bar for public marketing + legal pages (signed-out friendly; no session reads).
// One floating pill (M15 structure) in M16 "Emerald & gold": deep emerald glass with a gold hairline,
// cream wordmark, gold-framed logo mark, cream ghost buttons. It takes no height in the flow (negative
// margin) so the home hero's leather runs behind it; pages under this layout start with top padding.
import { BookOpen } from "lucide-react";
import Link from "next/link";
import { APP_NAME } from "@/lib/brand";
import { CTA_HREF } from "@/lib/marketing/copy";

// gold ring on the deep emerald pill: 5.16:1
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-[#c9a227] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e3b2e]";

export function SiteHeader() {
  return (
    <header className="pointer-events-none sticky top-0 z-30 -mb-[4.75rem] h-[4.75rem] px-3 pt-3 sm:px-6">
      <div className="pointer-events-auto mx-auto flex h-14 w-full max-w-[80rem] items-center gap-1 rounded-full bg-[#0e3b2e]/90 ps-2 pe-1.5 shadow-[0_14px_30px_-16px_rgb(0_0_0/0.6)] ring-1 ring-[#c9a227]/45 backdrop-blur-md sm:gap-2">
        <Link
          href="/"
          className={`flex min-h-11 shrink-0 items-center gap-2.5 rounded-full ps-1 pe-3 font-brand text-[1.3rem] font-normal tracking-[-0.01em] text-[#f2e8d8] sm:text-[1.45rem] ${FOCUS}`}
        >
          <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-full text-[#e3c766] ring-1 ring-[#c9a227]/80">
            <BookOpen className="size-[1.1rem] stroke-[1.5]" />
          </span>
          {APP_NAME}
        </Link>
        <Link
          href="/#how"
          data-testid="header-how"
          className={`ms-auto hidden h-11 items-center rounded-full px-4 text-[0.8rem] font-medium tracking-[0.14em] text-[#f2e8d8] uppercase transition-colors hover:bg-[#1f6f54] motion-reduce:transition-none sm:inline-flex ${FOCUS}`}
        >
          How it works
        </Link>
        <Link
          href={CTA_HREF}
          data-testid="header-signin"
          className={`ms-auto inline-flex h-11 items-center rounded-full px-5 text-[0.8rem] font-medium tracking-[0.14em] text-[#f2e8d8] uppercase ring-1 ring-[#c9a227]/70 transition-colors hover:bg-[#1f6f54] motion-reduce:transition-none sm:ms-0 ${FOCUS}`}
        >
          Sign in
        </Link>
      </div>
    </header>
  );
}
