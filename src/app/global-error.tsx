"use client";

// Last-resort error boundary (replaces the root layout when it throws). Reports to Sentry
// (scrubbed, no-op without a DSN) and shows a minimal page that works at 375 px.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="antialiased">
        <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-neutral-600">
            Sorry, this page failed to load. Your photos and books are safe.
          </p>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={() => reset()}
              className="min-h-11 rounded-md bg-neutral-900 px-4 text-sm font-medium text-white"
            >
              Try again
            </button>
            {/* Full reload on purpose: the root layout itself failed, so client navigation can't be trusted. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              className="flex min-h-11 items-center justify-center rounded-md border border-neutral-300 px-4 text-sm font-medium"
            >
              Go home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
