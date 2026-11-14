// Sticky top bar for signed-in pages (M11 T5, D-067; M17: deep emerald wordmark, gold dot and a gold
// hairline under the bar): serif wordmark (home = dashboard) and one
// account button. The account menu holds the user's name/email, Settings and Sign out, so nothing
// is truncated at 375 px and sign-out is never one stray tap away.
// Testids kept: header-user (name/email), header-settings (Settings link), sign-out (submit).
import { LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { signOut } from "@/app/auth/actions";
import { Skeleton } from "@/components/app/Skeleton";
import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./AccountMenu";

type AppHeaderProps = {
  /** name ?? email of the signed-in user; omitted when unknown. */
  displayName?: string | null;
  /** "library": the books screen's full desktop width (M18), so the wordmark lines up with the grid. */
  width?: HeaderWidth;
};

type HeaderWidth = "wide" | "library";

const INNER: Record<HeaderWidth, string> = {
  wide: "max-w-wide px-gutter",
  library: "max-w-library px-gutter sm:px-6 lg:px-10",
};

const MENU_ITEM =
  "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start text-sm font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring";

function HeaderBar({ children, width = "wide" }: { children?: React.ReactNode; width?: HeaderWidth }) {
  return (
    <header className="sticky top-0 z-30 border-b border-accent-strong/45 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <div className={cn("mx-auto flex h-14 w-full items-center gap-3", INNER[width])}>
        <Wordmark />
        <div className="ms-auto flex min-w-0 items-center">{children}</div>
      </div>
    </header>
  );
}

function Wordmark() {
  return (
    <Link
      href="/dashboard"
      className="-ms-1 flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-1 font-display text-xl font-semibold text-heading outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      data-testid="header-home"
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-accent-strong" />
      {APP_NAME}
    </Link>
  );
}

export function AppHeader({ displayName, width }: AppHeaderProps) {
  return (
    <HeaderBar width={width}>
      <AccountMenu displayName={displayName}>
        {displayName ? (
          <div className="border-b border-border px-3 pt-2 pb-3">
            <p className="text-xs text-muted-foreground">Signed in as</p>
            <p
              dir="auto"
              className="mt-0.5 text-sm font-medium break-all text-foreground"
              data-testid="header-user"
            >
              {displayName}
            </p>
          </div>
        ) : null}
        <nav aria-label="Account" className={cn("flex flex-col", displayName && "pt-2")}>
          <Link href="/settings" className={MENU_ITEM} data-testid="header-settings">
            <Settings className="size-4 text-muted-foreground" aria-hidden="true" />
            Settings
          </Link>
          <form action={signOut}>
            <button type="submit" className={MENU_ITEM} data-testid="sign-out">
              <LogOut className="size-4 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
              Sign out
            </button>
          </form>
        </nav>
      </AccountMenu>
    </HeaderBar>
  );
}

/** Header shown by route loading.tsx files: same bar, a placeholder where the account button sits. */
export function AppHeaderPlaceholder({ width }: { width?: HeaderWidth } = {}) {
  return (
    <HeaderBar width={width}>
      <Skeleton className="size-9 rounded-full" />
    </HeaderBar>
  );
}
