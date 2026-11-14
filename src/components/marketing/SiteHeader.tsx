// Top bar for public marketing + legal pages (signed-out friendly; no session reads).
// M14 mockup: open-book logo + serif name; "How it works" anchor and a "Sign in" pill on the right.
import { BookOpen } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { APP_NAME } from "@/lib/brand";
import { CTA_HREF } from "@/lib/marketing/copy";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-16 w-full max-w-[96rem] items-center gap-2 px-gutter sm:px-6 lg:px-12">
        <Link
          href="/"
          className="-ms-1 flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-1 font-display text-2xl font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:text-[1.75rem]"
        >
          <BookOpen aria-hidden="true" className="size-7 stroke-[1.4] sm:size-8" />
          {APP_NAME}
        </Link>
        <Link
          href="/#how"
          data-testid="header-how"
          className="ms-auto hidden min-h-11 items-center rounded-md px-3 text-[0.95rem] text-foreground outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
        >
          How it works
        </Link>
        <Link
          href={CTA_HREF}
          className={cn(
            buttonVariants({ variant: "outline", size: "touch" }),
            "ms-auto rounded-full border-foreground/70 bg-transparent px-5 text-[0.95rem] sm:ms-2",
          )}
          data-testid="header-signin"
        >
          Sign in
        </Link>
      </div>
    </header>
  );
}
