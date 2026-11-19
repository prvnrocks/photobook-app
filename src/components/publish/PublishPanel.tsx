"use client";

// Publish / share screen body (M6 T8, D-039 / D-040; split in M21 T3, laid out in M21 T5).
// Orchestration only: holds the action state, calls the bound publish actions and places the cards —
// every card renders from the server's PublishState (getPublishState); after every successful action
// the page refreshes so the state always comes from the server. Copy lives in src/lib/publish/ui.ts.
//
// Layout (SHARE_COLUMNS): from lg two columns — a sticky aside with the preview slot and the cards;
// below lg the preview (compact row) on top, then the cards, plus a sticky bottom bar.
//   message slot → PrimaryActionCard (draft / changes / pending / live / expired) → ShareLinkCard
//   (while live) → plan slot (not when expired free) → PDF slot → password → DangerZone (published).
// The preview / plan / PDF slots only change with server state, so the page renders them on the
// server (share-slots.tsx) — their markup stays out of this client bundle.
// Phone sticky bar: Publish (draft) / Update link (changes) / Send on WhatsApp (live), shown only
// while that card's own button is not visible above the bar (scrolled off the top, or wholly in /
// below the strip the bar covers, measured from the bar's real height) — never both at once; none
// when expired, blocked or pending.
// Celebration (publish success or ?shared=): data-celebrate on the panel root fires the preview's
// burst (CSS ancestor selector) and the live card's badge hop; nothing moves under reduced motion.
//
// <PublishPanel> wires next/navigation; <PublishPanelView> takes `refresh` so it renders without
// an app router (unit tests, dev fixture). No cn/buttonVariants/next/link here (lesson 2026-11-14).

import { Loader2, MessageCircle, Send } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { PublishBookResult, ResetShareLinkResult, PublishState, SetBookPasswordResult, UnpublishBookResult } from "@/app/books/[id]/publish/actions";
import { Notice } from "@/components/app/Notice";
import { useRefreshTransition } from "@/components/app/use-refresh-transition";
import { UpgradeButtonView } from "@/components/upgrade/UpgradeButton";
import { shareStatus } from "@/lib/publish/status";
import { LIVE_TEXT, SHARE_COPY } from "@/lib/publish/ui";
import { whatsappShareUrl } from "@/lib/viewer/share";
import { DangerZone } from "./DangerZone";
import { PasswordField } from "./PasswordField";
import { PrimaryActionCard, primaryActionKind, type PrimaryActionKind } from "./PrimaryActionCard";
import { SHARE_BAR_SPACER, SHARE_COLUMNS, SHARE_CTA_GOLD, SHARE_CTA_WHATSAPP, SHARE_UPGRADE_CLASS } from "./share-classes";
import { ShareLinkCard } from "./ShareLinkCard";
import { usePublishPanel, type PanelMessage } from "./use-publish-panel";
import "./share-motion.css";

export type PublishActions = {
  publish: () => Promise<PublishBookResult>;
  unpublish: () => Promise<UnpublishBookResult>;
  /** Task 9: revoke the link for good (next publish = a new link). Absent = option hidden. */
  resetLink?: () => Promise<ResetShareLinkResult>;
  setPassword: (password: string | null) => Promise<SetBookPasswordResult>;
};

export type PublishPanelProps = {
  bookId: string;
  /** Book title for the share message (owner's own title). */
  title: string;
  state: PublishState;
  actions: PublishActions;
  /** isPaymentsEnabled() from the server page (Stripe keys configured). */
  paymentsEnabled: boolean;
  /** The editor's Share just published (`?shared=`, M13 T9): shown once as the success message. */
  shared?: "live" | "changes" | null;
  /**
   * Book preview (shareSlots().preview: <SharePreview responsive>). It carries the page's one
   * "Open flipbook" (publish-open) while live and the celebration burst. Given → two columns from
   * lg. Omitted (unit tests only) → one column, no open link, no burst.
   */
  preview?: ReactNode;
  /** shareSlots().plan: PlanCard (free compare + Upgrade, or the paid thank-you). Hidden on an expired free link. */
  plan?: ReactNode;
  /** shareSlots().pdf: PdfCard (paid download or the locked free card). */
  pdf?: ReactNode;
};

export function PublishPanel(props: PublishPanelProps) {
  // Not startTransition(router.refresh): that can stay pending forever under publish/loading.tsx.
  const [pending, refresh] = useRefreshTransition();
  return <PublishPanelView {...props} refresh={refresh} refreshing={pending} />;
}

/**
 * Heading of the live card: "Your book is live" — unless the notice above already says exactly
 * that (just published), then the card names the next step instead (M13 polish: shown once).
 */
export function liveHeading(message: { text: string } | null): string {
  return message?.text === LIVE_TEXT ? "Share your link" : LIVE_TEXT;
}

export type ShareBarAction = "publish" | "update" | "whatsapp";

/** What the phone sticky bar offers for a card variant; null = no bar (expired / pending / blocked / no link). */
export function shareBarAction(kind: PrimaryActionKind, blocked: boolean, hasUrl: boolean): ShareBarAction | null {
  if (kind === "draft") return blocked ? null : "publish";
  if (kind === "changes") return blocked ? null : "update";
  if (kind === "live") return hasUrl ? "whatsapp" : null;
  return null;
}

/** The card control the bar stands in for: the bar shows only while that control is not visible above it. */
const BAR_TARGET: Record<ShareBarAction, string> = {
  publish: "publish-button",
  update: "publish-changes-button",
  whatsapp: "share-whatsapp",
};

export function PublishPanelView({
  bookId,
  title,
  state,
  actions,
  paymentsEnabled,
  shared = null,
  preview = null,
  plan = null,
  pdf = null,
  refresh,
  refreshing = false,
  now,
  wait,
}: PublishPanelProps & {
  refresh: () => void;
  refreshing?: boolean;
  /** Clock for the expiry label / share status (tests). */
  now?: Date;
  /** Conflict retry delay (tests). */
  wait?: (ms: number) => Promise<void>;
}) {
  const { busy, message, celebrate, publishedOn, confirmUnpublish, setConfirmUnpublish, onPublish, onUnpublish, onResetLink, onPasswordChanged } =
    usePublishPanel({ state, actions, shared, refresh, wait });
  const locked = busy !== null || refreshing;
  const rootRef = useRef<HTMLDivElement>(null);

  const status = shareStatus(state, now ?? new Date());
  const expired = status.kind === "expired";
  const live = state.published && !expired;
  const kind = primaryActionKind(status, !state.published && publishedOn === state);
  const celebrating = celebrate && kind === "live";
  const bar = shareBarAction(kind, state.canPublishReason !== null, live && !!state.url);
  const barVisible = useOffscreen(rootRef, bar ? BAR_TARGET[bar] : null);

  return (
    <div
      ref={rootRef}
      className={preview ? SHARE_COLUMNS : undefined}
      data-testid="publish-panel"
      data-state={expired ? "expired" : live ? "published" : "unpublished"}
      data-celebrate={celebrating ? "on" : undefined}
    >
      {preview ? (
        <aside aria-label="Your book" className="mb-4 sm:mb-stack lg:sticky lg:top-8 lg:mb-0" data-testid="publish-aside">
          {preview}
        </aside>
      ) : null}

      <div className="min-w-0">
        {/* Same position in every branch so the message survives router.refresh(). */}
        <div aria-live="polite" data-testid="publish-message-slot" className="[&:not(:empty)]:mb-4 sm:[&:not(:empty)]:mb-stack">
          {message ? <PanelNotice message={message} bookId={bookId} /> : null}
        </div>

        <div className="flex flex-col gap-4 sm:gap-stack">
          <PrimaryActionCard
            key={kind}
            kind={kind}
            state={state}
            liveHeading={liveHeading(message)}
            busy={busy === "publish"}
            locked={locked}
            onPublish={onPublish}
            upgrade={
              <UpgradeButtonView
                bookId={bookId}
                returnTo={`/books/${bookId}/publish`}
                isPaid={state.isPaid}
                paymentsEnabled={paymentsEnabled}
                className={SHARE_UPGRADE_CLASS}
                testId="publish-upgrade"
                refresh={refresh}
              />
            }
            celebrate={celebrating}
            now={now}
          />

          {live && state.url ? (
            <ShareLinkCard url={state.url} title={title} />
          ) : null}

          {expired && !state.isPaid ? null : plan}

          {pdf}

          {!expired ? <PasswordField hasPassword={state.hasPassword} setPassword={actions.setPassword} onChanged={onPasswordChanged} disabled={locked} /> : null}

          {state.published ? (
            <DangerZone
              isPaid={state.isPaid}
              confirming={confirmUnpublish}
              onConfirmChange={setConfirmUnpublish}
              onUnpublish={onUnpublish}
              {...(actions.resetLink ? { onResetLink, resetBusy: busy === "reset" } : {})}
              busy={busy === "unpublish"}
              locked={locked}
            />
          ) : null}
        </div>
      </div>

      {bar ? (
        <>
          <div aria-hidden="true" className={SHARE_BAR_SPACER} data-testid="publish-bar-spacer" />
          <ShareBar
            action={bar}
            visible={barVisible}
            busy={busy === "publish"}
            locked={locked}
            onPublish={onPublish}
            whatsappHref={bar === "whatsapp" && state.url ? whatsappShareUrl(title, state.url) : null}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * True while the card control with `testId` is not visible above the sticky bar: scrolled above the
 * viewport top, or wholly inside / below the strip the bar covers. The strip is the bar's real height
 * (offsetHeight of [data-share-bar], safe area included; 0 from lg where the bar is display:none),
 * re-measured when the bar resizes — so the bar never shows while any part of the card control is on
 * screen above it (M21 fix: a fixed 96 px margin left two WhatsApp buttons visible at 375).
 * Starts false (no bar flash on load); without IntersectionObserver the bar just shows.
 */
function useOffscreen(root: RefObject<HTMLElement | null>, testId: string | null): boolean {
  const [off, setOff] = useState(false);
  const [barHeight, setBarHeight] = useState(0);

  useEffect(() => {
    const bar = testId ? root.current?.querySelector<HTMLElement>("[data-share-bar]") : null;
    if (!bar) return;
    const measure = () => setBarHeight(Math.ceil(bar.offsetHeight));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [root, testId]);

  useEffect(() => {
    const el = testId ? root.current?.querySelector(`[data-testid="${testId}"]`) : null;
    if (!el) return setOff(false);
    if (typeof IntersectionObserver === "undefined") return setOff(true);
    const io = new IntersectionObserver(([e]) => setOff(!e.isIntersecting), { rootMargin: shareBarRootMargin(barHeight) });
    io.observe(el);
    return () => io.disconnect();
  }, [root, testId, barHeight]);
  return off;
}

/** IntersectionObserver rootMargin for the visible area above a sticky bar `barHeight` px tall. */
export function shareBarRootMargin(barHeight: number): string {
  return `0px 0px -${Math.max(0, Math.ceil(barHeight))}px 0px`;
}

/** Phone-only fixed bar (hidden from lg). Own testids — the card buttons keep theirs. */
function ShareBar({
  action,
  visible,
  busy,
  locked,
  onPublish,
  whatsappHref,
}: {
  action: ShareBarAction;
  visible: boolean;
  busy: boolean;
  locked: boolean;
  onPublish: () => void;
  whatsappHref: string | null;
}) {
  return (
    <div
      className="share-bar fixed inset-x-0 bottom-0 z-40 border-t border-[#e2d7c1] bg-[#faf6ee]/95 px-gutter pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-12px_28px_-20px_rgb(14_59_46/0.5)] backdrop-blur lg:hidden"
      data-share-bar=""
      data-testid="publish-sticky-bar"
      data-action={action}
      data-visible={visible ? "true" : "false"}
    >
      <div className="mx-auto w-full max-w-md">
        {whatsappHref ? (
          <a href={whatsappHref} target="_blank" rel="noopener noreferrer" className={SHARE_CTA_WHATSAPP} data-testid="publish-bar-whatsapp">
            <MessageCircle className="size-5" aria-hidden="true" />
            {SHARE_COPY.whatsapp}
          </a>
        ) : (
          <button type="button" onClick={onPublish} disabled={locked} className={`${SHARE_CTA_GOLD} w-full`} data-testid="publish-bar-button">
            {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
            {action === "update" ? SHARE_COPY.updateLink : SHARE_COPY.publish}
          </button>
        )}
      </div>
    </div>
  );
}

/** The one-time message above the cards; the testid sits on the text (Notice adds an sr-only tone). */
function PanelNotice({ message, bookId }: { message: PanelMessage; bookId: string }) {
  return (
    <Notice tone={message.tone === "error" ? "error" : "success"}>
      <p data-testid="publish-message">
        {message.text}
        {message.signIn ? (
          <>
            {" "}
            <a href={`/login?next=${encodeURIComponent(`/books/${bookId}/publish`)}`} className="font-medium underline underline-offset-4">
              {SHARE_COPY.signIn}
            </a>
          </>
        ) : null}
      </p>
    </Notice>
  );
}
