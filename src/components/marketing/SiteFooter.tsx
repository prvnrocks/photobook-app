// Footer for public marketing + legal pages.
import Link from "next/link";
import { APP_NAME, MADE_IN, SUPPORT_EMAIL } from "@/lib/brand";

const FOOTER_LINK =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring";

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border bg-secondary/60" data-testid="site-footer">
      <div className="mx-auto flex w-full max-w-wide flex-col gap-4 px-gutter py-8 text-sm text-muted-foreground sm:px-6">
        <p className="font-display text-lg font-semibold text-foreground">{APP_NAME}</p>
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
        <p className="flex flex-wrap gap-x-2">
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
