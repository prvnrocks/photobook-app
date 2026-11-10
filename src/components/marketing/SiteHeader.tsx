// Top bar for public marketing + legal pages (signed-out friendly; no session reads).
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { APP_NAME } from "@/lib/brand";
import { CTA_HREF } from "@/lib/marketing/copy";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  return (
    <header className="border-b bg-background/95">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex min-h-11 items-center font-heading text-lg font-semibold">
          {APP_NAME}
        </Link>
        <Link
          href={CTA_HREF}
          className={cn(buttonVariants({ variant: "outline" }), "ml-auto h-11 px-4 text-sm")}
          data-testid="header-signin"
        >
          Sign in
        </Link>
      </div>
    </header>
  );
}
