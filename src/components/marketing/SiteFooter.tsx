// Footer for public marketing + legal pages.
import Link from "next/link";
import { APP_NAME, MADE_IN, SUPPORT_EMAIL } from "@/lib/brand";

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t bg-muted/40" data-testid="site-footer">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:px-6">
        <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-1">
          <Link href="/privacy" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline" data-testid="footer-privacy">
            Privacy
          </Link>
          <Link href="/terms" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline" data-testid="footer-terms">
            Terms
          </Link>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="inline-flex min-h-11 items-center break-all underline-offset-4 hover:underline"
            data-testid="footer-support"
          >
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
