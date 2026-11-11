// App-level 404 (M11 T5, D-067): unknown URLs and notFound() from app routes. Public book links
// keep their own page (src/app/b/[slug]/not-found.tsx).
import type { Metadata } from "next";
import Link from "next/link";
import { StatusScreen } from "@/components/layout/StatusScreen";
import { buttonVariants } from "@/components/ui/button-variants";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

export default function NotFound() {
  return (
    <StatusScreen
      testId="app-not-found"
      title="We couldn't find that page"
      description="The link may be mistyped, or the page has moved. Your books are safe."
      action={
        <>
          <Link href="/dashboard" className={buttonVariants({ size: "cta" })}>
            Go to my books
          </Link>
          <Link href="/" className={buttonVariants({ variant: "ghost", size: "touch" })}>
            Home page
          </Link>
        </>
      }
    />
  );
}
