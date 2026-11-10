import "server-only";
// Transactional email via Resend (D-057). Server only.
//
// Off unless BOTH RESEND_API_KEY and EMAIL_FROM are set (isEmailEnabled) — the cron then sends
// nothing and claims nothing. Never logs addresses, subjects or bodies: callers get a short error
// code and log counts / codes only.
import { Resend } from "resend";

/** Hard bound on one send (abort + treat as failed). */
export const EMAIL_SEND_TIMEOUT_MS = 10_000;

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Resend Idempotency-Key (same key within 24 h = same email, never sent twice). */
  idempotencyKey?: string;
};

export type SendEmailErrorCode =
  | "not_configured"
  | "invalid_input"
  | "timeout"
  | "rate_limited"
  | "quota"
  | "rejected"
  | "server"
  | "network";

export type SendEmailResult = { ok: true } | { ok: false; code: SendEmailErrorCode; retryable: boolean };

type EmailEnv = Record<string, string | undefined>;

function config(env: EmailEnv): { key: string; from: string } | null {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  return key && from ? { key, from } : null;
}

/** True when RESEND_API_KEY and EMAIL_FROM are both set. */
export function isEmailEnabled(env: EmailEnv = process.env): boolean {
  return config(env) !== null;
}

// One SDK instance per key (the module is reused across warm invocations).
let cached: { key: string; client: Resend } | null = null;
function client(key: string): Resend {
  if (!cached || cached.key !== key) cached = { key, client: new Resend(key) };
  return cached.client;
}

// Loose address check — the address comes from auth.users, this only rejects garbage / header
// injection before it reaches the provider.
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

function classify(statusCode: number | null | undefined, name: string | undefined): {
  code: SendEmailErrorCode;
  retryable: boolean;
} {
  if (name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") return { code: "quota", retryable: false };
  if (name === "rate_limit_exceeded" || name === "concurrent_idempotent_requests" || statusCode === 429) {
    return { code: "rate_limited", retryable: true };
  }
  if (typeof statusCode === "number" && statusCode >= 500) return { code: "server", retryable: true };
  if (statusCode === null || statusCode === undefined) return { code: "network", retryable: true };
  return { code: "rejected", retryable: false };
}

/** Sends one email. Never throws; never logs. */
export async function sendEmail(input: SendEmailInput, env: EmailEnv = process.env): Promise<SendEmailResult> {
  const cfg = config(env);
  if (!cfg) return { ok: false, code: "not_configured", retryable: false };
  if (
    typeof input.to !== "string" ||
    input.to.length > 254 ||
    !EMAIL_RE.test(input.to) ||
    !input.subject ||
    /[\r\n]/.test(input.subject) ||
    !input.html ||
    !input.text
  ) {
    return { ok: false, code: "invalid_input", retryable: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMAIL_SEND_TIMEOUT_MS);
  try {
    const res = await client(cfg.key).emails.send(
      {
        from: cfg.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        headers: input.headers,
      },
      { signal: controller.signal, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) },
    );
    if (!res.error) return { ok: true };
    if (controller.signal.aborted) return { ok: false, code: "timeout", retryable: true };
    return { ok: false, ...classify(res.error.statusCode, res.error.name) };
  } catch {
    if (controller.signal.aborted) return { ok: false, code: "timeout", retryable: true };
    return { ok: false, code: "network", retryable: true };
  } finally {
    clearTimeout(timer);
  }
}
