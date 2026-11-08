// JSON response helpers for API routes. Every response is `cache-control: no-store`
// (lessons: no-store everywhere) and errors are typed codes, never stack traces.

export const NO_STORE = { "cache-control": "no-store" } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** Safe log code of an unknown error: its `code` (alnum/_/-, ≤32 chars) or "unknown". */
export function errorCodeOf(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
  }
  return "unknown";
}
