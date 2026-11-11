// Top bar for public marketing + legal pages (signed-out friendly; no session reads).
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { CTA_HREF } from "@/lib/marketing/copy";
import { cn } from "@/lib/utils";
import { SiteWordmark } from "./Wordmark";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <div className="mx-auto flex h-14 w-full max-w-wide items-center gap-3 px-gutter sm:px-6">
        <SiteWordmark />
        <Link
          href={CTA_HREF}
          className={cn(buttonVariants({ variant: "outline", size: "touch" }), "ms-auto")}
          data-testid="header-signin"
        >
          Sign in
        </Link>
      </div>
    </header>
  );
}
