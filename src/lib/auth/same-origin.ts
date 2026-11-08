// CSRF guard for state-changing API routes (cookie-authenticated POSTs).
// Pure — reads only request headers and NEXT_PUBLIC_APP_URL.

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * CSRF guard: the Origin header must be present and its host must equal the
 * request's Host / X-Forwarded-Host, or the host of NEXT_PUBLIC_APP_URL.
 * Browsers always send Origin on cross-origin and same-origin POST fetches.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = hostOf(request.headers.get("origin"));
  if (!origin) return false;
  const allowed = new Set<string>();
  for (const h of [request.headers.get("host"), request.headers.get("x-forwarded-host")]) {
    if (h) allowed.add(h.split(",")[0].trim().toLowerCase());
  }
  const app = hostOf(process.env.NEXT_PUBLIC_APP_URL?.trim());
  if (app) allowed.add(app);
  return allowed.has(origin);
}
