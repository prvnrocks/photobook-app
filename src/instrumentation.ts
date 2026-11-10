// Next.js instrumentation hook: Sentry init per runtime + server error capture (D-058).
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Errors thrown in server components, route handlers, server actions and middleware. Request
// headers/paths it attaches are scrubbed by beforeSend (src/lib/observability/scrub.ts).
export const onRequestError = Sentry.captureRequestError;
