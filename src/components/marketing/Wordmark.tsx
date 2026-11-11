// Serif wordmark for public pages (M11 T6, D-067): Playfair + a terracotta dot, as in the app header.
import Link from "next/link";
import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

export function SiteWordmark({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "-ms-1 flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-1 font-display text-xl font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-accent-strong" />
      {APP_NAME}
    </Link>
  );
}
