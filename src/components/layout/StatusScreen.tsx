// Full-screen message for app-level not-found and error pages (M11 T5, D-067): wordmark bar,
// shared EmptyState and its actions. No session reads, so it works for signed-out visitors too.
import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/app/EmptyState";
import { APP_NAME } from "@/lib/brand";

export function StatusScreen({
  title,
  description,
  action,
  testId,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-wide items-center px-gutter">
          <Link
            href="/"
            className="-ms-1 flex min-h-11 items-center gap-2 rounded-lg px-1 font-display text-xl font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-accent-strong" />
            {APP_NAME}
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-app flex-1 flex-col justify-center px-gutter py-10">
        <EmptyState title={title} description={description} action={action} data-testid={testId} />
      </main>
    </div>
  );
}
