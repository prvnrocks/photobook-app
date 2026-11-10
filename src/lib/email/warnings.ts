import "server-only";
// Reminder emails for the daily cleanup cron (D-057): "free link expires in 3 days" and "draft
// will be deleted". Implements the WarningHook that runCleanup calls first.
//
// Claim semantics (1600): claim_* marks a batch as sent atomically (FOR UPDATE SKIP LOCKED + sent_at
// guard), so two overlapping runs can never both email the same book. Emails that fail are
// released (sent_at cleared) so tomorrow's run retries them. Releases happen once per kind, after
// all its batches (in `finally`): releasing immediately would let the next claim in the same run
// pick the same book up again and loop on a permanently failing address.
//
// Nothing is claimed when email is not configured, the unsubscribe secret is missing or the app
// URL is unknown — so a misconfigured deploy never "uses up" a warning (draft deletion waits for a
// claimed warning, see cleanup_delete_abandoned_drafts).
//
// Sending: at most EMAIL_CONCURRENCY in flight and at most one start per EMAIL_MIN_INTERVAL_MS
// (Resend's default API rate limit is a few requests per second); one retry with the same
// Resend Idempotency-Key for timeouts / 429 / 5xx, so a retry can't deliver twice.
//
// Logs: one line `[email] warnings …` with counts and error codes. Never addresses, titles, ids.
import { getSiteUrl } from "@/lib/auth/redirect";
import { CLEANUP_BATCH, DRAFT_IDLE_DAYS, DRAFT_WARNING_DAYS, EXPIRY_WARNING_DAYS_BEFORE, type WarningKind } from "@/lib/cleanup/rules";
import type { WarningHook, WarningHookContext, WarningHookResult } from "@/lib/cleanup/run";
import {
  claimDraftWarnings,
  claimExpiryWarnings,
  releaseWarning,
  type DraftWarningRow,
  type ExpiryWarningRow,
} from "@/lib/db/cleanup";
import { isEmailEnabled, sendEmail, type SendEmailResult } from "@/lib/email/client";
import { draftWarningEmail } from "@/lib/email/templates/draft-warning";
import { expiryEmail } from "@/lib/email/templates/expiry";
import { unsubscribeHeaders, type EmailContent } from "@/lib/email/templates/layout";
import { getUnsubscribeKey, signUnsubscribeToken } from "@/lib/email/unsubscribe-token";

export const EMAIL_CONCURRENCY = 3;
export const EMAIL_MIN_INTERVAL_MS = 550;
export const EMAIL_RETRY_DELAY_MS = 1_500;
export const UNSUBSCRIBE_PATH = "/api/email/unsubscribe";

const DAY_MS = 86_400_000;

type Row = { kind: "expiry"; row: ExpiryWarningRow } | { kind: "draft"; row: DraftWarningRow };

export type WarningSenderOptions = {
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  retryDelayMs?: number;
  batch?: number;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Absolute one-click unsubscribe URL for a user. */
export function unsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
}

type KindStats = { sent: number; failed: number };

export function createWarningSender(options: WarningSenderOptions = {}): WarningHook {
  const sleep = options.sleep ?? realSleep;
  const minInterval = options.minIntervalMs ?? EMAIL_MIN_INTERVAL_MS;
  const retryDelay = options.retryDelayMs ?? EMAIL_RETRY_DELAY_MS;
  const batch = options.batch ?? CLEANUP_BATCH.warningEmails;

  return async function sendWarningEmails(ctx: WarningHookContext): Promise<WarningHookResult> {
    if (!isEmailEnabled()) return { sent: 0, failed: 0, complete: true };

    const key = getUnsubscribeKey();
    let appUrl: string | null = null;
    try {
      appUrl = getSiteUrl();
    } catch {
      appUrl = null;
    }
    if (!key || !appUrl) {
      console.error(`[email] warnings skipped code=${key ? "no_app_url" : "no_unsubscribe_secret"}`);
      return { sent: 0, failed: 0, complete: false };
    }
    const origin = appUrl;

    // Token issue time rounded to the UTC day: same-day retries build an identical payload, which
    // Resend requires for a reused Idempotency-Key.
    const issuedAt = Math.floor(ctx.now() / DAY_MS) * DAY_MS;
    const dayTag = new Date(issuedAt).toISOString().slice(0, 10).replace(/-/g, "");
    const codes = new Map<string, number>();
    const note = (code: string) => codes.set(code, (codes.get(code) ?? 0) + 1);

    // Paced start slots shared by all workers.
    let nextStart = 0;
    async function paced(): Promise<void> {
      const t = ctx.now();
      const at = Math.max(t, nextStart);
      nextStart = at + minInterval;
      if (at > t) await sleep(at - t);
    }

    async function deliver(content: EmailContent, to: string, headers: Record<string, string>, idem: string): Promise<SendEmailResult> {
      await paced();
      const input = { to, subject: content.subject, html: content.html, text: content.text, headers, idempotencyKey: idem };
      let res = await sendEmail(input);
      if (!res.ok && res.retryable && ctx.now() + retryDelay < ctx.deadline) {
        await sleep(retryDelay);
        await paced();
        res = await sendEmail(input);
      }
      return res;
    }

    function build(item: Row, links: { appUrl: string; unsubscribeUrl: string }): EmailContent {
      if (item.kind === "expiry") {
        return expiryEmail({ bookId: item.row.bookId, title: item.row.title, expiresAt: item.row.expiresAt, now: ctx.now(), links });
      }
      return draftWarningEmail({ bookId: item.row.bookId, title: item.row.title, deleteAfter: item.row.deleteAfter, links });
    }

    /** Sends one claimed warning; true when sent. Never throws. */
    async function sendOne(item: Row): Promise<boolean> {
      const { row } = item;
      if (!row.email) {
        note("no_email");
        return false;
      }
      let content: EmailContent;
      let headers: Record<string, string>;
      try {
        const token = signUnsubscribeToken(row.userId, issuedAt, key);
        if (!token) throw new Error("no token");
        const unsub = unsubscribeUrl(origin, token);
        content = build(item, { appUrl: origin, unsubscribeUrl: unsub });
        headers = unsubscribeHeaders(unsub);
      } catch {
        note("template");
        return false;
      }
      const res = await deliver(content, row.email, headers, `pb-${item.kind}-${row.bookId}-${dayTag}`);
      if (!res.ok) note(res.code);
      return res.ok;
    }

    async function pool(items: Row[]): Promise<{ sent: number; failedIds: string[] }> {
      let i = 0;
      let sent = 0;
      const failedIds: string[] = [];
      async function worker() {
        while (i < items.length) {
          const item = items[i++];
          if (await sendOne(item)) sent += 1;
          else failedIds.push(item.row.bookId);
        }
      }
      await Promise.all(Array.from({ length: Math.min(EMAIL_CONCURRENCY, items.length) }, worker));
      return { sent, failedIds };
    }

    let complete = true;
    const stats: Record<WarningKind, KindStats> = { expiry: { sent: 0, failed: 0 }, draft: { sent: 0, failed: 0 } };
    let releaseFailures = 0;

    async function runKind(kind: WarningKind, claim: () => Promise<Row[]>): Promise<void> {
      const toRelease: string[] = [];
      try {
        for (;;) {
          if (ctx.now() >= ctx.deadline) {
            complete = false;
            return;
          }
          const rows = await claim();
          const { sent, failedIds } = await pool(rows);
          stats[kind].sent += sent;
          stats[kind].failed += failedIds.length;
          toRelease.push(...failedIds);
          if (rows.length < batch) return;
          if (sent === 0) {
            // A whole batch failed (quota, provider outage, bad config): stop; tomorrow retries.
            complete = false;
            return;
          }
        }
      } finally {
        for (const bookId of toRelease) {
          try {
            await releaseWarning(bookId, kind);
          } catch {
            releaseFailures += 1;
          }
        }
      }
    }

    let failedCode: string | undefined;
    try {
      await runKind("expiry", async () =>
        (await claimExpiryWarnings(batch, EXPIRY_WARNING_DAYS_BEFORE)).map((row) => ({ kind: "expiry" as const, row })),
      );
      await runKind("draft", async () =>
        (await claimDraftWarnings(batch, DRAFT_WARNING_DAYS, DRAFT_IDLE_DAYS)).map((row) => ({ kind: "draft" as const, row })),
      );
    } catch (e) {
      failedCode = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unknown";
      throw e;
    } finally {
      const codeList = [...codes].map(([c, n]) => `${c}:${n}`).join(",");
      let line =
        `[email] warnings expiry_sent=${stats.expiry.sent} expiry_failed=${stats.expiry.failed}` +
        ` draft_sent=${stats.draft.sent} draft_failed=${stats.draft.failed}`;
      if (codeList) line += ` codes=${codeList}`;
      if (releaseFailures > 0) line += ` release_fail=${releaseFailures}`;
      if (failedCode) line += ` error=${failedCode.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown"}`;
      if (!complete) line += " partial=1";
      const failedAny = stats.expiry.failed + stats.draft.failed > 0 || releaseFailures > 0 || failedCode;
      if (failedAny) console.error(line);
      else console.info(line);
    }

    return {
      sent: stats.expiry.sent + stats.draft.sent,
      failed: stats.expiry.failed + stats.draft.failed,
      complete,
    };
  };
}

/** The hook the cron route passes to runCleanup. */
export const sendWarningEmails: WarningHook = createWarningSender();
