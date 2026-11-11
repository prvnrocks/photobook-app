// Centered card used by the public viewer's non-book states (expired, password, unavailable, 404).
// M11 T17: the shared app EmptyState on the paper background (serif title, open-book drawing or a
// state icon), with the actions underneath. Full-height column with safe-area padding; fits 375 px.
// No hooks — usable from server components.

import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/ui/button";
import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

export function ViewerMessage({
  title,
  description,
  art,
  children,
  testId,
}: {
  title: string;
  /** One or two lines of help under the title. */
  description?: ReactNode;
  /** Replaces the default open-book drawing (e.g. a lock for the password gate). */
  art?: ReactNode;
  /** Actions / form under the text. */
  children?: ReactNode;
  testId: string;
}) {
  return (
    <div
      className="flex min-h-dvh w-full flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
      data-testid={testId}
    >
      <main className="mx-auto flex w-full max-w-sm min-w-0 flex-1 flex-col justify-center px-gutter py-10">
        <EmptyState title={title} description={description} art={art} action={children} className="break-words" />
      </main>
      <footer className="px-4 pb-4 text-center">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-lg px-3 font-display text-base font-semibold text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {APP_NAME}
        </Link>
      </footer>
    </div>
  );
}

/** Round icon badge used as the EmptyState art for state screens (lock, clock…). */
export function ViewerMessageIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-14 items-center justify-center rounded-full bg-secondary text-primary" aria-hidden="true">
      {children}
    </span>
  );
}

/** Primary call to action (create-yours / open photobook): navy, 48 px, full width. */
export const VIEWER_PRIMARY_LINK = cn(buttonVariants({ size: "cta" }), "rounded-full");
/** Secondary action (open in editor / create your own after an error). */
export const VIEWER_SECONDARY_LINK = cn(buttonVariants({ variant: "outline", size: "cta" }), "rounded-full bg-card");
