// Deadline fetch for every Supabase client (M12, D-069). Isomorphic: used by the browser
// client, the server/admin clients and the Edge middleware, so no "server-only", no node:
// imports and no AbortSignal.any / AbortSignal.timeout — iOS 16 Safari and the Edge runtime
// cannot be relied on to have them (manual AbortController + setTimeout instead).
//
// Each request is classed by URL + method and gets a time budget. On timeout the wrapper
// answers a synthetic 504 JSON body instead of throwing, so each library reports it on its
// normal error path:
//   - postgrest-js: `error.code === "SUPABASE_TIMEOUT"` (504 is not in its retry list)
//   - storage-js:   `StorageApiError.statusCode === "SUPABASE_TIMEOUT"` (status 504)
//   - auth-js:      `AuthRetryableFetchError` (status 504, message contains SUPABASE_TIMEOUT)
// A caller's own abort signal still wins: its abort is rethrown as-is, never turned into a
// timeout.
//
// Retries: the clients are created with `db: { retry: false }` (see deadlineClientOptions),
// so postgrest's own GET retry loop (3 retries, 1/2/4 s) never multiplies with ours. Instead
// this wrapper retries rest GET/HEAD exactly once on timeout, network error or 503/520.
// Worst case per postgrest read: 2 x budget + RETRY_DELAY_MS (server 20.5 s, browser 40.5 s).

export const SUPABASE_TIMEOUT = "SUPABASE_TIMEOUT";

export type DeadlineProfile = "server" | "browser";

export type RequestClass =
  | "auth"
  | "rest"
  | "rpc"
  | "rpc-long"
  | "storage-json"
  | "storage-upload"
  | "storage-download"
  | "other";

export type DeadlineBudgets = {
  authMs: number;
  restMs: number;
  rpcMs: number;
  /** cleanup_*, delete_book_guarded, reap_stale_agent_runs, admin_ai_spend_daily */
  rpcLongMs: number;
  storageJsonMs: number;
  uploadBaseMs: number;
  /** Assumed slowest acceptable upload rate; budget = base + bytes / rate. */
  uploadBytesPerSec: number;
  uploadMaxMs: number;
  downloadMs: number;
  /** Anything else under the Supabase URL (functions, unknown paths). */
  otherMs: number;
};

const MB = 1024 * 1024;

export const DEADLINE_BUDGETS: Readonly<Record<DeadlineProfile, Readonly<DeadlineBudgets>>> = {
  server: {
    authMs: 8_000,
    restMs: 10_000,
    rpcMs: 15_000,
    rpcLongMs: 60_000,
    storageJsonMs: 15_000,
    uploadBaseMs: 30_000,
    uploadBytesPerSec: MB, // 1 MB/s → a 50 MB PDF gets 80 s
    uploadMaxMs: 120_000,
    downloadMs: 60_000,
    otherMs: 15_000,
  },
  browser: {
    authMs: 20_000,
    restMs: 20_000,
    rpcMs: 20_000,
    rpcLongMs: 20_000,
    storageJsonMs: 20_000,
    uploadBaseMs: 30_000,
    uploadBytesPerSec: 16 * 1024, // 16 KB/s, deliberately generous for slow phone networks
    uploadMaxMs: 600_000,
    downloadMs: 60_000,
    otherMs: 20_000,
  },
};

/** Middleware runs on every matched request: auth gets a tighter budget there. */
export const MIDDLEWARE_AUTH_MS = 5_000;

/** Pause before the single rest GET/HEAD retry. */
export const RETRY_DELAY_MS = 500;

const LONG_RPCS = new Set(["delete_book_guarded", "reap_stale_agent_runs", "admin_ai_spend_daily"]);
const RETRYABLE_STATUS = new Set([503, 520]);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** Thrown (or used as a stream error) when Supabase did not answer in time. */
export class SupabaseUnavailableError extends Error {
  readonly code = SUPABASE_TIMEOUT;
  constructor(message = "Supabase did not respond in time (SUPABASE_TIMEOUT)") {
    super(message);
    this.name = "SupabaseUnavailableError";
  }
}

/**
 * True for every shape a deadline timeout takes after a Supabase library handled it:
 * postgrest error objects / PostgrestError (`code`), StorageApiError (`statusCode`),
 * auth-js AuthRetryableFetchError (504 + message), SupabaseUnavailableError, and app
 * errors that copied the code (`XQueryError(op, error.code)`). Follows `cause` /
 * `originalError` one level deep (StorageUnknownError wraps stream errors).
 */
export function isSupabaseTimeout(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 2) return false;
  const e = err as Record<string, unknown>;
  if (e.code === SUPABASE_TIMEOUT || e.statusCode === SUPABASE_TIMEOUT) return true;
  if (
    e.name === "AuthRetryableFetchError" &&
    e.status === 504 &&
    typeof e.message === "string" &&
    e.message.includes(SUPABASE_TIMEOUT)
  ) {
    return true;
  }
  return isSupabaseTimeout(e.cause, depth + 1) || isSupabaseTimeout(e.originalError, depth + 1);
}

/** Class a Supabase request by URL path and method. Exported for tests. */
export function classifySupabaseRequest(url: string, method: string): { cls: RequestClass; rpc?: string } {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return { cls: "other" };
  }
  const m = method.toUpperCase();

  if (/\/auth\/v1(\/|$)/.test(path)) return { cls: "auth" };

  const rpc = /\/rest\/v1\/rpc\/([^/?#]+)/.exec(path);
  if (rpc) {
    const name = decodeURIComponent(rpc[1]);
    return { cls: name.startsWith("cleanup_") || LONG_RPCS.has(name) ? "rpc-long" : "rpc", rpc: name };
  }
  if (/\/rest\/v1(\/|$)/.test(path)) return { cls: "rest" };

  const storage = /\/storage\/v1(\/.*)?$/.exec(path);
  if (storage) {
    const rest = storage[1] ?? "/";
    // uploadToSignedUrl: PUT /object/upload/sign/{bucket}/{path}?token=…
    if (m === "PUT" && rest.startsWith("/object/upload/sign/")) return { cls: "storage-upload" };
    if (/^\/object\/(sign|upload\/sign|list|list-v2|info)(\/|$)/.test(rest) || /^\/object\/(move|copy)$/.test(rest)) {
      return { cls: "storage-json" };
    }
    if (rest.startsWith("/object/") || rest.startsWith("/render/image/")) {
      if (m === "POST" || m === "PUT") return { cls: "storage-upload" };
      if (m === "GET") return { cls: "storage-download" };
      return { cls: "storage-json" }; // HEAD (exists), DELETE (remove)
    }
    return { cls: "storage-json" }; // bucket API etc.
  }
  return { cls: "other" };
}

/**
 * Upload body size in bytes WITHOUT reading or cloning the body. Returns null for streams
 * and unknown bodies (they get the maximum upload budget). FormData is measured from its
 * entries (Blob.size / string length), which does not read file contents — storage-js
 * wraps every Blob upload in FormData.
 */
export function measureBodyBytes(body: unknown): number | null {
  if (body == null) return 0;
  if (typeof body === "string") return body.length * 3; // UTF-8 upper bound, no encoding pass
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString().length;
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    let total = 0;
    let unknown = false;
    body.forEach((value) => {
      if (typeof value === "string") total += value.length * 3;
      else if (typeof Blob !== "undefined" && value instanceof Blob) total += value.size;
      else unknown = true;
    });
    return unknown ? null : total + 1024; // + multipart framing
  }
  return null;
}

export function uploadBudgetMs(b: DeadlineBudgets, bytes: number | null): number {
  if (bytes === null) return b.uploadMaxMs;
  return Math.min(b.uploadMaxMs, b.uploadBaseMs + Math.ceil((bytes / b.uploadBytesPerSec) * 1000));
}

function budgetFor(b: DeadlineBudgets, cls: RequestClass, body: unknown): number {
  switch (cls) {
    case "auth":
      return b.authMs;
    case "rest":
      return b.restMs;
    case "rpc":
      return b.rpcMs;
    case "rpc-long":
      return b.rpcLongMs;
    case "storage-json":
      return b.storageJsonMs;
    case "storage-upload":
      return uploadBudgetMs(b, measureBodyBytes(body));
    case "storage-download":
      return b.downloadMs;
    default:
      return b.otherMs;
  }
}

/** The synthetic 504 a timed-out request answers (exported for the middleware's auth gate). */
export function supabaseTimeoutResponse(cls: RequestClass, ms: number): Response {
  return timeoutResponse(cls, ms);
}

function timeoutResponse(cls: RequestClass, ms: number): Response {
  const message = `Supabase ${cls} request timed out after ${ms} ms (${SUPABASE_TIMEOUT})`;
  return new Response(
    JSON.stringify({ code: SUPABASE_TIMEOUT, statusCode: SUPABASE_TIMEOUT, error: "timeout", message }),
    {
      status: 504,
      statusText: "Gateway Timeout",
      headers: { "content-type": "application/json", "x-supabase-timeout": cls },
    },
  );
}

function abortErrorFor(signal: AbortSignal | undefined): unknown {
  const reason = signal?.reason;
  if (reason instanceof Error || (typeof DOMException !== "undefined" && reason instanceof DOMException)) return reason;
  if (typeof DOMException !== "undefined") return new DOMException("This operation was aborted", "AbortError");
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

const TIMED_OUT = Symbol("timed-out");
const ABORTED = Symbol("aborted");

type Attempt = {
  url: RequestInfo | URL;
  init: RequestInit | undefined;
  callerSignal: AbortSignal | undefined;
  budgetMs: number;
  /** buffer: read the whole body inside the deadline; stream: pass the signal through the body. */
  mode: "buffer" | "stream";
};

/** One fetch under a deadline. Resolves to a Response or TIMED_OUT; throws caller aborts and network errors. */
async function attemptOnce(a: Attempt): Promise<Response | typeof TIMED_OUT> {
  const fetchImpl = globalThis.fetch; // read at call time (tests stub it)
  if (a.callerSignal?.aborted) throw abortErrorFor(a.callerSignal);

  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  aborted.catch(() => {});

  const onCallerAbort = () => {
    controller.abort();
    rejectAbort(ABORTED);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectAbort(ABORTED);
  }, a.budgetMs);
  a.callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    a.callerSignal?.removeEventListener("abort", onCallerAbort);
  };
  const callerAborted = () => a.callerSignal?.aborted === true;
  // Our own deadline fired and the caller did not cancel.
  const isOurTimeout = () => timedOut && !callerAborted();

  let res: Response;
  try {
    res = await Promise.race([fetchImpl(a.url, { ...a.init, signal: controller.signal }), aborted]);
  } catch (err) {
    cleanup();
    if (callerAborted()) throw abortErrorFor(a.callerSignal);
    if (isOurTimeout()) return TIMED_OUT;
    throw err;
  }

  if (a.mode === "buffer") {
    let buf: ArrayBuffer;
    try {
      buf = await Promise.race([res.arrayBuffer(), aborted]);
    } catch (err) {
      cleanup();
      res.body?.cancel().catch(() => {});
      if (callerAborted()) throw abortErrorFor(a.callerSignal);
      if (isOurTimeout()) return TIMED_OUT;
      throw err;
    }
    cleanup();
    const headers = new Headers(res.headers);
    headers.delete("content-encoding"); // body is already decoded
    headers.delete("content-length");
    return new Response(NULL_BODY_STATUS.has(res.status) ? null : buf, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  // stream mode (downloads): keep the deadline armed until the body ends.
  if (!res.body) {
    cleanup();
    return res;
  }
  const reader = res.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done: end, value } = await Promise.race([reader.read(), aborted]);
        if (end) {
          cleanup();
          ctrl.close();
        } else {
          ctrl.enqueue(value);
        }
      } catch (err) {
        cleanup();
        reader.cancel().catch(() => {});
        if (callerAborted()) ctrl.error(abortErrorFor(a.callerSignal));
        else if (isOurTimeout()) ctrl.error(new SupabaseUnavailableError(`Supabase download body stalled past ${a.budgetMs} ms (${SUPABASE_TIMEOUT})`));
        else ctrl.error(err);
      }
    },
    cancel(reason) {
      cleanup();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortErrorFor(signal));
    const onAbort = () => {
      clearTimeout(t);
      reject(abortErrorFor(signal));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requestParts(input: RequestInfo | URL, init: RequestInit | undefined) {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const method = (init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
  const signal = init?.signal ?? (isRequest ? (input as Request).signal : undefined) ?? undefined;
  const headers = new Headers(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
  return { url, method, signal, headers };
}

export type DeadlineOverrides = Partial<DeadlineBudgets>;

export function createDeadlineFetch(profile: DeadlineProfile, overrides: DeadlineOverrides = {}): typeof fetch {
  const budgets: DeadlineBudgets = { ...DEADLINE_BUDGETS[profile], ...overrides };

  return async function deadlineFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { url, method, signal, headers } = requestParts(input, init);
    const { cls } = classifySupabaseRequest(url, method);
    const budgetMs = budgetFor(budgets, cls, init?.body);
    const mode = cls === "storage-download" ? "stream" : "buffer";
    // Belt and braces: never retry a request postgrest is already retrying.
    const retryable = cls === "rest" && (method === "GET" || method === "HEAD") && !headers.has("x-retry-count");
    const attempts = retryable ? 2 : 1;

    for (let i = 0; i < attempts; i++) {
      const last = i === attempts - 1;
      if (i > 0) await sleep(RETRY_DELAY_MS, signal);
      let outcome: Response | typeof TIMED_OUT;
      try {
        outcome = await attemptOnce({ url: input, init, callerSignal: signal, budgetMs, mode });
      } catch (err) {
        if (signal?.aborted || last) throw err;
        continue; // network error on a retryable read
      }
      if (outcome === TIMED_OUT) {
        if (last) return timeoutResponse(cls, budgetMs);
        continue;
      }
      if (!last && RETRYABLE_STATUS.has(outcome.status)) continue;
      return outcome;
    }
    /* c8 ignore next */
    return timeoutResponse(cls, budgetMs);
  } as typeof fetch;
}

/**
 * Options every Supabase client gets: the deadline fetch, and postgrest's own retry loop
 * off so retries never multiply (this wrapper owns the single rest GET/HEAD retry).
 */
export function deadlineClientOptions(profile: DeadlineProfile, overrides?: DeadlineOverrides) {
  return {
    global: { fetch: createDeadlineFetch(profile, overrides) },
    db: { retry: false },
  } as const;
}
