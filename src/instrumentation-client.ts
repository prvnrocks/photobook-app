// Sentry for the browser (D-058). Next.js loads this file before the app hydrates.
// No NEXT_PUBLIC_SENTRY_DSN → disabled (no-op). No Replay, no tracing, no default PII;
// every event/breadcrumb passes through src/lib/observability/scrub.ts.
import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/observability/sentry-options";

Sentry.init(
  sentryOptions({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV,
  }),
);
