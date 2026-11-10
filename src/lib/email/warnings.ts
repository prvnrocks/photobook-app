import "server-only";
// Reminder emails for the daily cleanup cron (D-057): "free link expires in 3 days" and "draft
// will be deleted". Implements the WarningHook that runCleanup calls first.
//
// Claim / confirm (migration 1800, review B1): claim_* sets *_warning_claimed_at only (FOR UPDATE
// SKIP LOCKED + re-check → two overlapping runs never claim the same book). After each successful
// send we call confirm_warning, which moves the claim to *_warning_sent_at. Draft deletion requires
// draft_warning_sent_at, so a run killed between claim and send/confirm can no longer get a draft
// deleted without an email: the claim just goes stale and claim_* takes it again after 1 hour
// (i.e. the next daily run). A confirm that fails (DB error) is logged as a code and the item stays
// claimed → re-sent by a later run; the Resend Idempotency-Key (per book + UTC day) dedupes a
// same-day resend, a next-day resend is a rare duplicate email (accepted).
//
// Compatibility (deploy order: code first, then 1800): when confirm_warning does not exist
// (PGRST202) the database still has 1600 semantics — claim_* already set *_sent_at — so the
// sender stops confirming for the rest of the run ("legacy=1" in the log) and behaves exactly as
// before: claim = sent, release_warning clears sent_at.
//
// Failed sends AND claimed items never started (deadline) are released after all the kind's
// batches (in `finally`): releasing immediately would let the next claim in the same run pick the
// same book up again and loop on a permanently failing address.
//
// Time (review B1): the warnings phase has its own budget (WARNINGS_BUDGET_MS from the hook's
// start) and must also leave SEND_RESERVE_MS before the cron's deadline. No claim and no send
// starts after min(start + WARNINGS_BUDGET_MS, ctx.deadline - SEND_RESERVE_MS); a send already in
// flight is bounded by EMAIL_SEND_TIMEOUT_MS (8 s), a retry only starts if it fits before that
// point. Unstarted claimed items are released ("deferred" in the log, complete=false).
//
// Nothing is claimed when email is not configured, the unsubscribe secret is missing or the app
// URL is unknown — so a misconfigured deploy never "uses up" a warning.
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
  confirmWarning,
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
/** The warnings phase stops claiming / starting sends this long after it began. */
export const WARNINGS_BUDGET_MS = 100_000;
/** No send starts later than this before the cron's own deadline. */
export const SEND_RESERVE_MS = 25_000;
export const UNSUBSCRIBE_PATH = "/api/email/unsubscribe";

const DAY_MS = 86_400_000;

type Row = { kind: "expiry"; row: ExpiryWarningRow } | { kind: "draft"; row: DraftWarningRow };

export type WarningSenderOptions = {
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  retryDelayMs?: number;
  batch?: number;
  budgetMs?: number;
  reserveMs?: number;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Absolute one-click unsubscribe URL for a user. */
export function unsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
}

type KindStats = { sent: number; failed: number; deferred: number };

type SendOutcome = "sent" | "failed" | "skipped";

export function createWarningSender(options: WarningSenderOptions = {}): WarningHook {
  const sleep = options.sleep ?? realSleep;
  const minInterval = options.minIntervalMs ?? EMAIL_MIN_INTERVAL_MS;
  const retryDelay = options.retryDelayMs ?? EMAIL_RETRY_DELAY_MS;
  const batch = options.batch ?? CLEANUP_BATCH.warningEmails;
  const budgetMs = options.budgetMs ?? WARNINGS_BUDGET_MS;
  const reserveMs = options.reserveMs ?? SEND_RESERVE_MS;

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

    // No claim and no send starts at or after this moment.
    const stopAt = Math.min(ctx.now() + budgetMs, ctx.deadline - reserveMs);
    const canStart = () => ctx.now() < stopAt;
    /** null = not known yet; true = 1600 database (no confirm_warning), claim already = sent. */
    let legacy: boolean | null = null;

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

    /** null = not started (deadline); otherwise the provider's result. */
    async function deliver(
      content: EmailContent,
      to: string,
      headers: Record<string, string>,
      idem: string,
    ): Promise<SendEmailResult | null> {
      await paced();
      if (!canStart()) return null;
      const input = { to, subject: content.subject, html: content.html, text: content.text, headers, idempotencyKey: idem };
      let res = await sendEmail(input);
      if (!res.ok && res.retryable && ctx.now() + retryDelay < stopAt) {
        await sleep(retryDelay);
        await paced();
        if (!canStart()) return res;
        res = await sendEmail(input);
      }
      return res;
    }

    /** Moves the claim to *_sent_at. Never throws; a failure leaves the item claimed (reclaimable). */
    async function confirm(kind: WarningKind, bookId: string): Promise<void> {
      if (legacy === true) return;
      try {
        const r = await confirmWarning(bookId, kind);
        if (r === "unsupported") legacy = true;
        else {
          legacy = false;
          if (r === "not_claimed") note("confirm_not_claimed");
        }
      } catch (e) {
        const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unknown";
        note(`confirm_${code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown"}`);
      }
    }

    function build(item: Row, links: { appUrl: string; unsubscribeUrl: string }): EmailContent {
      if (item.kind === "expiry") {
        return expiryEmail({ bookId: item.row.bookId, title: item.row.title, expiresAt: item.row.expiresAt, now: ctx.now(), links });
      }
      return draftWarningEmail({ bookId: item.row.bookId, title: item.row.title, deleteAfter: item.row.deleteAfter, links });
    }

    /** Sends one claimed warning and confirms it. Never throws. */
    async function sendOne(item: Row): Promise<SendOutcome> {
      const { row } = item;
      if (!row.email) {
        note("no_email");
        return "failed";
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
        return "failed";
      }
      const res = await deliver(content, row.email, headers, `pb-${item.kind}-${row.bookId}-${dayTag}`);
      if (res === null) return "skipped";
      if (!res.ok) {
        note(res.code);
        return "failed";
      }
      await confirm(item.kind, row.bookId);
      return "sent";
    }

    async function pool(items: Row[]): Promise<{ sent: number; failedIds: string[]; skippedIds: string[] }> {
      let i = 0;
      let sent = 0;
      const failedIds: string[] = [];
      const skippedIds: string[] = [];
      async function worker() {
        while (i < items.length) {
          if (!canStart()) {
            // Out of time: leave every remaining claimed item for release.
            while (i < items.length) skippedIds.push(items[i++].row.bookId);
            return;
          }
          const item = items[i++];
          const outcome = await sendOne(item);
          if (outcome === "sent") sent += 1;
          else if (outcome === "failed") failedIds.push(item.row.bookId);
          else skippedIds.push(item.row.bookId);
        }
      }
      await Promise.all(Array.from({ length: Math.min(EMAIL_CONCURRENCY, items.length) }, worker));
      return { sent, failedIds, skippedIds };
    }

    let complete = true;
    const stats: Record<WarningKind, KindStats> = {
      expiry: { sent: 0, failed: 0, deferred: 0 },
      draft: { sent: 0, failed: 0, deferred: 0 },
    };
    let releaseFailures = 0;

    async function runKind(kind: WarningKind, claim: () => Promise<Row[]>): Promise<void> {
      const toRelease: string[] = [];
      try {
        for (;;) {
          if (!canStart()) {
            complete = false;
            return;
          }
          const rows = await claim();
          const { sent, failedIds, skippedIds } = await pool(rows);
          stats[kind].sent += sent;
          stats[kind].failed += failedIds.length;
          stats[kind].deferred += skippedIds.length;
          toRelease.push(...failedIds, ...skippedIds);
          if (skippedIds.length > 0) {
            complete = false;
            return;
          }
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
      const deferred = stats.expiry.deferred + stats.draft.deferred;
      if (deferred > 0) line += ` deferred=${deferred}`;
      if (codeList) line += ` codes=${codeList}`;
      if (legacy === true) line += " legacy=1";
      if (releaseFailures > 0) line += ` release_fail=${releaseFailures}`;
      if (failedCode) line += ` error=${failedCode.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown"}`;
      if (!complete) line += " partial=1";
      const confirmFailed = [...codes.keys()].some((c) => c.startsWith("confirm_"));
      const failedAny = stats.expiry.failed + stats.draft.failed > 0 || releaseFailures > 0 || failedCode || confirmFailed;
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
