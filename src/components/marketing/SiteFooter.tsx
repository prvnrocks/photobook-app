// Footer for public marketing + legal pages. M15 "Confetti": ink slab with a rounded top, big
// Bricolage wordmark in pop pink (5.08:1 on ink), blush links (13.7:1).
import Link from "next/link";
import { APP_NAME, MADE_IN, SUPPORT_EMAIL } from "@/lib/brand";

const FOOTER_LINK =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-1 text-[#ffd1ea] underline-offset-4 outline-none hover:text-white hover:underline focus-visible:ring-2 focus-visible:ring-[#ffd1ea] focus-visible:ring-offset-2 focus-visible:ring-offset-[#16121c]";

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-auto rounded-t-[2.5rem] bg-[#16121c] text-[#ffd1ea] sm:rounded-t-[4rem]" data-testid="site-footer">
      <div className="mx-auto flex w-full max-w-[80rem] flex-col gap-6 px-gutter pt-12 pb-10 text-[0.95rem] sm:px-6 sm:pt-16">
        <p className="font-brand text-5xl leading-none font-extrabold tracking-[-0.04em] text-[#ff1f84] sm:text-7xl">{APP_NAME}</p>
        <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-1">
          <Link href="/privacy" className={FOOTER_LINK} data-testid="footer-privacy">
            Privacy
          </Link>
          <Link href="/terms" className={FOOTER_LINK} data-testid="footer-terms">
            Terms
          </Link>
          <a href={`mailto:${SUPPORT_EMAIL}`} className={`${FOOTER_LINK} break-all`} data-testid="footer-support">
            {SUPPORT_EMAIL}
          </a>
        </nav>
        <p className="flex flex-wrap gap-x-2 border-t border-white/15 pt-5">
          <span>
            © {year} {APP_NAME}
          </span>
          <span aria-hidden="true">·</span>
          <span>{MADE_IN}</span>
        </p>
      </div>
    </footer>
  );
}
