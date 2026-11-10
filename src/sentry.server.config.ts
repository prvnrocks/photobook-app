// Sentry for the Node.js server runtime (D-058). Loaded by src/instrumentation.ts register().
// No DSN → disabled (no-op). All events/breadcrumbs pass through src/lib/observability/scrub.ts.
import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/observability/sentry-options";

Sentry.init(
  sentryOptions({
    dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.VERCEL_ENV,
  }),
);
