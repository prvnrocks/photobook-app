// Centered card used by the public viewer's non-book states (expired, password, unavailable, 404).
// Full-height column with safe-area padding; fits 375 px. No hooks — usable from server components.

import Link from "next/link";
import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/brand";

export function ViewerMessage({
  title,
  children,
  testId,
}: {
  title: string;
  children?: ReactNode;
  testId: string;
}) {
  return (
    <div
      className="flex min-h-dvh w-full flex-col bg-neutral-100 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
      data-testid={testId}
    >
      <main className="mx-auto flex w-full max-w-sm min-w-0 flex-1 flex-col justify-center px-4 py-10">
        <div className="flex flex-col gap-4 rounded-2xl bg-white p-6 text-center shadow-sm">
          <h1 className="text-xl font-semibold tracking-tight break-words text-neutral-900">{title}</h1>
          {children}
        </div>
      </main>
      <footer className="px-4 pb-4 text-center text-xs text-neutral-500">
        <Link href="/" className="underline-offset-2 hover:underline">
          {APP_NAME}
        </Link>
      </footer>
    </div>
  );
}

/** Primary pill link (create-yours / open-in-editor). */
export const VIEWER_PRIMARY_LINK =
  "inline-flex h-11 w-full items-center justify-center rounded-full bg-neutral-900 px-5 text-base font-medium text-white hover:bg-neutral-800";
export const VIEWER_SECONDARY_LINK =
  "inline-flex h-11 w-full items-center justify-center rounded-full border border-neutral-300 bg-white px-5 text-base font-medium text-neutral-900 hover:bg-neutral-50";
