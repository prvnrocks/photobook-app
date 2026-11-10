// Privacy scrubber for Sentry events (D-058). Pure and isomorphic: used by the browser, Node and
// Edge Sentry configs as beforeSend / beforeSendTransaction / beforeBreadcrumb.
//
// Photo content, captions, titles, book slugs, ids, emails and signed tokens are user data or
// capabilities — none of it may reach Sentry. Rules:
//   - request: keep method + scrubbed url + an allow-list of headers; drop body, cookies, query, env
//   - user: dropped entirely (no id, email or ip)
//   - every string: query strings / fragments stripped from URLs, /b/<slug> -> /b/:slug,
//     emails -> [email], UUIDs -> :id, JWTs and long base64url runs -> [token], then truncated
//   - extra / tags / custom contexts / breadcrumb + span data: keys that look like user text
//     (caption, title, text, doc, prompt, output, name, ...) are dropped, the rest scrubbed
//   - Postgres error text: everything after "Failing row contains", "Key (" or "DETAIL:" is cut
//     (those carry row values — titles, captions, emails — review N1)
//   - console breadcrumb arguments, stack-frame local variables and response contexts are dropped

import type { Breadcrumb, Event, Exception } from "@sentry/nextjs";
import { clipText } from "@/lib/text/clip";

/** Longest string (UTF-16 units) kept in any event field. */
export const MAX_STRING = 500;
/** Deepest nesting walked in extra/contexts/data; anything deeper is dropped. */
const MAX_DEPTH = 6;
/** Request headers that may be sent (lowercase). Everything else — cookies, auth, bypass secrets,
 *  print tokens, forwarded IPs, referers carrying slugs — is dropped. */
export const SAFE_HEADERS = new Set(["user-agent", "content-type", "accept", "content-length"]);

/** Contexts the SDK fills itself (runtime facts, no user data): kept, strings still scrubbed. */
const BUILTIN_CONTEXTS = new Set([
  "os",
  "browser",
  "device",
  "runtime",
  "app",
  "culture",
  "cloud_resource",
  "trace",
  "nextjs",
]);
/** Contexts dropped outright (headers/bodies/local state). */
const DROPPED_CONTEXTS = new Set(["response", "state", "request"]);

/** Key tokens that mark a field as user text or a secret. Keys are split on camelCase, `_`, `-`,
 *  `.` and spaces, so `captionText`, `cover_title`, `user.name` all match while `filename`,
 *  `context` or `statusText`'s sibling `status` do not. */
const SENSITIVE_KEY_TOKENS = new Set([
  "caption",
  "captions",
  "title",
  "titles",
  "subtitle",
  "text",
  "doc",
  "docs",
  "document",
  "prompt",
  "prompts",
  "output",
  "outputs",
  "input",
  "name",
  "names",
  "body",
  "description",
  "descriptions",
  "quote",
  "quotes",
  "note",
  "notes",
  "content",
  "slug",
  "email",
  "password",
  "secret",
  "token",
  "tokens",
  "cookie",
  "cookies",
  "authorization",
  "arguments",
  "vars",
]);

export function isSensitiveKey(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_.\-:/]+/)
    .filter(Boolean);
  return tokens.some((t) => SENSITIVE_KEY_TOKENS.has(t));
}

// --- string rules -------------------------------------------------------------------------------

const ABSOLUTE_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
// `?` or `#` directly after a URL/path character and followed by at least one non-space char.
const RELATIVE_QUERY_RE = /([\w\-./%~@:])[?#][^\s"'<>`)\]]+/g;
const BOOK_SLUG_RE = /\/b\/(?!:slug\b)[^/\s?#"'<>`)\]]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g;
// Signed tokens: `<b64url>.<b64url>` (print tokens, access cookies) or one long base64/base64url
// run with at least one digit. 24+ chars catches HMAC signatures (43 chars) and storage tokens
// while leaving identifiers and chunk hashes (≤ 20 chars) readable.
const DOTTED_TOKEN_RE = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g;
const LONG_TOKEN_RE = /(?<![A-Za-z0-9_+-])(?=[A-Za-z_+-]*\d)[A-Za-z0-9_+-]{24,}={0,2}/g;

/** Postgres error fragments followed by row values; the rest of the string is replaced. */
export const PG_ROW_VALUE_MARKERS = ["Failing row contains", "Key (", "DETAIL:"] as const;
export const PG_REDACTED = "[redacted]";

/** Cut a string right after the first Postgres row-value marker. Idempotent. */
function cutPgRowValues(s: string): string {
  let cut = -1;
  for (const m of PG_ROW_VALUE_MARKERS) {
    const i = s.indexOf(m);
    if (i !== -1 && (cut === -1 || i + m.length < cut)) cut = i + m.length;
  }
  return cut === -1 ? s : `${s.slice(0, cut)} ${PG_REDACTED}`;
}

function stripUrlQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Apply every string rule. Idempotent. */
export function scrubString(input: string, max = MAX_STRING): string {
  let s = cutPgRowValues(input)
    .replace(ABSOLUTE_URL_RE, (u) => stripUrlQuery(u))
    .replace(RELATIVE_QUERY_RE, "$1")
    .replace(BOOK_SLUG_RE, "/b/:slug")
    .replace(EMAIL_RE, "[email]")
    .replace(UUID_RE, ":id")
    .replace(JWT_RE, "[token]")
    .replace(DOTTED_TOKEN_RE, "[token]")
    .replace(LONG_TOKEN_RE, "[token]");
  if (s.length > max) s = clipText(s, max);
  return s;
}

/** Scrub a URL or path: query/fragment removed, then the string rules. */
export function scrubUrl(url: string): string {
  return scrubString(stripUrlQuery(url));
}

// --- object rules -------------------------------------------------------------------------------

/** Recursively scrub a value: strings scrubbed, sensitive keys dropped, depth bounded. */
export function scrubValue(value: unknown, depth = 0, dropSensitiveKeys = true): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  }
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => scrubValue(v, depth + 1, dropSensitiveKeys));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (dropSensitiveKeys && isSensitiveKey(k)) continue;
    const scrubbed = scrubValue(v, depth + 1, dropSensitiveKeys);
    if (scrubbed !== undefined) out[k] = scrubbed;
  }
  return out;
}

function scrubRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = scrubValue(value) as Record<string, unknown>;
  return Object.keys(out).length > 0 ? out : undefined;
}

function scrubHeaders(headers: unknown): Record<string, string> | undefined {
  if (headers === null || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (SAFE_HEADERS.has(k.toLowerCase()) && typeof v === "string") out[k] = scrubString(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function scrubContexts(contexts: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [name, ctx] of Object.entries(contexts)) {
    if (DROPPED_CONTEXTS.has(name) || ctx === null || typeof ctx !== "object") continue;
    // SDK contexts carry fields literally called `name` (os/browser/runtime) — keep those keys.
    const scrubbed = BUILTIN_CONTEXTS.has(name)
      ? scrubValue(ctx, 1, false)
      : isSensitiveKey(name)
        ? undefined
        : scrubValue(ctx, 1, true);
    if (scrubbed && Object.keys(scrubbed as object).length > 0) out[name] = scrubbed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Strip the DOM-attribute part of a Sentry UI selector (`img[alt="…"]` → `img`): alt, title and
 *  aria-label attributes can hold captions. */
function scrubSelector(message: string): string {
  return scrubString(message.replace(/\[[^\]]*\]/g, ""));
}

/** beforeBreadcrumb. Returns a new breadcrumb (never mutates its input). */
export function scrubBreadcrumb(b: Breadcrumb): Breadcrumb {
  const out: Breadcrumb = { ...b };
  const category = b.category ?? "";
  if (typeof b.message === "string") {
    out.message = category.startsWith("ui.") ? scrubSelector(b.message) : scrubString(b.message);
  }
  if (b.data && typeof b.data === "object") {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b.data)) {
      // fetch/xhr/navigation urls: strip query first, then the generic rules.
      if ((k === "url" || k === "from" || k === "to") && typeof v === "string") {
        data[k] = scrubUrl(v);
        continue;
      }
      if (category === "console" && k === "arguments") continue;
      if (isSensitiveKey(k)) continue;
      const scrubbed = scrubValue(v, 1);
      if (scrubbed !== undefined) data[k] = scrubbed;
    }
    out.data = Object.keys(data).length > 0 ? data : undefined;
    if (out.data === undefined) delete out.data;
  }
  return out;
}

type Frame = NonNullable<NonNullable<Exception["stacktrace"]>["frames"]>[number];

function scrubFrames(frames: Frame[] | undefined): Frame[] | undefined {
  return frames?.map((f) => {
    const out: Frame = { ...f };
    delete out.vars;
    if (typeof f.abs_path === "string") out.abs_path = stripUrlQuery(f.abs_path);
    if (typeof f.filename === "string") out.filename = stripUrlQuery(f.filename);
    return out;
  });
}

/** beforeSend / beforeSendTransaction. Returns a new event (never mutates its input). */
export function scrubEvent<E extends Event>(event: E): E {
  const out: E = { ...event };

  delete out.user;
  delete out.extra;
  delete out.contexts;
  delete out.tags;

  if (event.request) {
    const req = event.request;
    out.request = {
      ...(req.method ? { method: req.method } : {}),
      ...(typeof req.url === "string" ? { url: scrubUrl(req.url) } : {}),
      ...(scrubHeaders(req.headers) ? { headers: scrubHeaders(req.headers) } : {}),
    };
  }

  if (typeof event.message === "string") out.message = scrubString(event.message);
  if (event.logentry) {
    out.logentry = {
      ...(typeof event.logentry.message === "string"
        ? { message: scrubString(event.logentry.message) }
        : {}),
    };
  }
  if (typeof event.transaction === "string") out.transaction = scrubUrl(event.transaction);

  if (event.exception?.values) {
    out.exception = {
      ...event.exception,
      values: event.exception.values.map((ex) => ({
        ...ex,
        ...(typeof ex.value === "string" ? { value: scrubString(ex.value) } : {}),
        ...(ex.stacktrace
          ? { stacktrace: { ...ex.stacktrace, frames: scrubFrames(ex.stacktrace.frames) } }
          : {}),
      })),
    };
  }

  if (event.breadcrumbs) out.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);

  const extra = scrubRecord(event.extra);
  if (extra) out.extra = extra;
  const tags = scrubRecord(event.tags);
  if (tags) out.tags = tags as E["tags"];
  const contexts = event.contexts ? scrubContexts(event.contexts as Record<string, unknown>) : undefined;
  if (contexts) out.contexts = contexts as E["contexts"];

  if (event.spans) {
    out.spans = event.spans.map((span) => ({
      ...span,
      ...(typeof span.description === "string" ? { description: scrubUrl(span.description) } : {}),
      ...(span.data ? { data: (scrubValue(span.data) ?? {}) as typeof span.data } : {}),
    }));
  }

  return out;
}
