// Shared Sentry.init options for the browser, Node and Edge configs (D-058). Pure: the DSN and
// environment are passed in by the config files (the only places that read SENTRY_* env vars).
//
// Sampling: tracing is OFF (no tracesSampleRate, no profiling, no Replay). Reasons:
//   - privacy: spans carry URLs / DB request descriptions for every request — the smallest
//     surface is not sending them at all; errors are what we need at launch;
//   - free tier: the error quota is the one that matters, and transactions would add volume and
//     per-request overhead (OpenTelemetry instrumentation only runs when tracing is enabled);
//   - tracePropagationTargets: [] keeps sentry-trace/baggage headers off requests to Supabase,
//     Stripe, Anthropic and Mapbox.
// beforeSendTransaction still scrubs, in case tracing is turned on later.

import { scrubBreadcrumb, scrubEvent } from "@/lib/observability/scrub";

export interface SentryEnv {
  dsn: string | undefined;
  /** VERCEL_ENV / NEXT_PUBLIC_VERCEL_ENV ("production" | "preview" | "development") or undefined. */
  environment: string | undefined;
}

export function sentryOptions({ dsn, environment }: SentryEnv) {
  const cleanDsn = dsn?.trim() || undefined;
  return {
    dsn: cleanDsn,
    // No DSN → SDK stays a no-op (local dev, CI, forks).
    enabled: Boolean(cleanDsn),
    environment: environment || "development",
    sendDefaultPii: false,
    tracePropagationTargets: [] as string[],
    maxBreadcrumbs: 30,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
