// Footer for public marketing + legal pages. M16 "Emerald & gold": ink slab with a gold foil hairline
// on top, the wordmark in gold (7.11:1 on ink), cream links (14.18:1), gold focus ring.
import Link from "next/link";
import { APP_NAME, MADE_IN, SUPPORT_EMAIL } from "@/lib/brand";

const FOOTER_LINK =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-1 text-[#f2e8d8] underline-offset-4 outline-none hover:text-[#e3c766] hover:underline focus-visible:ring-2 focus-visible:ring-[#c9a227] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1b1b1d]";

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="relative mt-auto bg-[#1b1b1d] text-[#f2e8d8]" data-testid="site-footer">
      <span aria-hidden="true" className="home-foil-h absolute inset-x-0 top-0 block h-px" />
      <div className="mx-auto flex w-full max-w-[80rem] flex-col gap-6 px-gutter pt-14 pb-10 text-[0.95rem] sm:px-6 sm:pt-20">
        <p className="font-brand text-5xl leading-none font-light tracking-[-0.03em] text-[#c9a227] sm:text-7xl">{APP_NAME}</p>
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
        <p className="flex flex-wrap gap-x-2 border-t border-[#f2e8d8]/15 pt-5 text-xs tracking-[0.2em] uppercase">
          <span>
            © {year} {APP_NAME}
          </span>
          <span aria-hidden="true" className="text-[#c9a227]">
            ·
          </span>
          <span>{MADE_IN}</span>
        </p>
      </div>
    </footer>
  );
}
