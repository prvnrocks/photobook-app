"use client";

// App-level error boundary (M11 T5, D-067): a route threw while rendering. Reports to Sentry
// (scrubbed, no-op without a DSN) and offers a retry. The root layout still renders, so fonts and
// tokens apply; global-error.tsx covers the case where the layout itself fails.
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";
import { StatusScreen } from "@/components/layout/StatusScreen";
import { Button, buttonVariants } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <StatusScreen
      testId="app-error"
      title="Something went wrong"
      description="Sorry, this page didn't load. Your saved work is safe. Please try again."
      action={
        <>
          <Button type="button" size="cta" onClick={() => reset()}>
            Try again
          </Button>
          <Link href="/dashboard" className={buttonVariants({ variant: "ghost", size: "touch" })}>
            Go to my books
          </Link>
        </>
      }
    />
  );
}
