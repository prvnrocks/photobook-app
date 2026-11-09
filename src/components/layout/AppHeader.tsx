// Sticky top bar for signed-in pages: home link, user's display name, settings, sign out.
import { Settings } from "lucide-react";
import Link from "next/link";
import { signOut } from "@/app/auth/actions";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type AppHeaderProps = {
  /** name ?? email of the signed-in user; omitted when unknown. */
  displayName?: string | null;
};

export function AppHeader({ displayName }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-md items-center gap-3 px-4">
        <Link
          href="/dashboard"
          className="flex min-h-11 shrink-0 items-center font-semibold"
        >
          Photobook
        </Link>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {displayName ? (
            <span
              dir="auto"
              className="mr-1 min-w-0 truncate text-sm text-muted-foreground"
              data-testid="header-user"
              title={displayName}
            >
              {displayName}
            </span>
          ) : null}
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className={cn(buttonVariants({ variant: "ghost" }), "size-11 shrink-0 p-0")}
            data-testid="header-settings"
          >
            <Settings className="size-5" aria-hidden="true" />
          </Link>
          <form action={signOut} className="shrink-0">
            <button
              type="submit"
              className={cn(buttonVariants({ variant: "ghost" }), "h-11 px-3")}
              data-testid="sign-out"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
