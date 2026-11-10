// "Download PDF" flow (M8 T8, D-051). Pure + client-safe: no DOM types beyond what callers inject,
// no server imports — the component only renders `PdfUiState` and calls start()/dispose().
//
// API contract (src/app/api/books/[id]/pdf, T7):
//   POST /api/books/{id}/pdf → 200 {status:'ready', exportId, url, filename, bytes, pageCount}
//                            | 202 {status:'queued'|'rendering', exportId}
//                            | {error} with 401/402/403/404/409/429/503/500
//   GET  /api/books/{id}/pdf/status?exportId=… (lightweight, M8 review S3)
//        → {status:'queued'|'rendering'} | {status:'ready', …} | {status:'failed', error}
//
// Flow: start → POST; 202 → poll the status route every 2 s. The status route never re-kicks:
// when a job stays 'queued' for PDF_REKICK_QUEUED_MS the controller re-POSTs (POST joins the job
// and schedules it again; at most PDF_REKICK_MAX times), and a 'failed' answer with error
// 'superseded' / 'missing_file' (a newer PDF replaced this one / the file is gone) re-POSTs once.
// Otherwise: (paused while the tab is hidden; after ~5 min of
// still-pending answers → 'timeout'); ready → navigate(url) once (location.assign — iOS-safe) and
// keep a "Download again" link until the signed URL is about to expire, then back to idle.

/** = rules.SIGNED_URL_TTL_SECONDS (not imported: rules.ts pulls the book schema into the client
 * bundle; tests/pdf-ui.test.ts asserts they match). */
export const PDF_SIGNED_URL_TTL_SECONDS = 600;

export const PDF_POLL_MS = 2_000;
/** Total time the client keeps polling one export before showing 'timeout'. */
export const PDF_POLL_CAP_MS = 5 * 60_000;
/** Consecutive failed polls (network / 5xx) tolerated before giving up. */
export const PDF_POLL_MAX_FAILURES = 3;
/** A job still 'queued' this long after it was first seen queued is re-POSTed (its kick died). */
export const PDF_REKICK_QUEUED_MS = 20_000;
/** Re-POSTs per run (queued re-kicks + one superseded/missing_file retry share the budget). */
export const PDF_REKICK_MAX = 3;
/** Failed codes meaning "this export's PDF is gone, ask POST for the current one". */
export const PDF_REPOST_ERRORS: readonly string[] = ["superseded", "missing_file"];
/** The signed URL lives PDF_SIGNED_URL_TTL_SECONDS; hide "Download again" a little before that. */
export const PDF_LINK_VALID_MS = (PDF_SIGNED_URL_TTL_SECONDS - 30) * 1_000;

export const PDF_BUTTON_LABEL = "Download PDF";
export const PDF_PREPARING_COPY = "Preparing your PDF… this can take up to a minute";
export const PDF_READY_COPY = "Your PDF is ready";
export const PDF_DOWNLOAD_AGAIN_LABEL = "Download again";
export const PDF_TIMEOUT_COPY = "Still working — check back in a minute";
export const PDF_FREE_COPY = "PDF download comes with the upgrade";

/** Error codes the UI distinguishes (API error codes + client-side ones). */
export type PdfErrorCode =
  | "unauthenticated"
  | "not_paid"
  | "forbidden"
  | "not_found"
  | "invalid_doc"
  | "empty"
  | "page_limit"
  | "daily_cap"
  | "unavailable"
  | "server_error"
  /** 409 {error:'conflict'}: the doc was saved twice mid-request (auto-retried once). */
  | "conflict"
  /** The export job failed (GET {status:'failed'}); `detail` holds the server's code. */
  | "failed"
  /** fetch threw (offline, DNS…). */
  | "network";

export interface PdfReadyInfo {
  exportId: string;
  url: string;
  filename: string;
  bytes: number;
  pageCount: number;
}

export type PdfUiState =
  | { kind: "idle" }
  /** POST in flight. */
  | { kind: "starting" }
  | { kind: "preparing"; exportId: string; status: "queued" | "rendering"; paused: boolean }
  | ({ kind: "ready" } & PdfReadyInfo)
  | { kind: "timeout"; exportId: string }
  | { kind: "error"; code: PdfErrorCode; detail?: string };

export type PdfUiKind = PdfUiState["kind"];

export function isPdfBusy(s: PdfUiState): boolean {
  return s.kind === "starting" || s.kind === "preparing";
}

export function pdfErrorCopy(code: PdfErrorCode): string {
  switch (code) {
    case "not_paid":
      return PDF_FREE_COPY;
    case "daily_cap":
      return "You've made a lot of PDFs today — try again tomorrow";
    case "invalid_doc":
    case "empty":
      return "Fix the book before exporting";
    case "page_limit":
      return "This book has more pages than allowed";
    case "unavailable":
      return "PDF export isn't available right now";
    case "unauthenticated":
      return "Please sign in again";
    case "forbidden":
    case "not_found":
      return "We couldn't find this book";
    case "network":
      return "Couldn't reach the server — check your connection and try again";
    case "failed":
    case "conflict":
    case "server_error":
    default:
      return "We couldn't make your PDF — try again";
  }
}

/** "2.4 MB" (one decimal, at least 0.1). */
export function formatPdfSize(bytes: number): string {
  const mb = Math.max(0.1, Math.round((Number.isFinite(bytes) ? bytes : 0) / 104_857.6) / 10);
  return `${mb.toFixed(1)} MB`;
}

/** "2.4 MB · 41 pages" — the PDF's page count (cover included). */
export function pdfReadyDetail(info: Pick<PdfReadyInfo, "bytes" | "pageCount">): string {
  const n = Math.max(0, Math.floor(info.pageCount));
  return `${formatPdfSize(info.bytes)} · ${n} ${n === 1 ? "page" : "pages"}`;
}

/** Status line for every state (null = nothing to say). */
export function pdfStatusCopy(s: PdfUiState): string | null {
  switch (s.kind) {
    case "idle":
      return null;
    case "starting":
    case "preparing":
      return PDF_PREPARING_COPY;
    case "ready":
      return PDF_READY_COPY;
    case "timeout":
      return PDF_TIMEOUT_COPY;
    case "error":
      return pdfErrorCopy(s.code);
  }
}

/** Main button label per state. */
export function pdfButtonLabel(s: PdfUiState): string {
  if (s.kind === "timeout") return "Check again";
  if (s.kind === "error" && s.code !== "not_paid") return "Try again";
  return PDF_BUTTON_LABEL;
}

// ---------------------------------------------------------------------------------------------
// Transport

export type PdfHttpResult = { status: number; body: unknown };
export type PdfTransport = (method: "POST" | "GET", url: string) => Promise<PdfHttpResult>;

/** Same-origin fetch with cookies; a non-JSON body becomes null. Throws only on network errors. */
export const fetchPdfTransport: PdfTransport = async (method, url) => {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

/** Lightweight poll route (no renderer in its function). */
export function pdfStatusPath(bookId: string, exportId: string): string {
  return `/api/books/${encodeURIComponent(bookId)}/pdf/status?exportId=${encodeURIComponent(exportId)}`;
}

export function pdfApiPath(bookId: string, exportId?: string): string {
  const base = `/api/books/${encodeURIComponent(bookId)}/pdf`;
  return exportId ? `${base}?exportId=${encodeURIComponent(exportId)}` : base;
}

// ---------------------------------------------------------------------------------------------
// Response parsing

const API_ERRORS: readonly PdfErrorCode[] = [
  "unauthenticated",
  "not_paid",
  "forbidden",
  "not_found",
  "invalid_doc",
  "empty",
  "page_limit",
  "daily_cap",
  "unavailable",
  "server_error",
  "conflict",
];

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Supabase origin from the public env (inlined into the client bundle); null if unset/invalid. */
export function supabaseStorageOrigin(raw: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * The download URL the client navigates to. Accepted: a same-origin path (`/x`, not `//x` or
 * `/\x`), an absolute URL on this page's origin, or a Supabase Storage URL
 * (`/storage/v1/…`) on the configured Supabase origin over https (http only when that origin
 * is a local loopback Supabase). No credentials in the URL. Everything else is refused.
 */
export function isSafeDownloadUrl(
  url: unknown,
  opts: { storageOrigin?: string | null; pageOrigin?: string | null } = {},
): url is string {
  if (typeof url !== "string" || url.length === 0 || /\s/.test(url)) return false;
  if (url.startsWith("/")) return !url.startsWith("//") && !url.startsWith("/\\");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const pageOrigin = opts.pageOrigin !== undefined ? opts.pageOrigin : typeof window !== "undefined" ? window.location.origin : null;
  if (pageOrigin && u.origin === pageOrigin && (u.protocol === "https:" || u.protocol === "http:")) return true;
  const storage = opts.storageOrigin !== undefined ? opts.storageOrigin : supabaseStorageOrigin();
  if (!storage || u.origin !== storage || !u.pathname.startsWith("/storage/v1/")) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname));
}

export function parseReady(body: unknown): PdfReadyInfo | null {
  const b = obj(body);
  if (!b || b.status !== "ready" || typeof b.exportId !== "string" || !isSafeDownloadUrl(b.url)) return null;
  return {
    exportId: b.exportId,
    url: b.url,
    filename: typeof b.filename === "string" ? b.filename : "photobook.pdf",
    bytes: typeof b.bytes === "number" ? b.bytes : 0,
    pageCount: typeof b.pageCount === "number" ? b.pageCount : 0,
  };
}

function pendingStatus(body: unknown): "queued" | "rendering" | null {
  const s = obj(body)?.status;
  return s === "queued" || s === "rendering" ? s : null;
}

/** Error code for a non-success answer: the body's `error` if known, else by HTTP status. */
export function errorCodeFor(status: number, body: unknown): PdfErrorCode {
  const e = obj(body)?.error;
  if (typeof e === "string" && (API_ERRORS as readonly string[]).includes(e)) return e as PdfErrorCode;
  switch (status) {
    case 401:
      return "unauthenticated";
    case 402:
      return "not_paid";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "invalid_doc";
    case 429:
      return "daily_cap";
    case 503:
      return "unavailable";
    default:
      return "server_error";
  }
}

// ---------------------------------------------------------------------------------------------
// Controller

export interface PdfControllerDeps {
  bookId: string;
  onChange: (s: PdfUiState) => void;
  transport?: PdfTransport;
  /** Default: window.location.assign (same tab — works on iOS Safari, unlike window.open after await). */
  navigate?: (url: string) => void;
  /** Awaited before the POST (editor: send pending saves so the PDF has the latest edits). */
  beforeStart?: () => unknown;
  now?: () => number;
  /** Default: document.visibilityState === "hidden" (false without a document). */
  isHidden?: () => boolean;
  /** Subscribe to "tab became visible"; returns the unsubscribe. Default: visibilitychange. */
  onVisible?: (cb: () => void) => () => void;
}

export interface PdfController {
  getState(): PdfUiState;
  /** Starts (or re-checks) an export. No-op while one is starting/preparing. */
  start(): Promise<void>;
  /** Stops timers + listeners; late answers are ignored. */
  dispose(): void;
}

function defaultIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function defaultOnVisible(cb: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const h = () => {
    if (document.visibilityState === "visible") cb();
  };
  document.addEventListener("visibilitychange", h);
  return () => document.removeEventListener("visibilitychange", h);
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

export function createPdfDownloadController(deps: PdfControllerDeps): PdfController {
  const transport = deps.transport ?? fetchPdfTransport;
  const navigate = deps.navigate ?? defaultNavigate;
  const now = deps.now ?? Date.now;
  const isHidden = deps.isHidden ?? defaultIsHidden;
  const onVisible = deps.onVisible ?? defaultOnVisible;

  let state: PdfUiState = { kind: "idle" };
  let disposed = false;
  /** Bumped on every new run / dispose: answers from an older run are dropped. */
  let gen = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeVisible: (() => void) | null = null;
  let deadline = 0;
  let failures = 0;
  /** When the current export was first seen 'queued' (null = not queued). */
  let queuedSince: number | null = null;
  let reposts = 0;

  const set = (s: PdfUiState) => {
    if (disposed) return;
    state = s;
    deps.onChange(s);
  };

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const stopVisible = () => {
    unsubscribeVisible?.();
    unsubscribeVisible = null;
  };

  const ready = (info: PdfReadyInfo, g: number) => {
    clearTimer();
    stopVisible();
    set({ kind: "ready", ...info });
    navigate(info.url);
    // The signed URL expires: drop the "Download again" link before it does.
    timer = setTimeout(() => {
      timer = null;
      if (g === gen && state.kind === "ready") set({ kind: "idle" });
    }, PDF_LINK_VALID_MS);
  };

  const fail = (code: PdfErrorCode, detail?: string) => {
    clearTimer();
    stopVisible();
    set(detail ? { kind: "error", code, detail } : { kind: "error", code });
  };

  const schedulePoll = (exportId: string, g: number) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void poll(exportId, g);
    }, PDF_POLL_MS);
  };

  const poll = async (exportId: string, g: number): Promise<void> => {
    if (disposed || g !== gen) return;
    if (isHidden()) {
      // Paused: resume with an immediate poll once the tab is visible again.
      if (state.kind === "preparing" && !state.paused) set({ ...state, paused: true });
      stopVisible();
      unsubscribeVisible = onVisible(() => {
        stopVisible();
        if (g !== gen || disposed) return;
        if (state.kind === "preparing") set({ ...state, paused: false });
        void poll(exportId, g);
      });
      return;
    }
    let r: PdfHttpResult | null;
    try {
      r = await transport("GET", pdfStatusPath(deps.bookId, exportId));
    } catch {
      r = null;
    }
    if (disposed || g !== gen) return;

    if (r && r.status >= 200 && r.status < 300) {
      failures = 0;
      const info = parseReady(r.body);
      if (info) return ready(info, g);
      const b = obj(r.body);
      if (b?.status === "failed") {
        const code = typeof b.error === "string" ? b.error : undefined;
        if (code && PDF_REPOST_ERRORS.includes(code) && reposts < PDF_REKICK_MAX) {
          reposts = PDF_REKICK_MAX; // once: a second superseded answer is final
          return repost(g);
        }
        return fail("failed", code);
      }
      const pending = pendingStatus(r.body);
      if (!pending) return fail("server_error");
      if (pending === "queued") {
        queuedSince ??= now();
        if (now() - queuedSince >= PDF_REKICK_QUEUED_MS && reposts < PDF_REKICK_MAX && now() < deadline) {
          reposts += 1;
          queuedSince = now();
          return repost(g);
        }
      } else {
        queuedSince = null;
      }
      if (now() >= deadline) {
        clearTimer();
        stopVisible();
        return set({ kind: "timeout", exportId });
      }
      if (state.kind !== "preparing" || state.status !== pending || state.exportId !== exportId) {
        set({ kind: "preparing", exportId, status: pending, paused: false });
      }
      return schedulePoll(exportId, g);
    }

    // Auth / gone / rule answers are final; network + 5xx are retried a few times.
    if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      return fail(errorCodeFor(r.status, r.body));
    }
    failures += 1;
    if (failures >= PDF_POLL_MAX_FAILURES) return fail(r ? errorCodeFor(r.status, r.body) : "network");
    if (now() >= deadline) {
      clearTimer();
      stopVisible();
      return set({ kind: "timeout", exportId });
    }
    schedulePoll(exportId, g);
  };

  /** A POST answer (start or re-POST): ready → download, 202 → (keep) polling, else error. */
  const handlePost = (r: PdfHttpResult, g: number): void => {
    if (r.status >= 200 && r.status < 300) {
      const info = parseReady(r.body);
      if (info) return ready(info, g);
      const pending = pendingStatus(r.body);
      const exportId = obj(r.body)?.exportId;
      if (pending && typeof exportId === "string" && exportId.length > 0) {
        if (state.kind !== "preparing" || state.exportId !== exportId) queuedSince = null;
        if (pending === "queued") queuedSince ??= now();
        set({ kind: "preparing", exportId, status: pending, paused: false });
        return schedulePoll(exportId, g);
      }
      return fail("server_error");
    }
    fail(errorCodeFor(r.status, r.body));
  };

  /** Re-POST mid-poll (kick a stuck queued job / fetch the current PDF). Network errors count as poll failures. */
  async function repost(g: number): Promise<void> {
    let r: PdfHttpResult | null;
    try {
      r = await transport("POST", pdfApiPath(deps.bookId));
    } catch {
      r = null;
    }
    if (disposed || g !== gen) return;
    if (!r) {
      failures += 1;
      if (failures >= PDF_POLL_MAX_FAILURES) return fail("network");
      if (state.kind === "preparing") return schedulePoll(state.exportId, g);
      return fail("network");
    }
    handlePost(r, g);
  }

  return {
    getState: () => state,

    async start() {
      if (disposed || isPdfBusy(state)) return;
      clearTimer();
      stopVisible();
      const g = ++gen;
      failures = 0;
      queuedSince = null;
      reposts = 0;
      set({ kind: "starting" });
      try {
        await deps.beforeStart?.();
      } catch {
        // Export the saved doc anyway.
      }
      if (disposed || g !== gen) return;
      let r: PdfHttpResult | null = null;
      // A 409 conflict (doc saved twice mid-request) is retried once right away.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          r = await transport("POST", pdfApiPath(deps.bookId));
        } catch {
          if (g === gen) fail("network");
          return;
        }
        if (disposed || g !== gen) return;
        if (!(r.status === 409 && errorCodeFor(r.status, r.body) === "conflict")) break;
      }
      if (!r) return;
      deadline = now() + PDF_POLL_CAP_MS;
      handlePost(r, g);
    },

    dispose() {
      disposed = true;
      gen += 1;
      clearTimer();
      stopVisible();
    },
  };
}
