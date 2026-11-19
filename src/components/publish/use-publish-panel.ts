// State + actions of the share page panel (M21 T3, moved out of PublishPanel unchanged): publish
// (with the conflict retry, the `published` analytics event — flags + page count only — and the
// celebration), unpublish, password changes, the one-time ?shared= message. Every success refreshes
// so the cards render from the server's PublishState.

import { useEffect, useState } from "react";
import type { PublishBookResult, PublishState, ResetShareLinkResult, UnpublishBookResult } from "@/app/books/[id]/publish/actions";
import { track } from "@/lib/analytics/client";
import {
  CHANGES_PUBLISHED_TEXT,
  LIVE_TEXT,
  publishErrorCopy,
  publishWithRetry,
  RESET_LINK_TEXT,
  UNPUBLISHED_TEXT,
  unpublishErrorCopy,
} from "@/lib/publish/ui";
import type { PublishActions } from "./PublishPanel";

export type PanelMessage = { tone: "ok" | "error"; text: string; signIn?: boolean };

export function usePublishPanel({
  state,
  actions,
  shared,
  refresh,
  wait,
}: {
  state: PublishState;
  actions: PublishActions;
  shared: "live" | "changes" | null;
  refresh: () => void;
  wait?: (ms: number) => Promise<void>;
}) {
  const [busy, setBusy] = useState<"publish" | "unpublish" | "reset" | null>(null);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [message, setMessage] = useState<PanelMessage | null>(() =>
    shared ? { tone: "ok", text: shared === "changes" ? CHANGES_PUBLISHED_TEXT : LIVE_TEXT } : null,
  );
  // The editor's Share just published, or a publish here succeeded: celebrate once.
  const [celebrate, setCelebrate] = useState(shared !== null);
  // Drop ?shared= so a reload or Back doesn't announce the publish again.
  useEffect(() => {
    if (!shared || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("shared")) return;
    url.searchParams.delete("shared");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [shared]);
  // The state a first publish succeeded on: until the refresh brings the live state, the draft
  // card (disabled Publish) would sit under "Your book is live" — show a link placeholder instead.
  const [publishedOn, setPublishedOn] = useState<PublishState | null>(null);

  const onPublish = async () => {
    setBusy("publish");
    setMessage(null);
    let r: PublishBookResult;
    try {
      r = await publishWithRetry(actions.publish, wait);
    } catch {
      r = { ok: false, error: "failed" };
    }
    setBusy(null);
    if (r.ok) {
      // analytics (M9 T14): flags + page count only.
      track("published", {
        is_paid: state.isPaid,
        has_password: state.hasPassword,
        pages: state.pageCount,
        first: state.publishedAt === null,
      });
      setMessage({ tone: "ok", text: state.published ? CHANGES_PUBLISHED_TEXT : LIVE_TEXT });
      setCelebrate(true);
      if (!state.published) setPublishedOn(state);
      refresh();
    } else {
      setMessage({ tone: "error", text: publishErrorCopy(r.error, state.maxPages), signIn: r.error === "signed_out" });
      if (r.error === "expired") refresh();
    }
  };

  const onUnpublish = async () => {
    setBusy("unpublish");
    setMessage(null);
    let r: UnpublishBookResult;
    try {
      r = await actions.unpublish();
    } catch {
      r = { ok: false, error: "failed" };
    }
    setBusy(null);
    setConfirmUnpublish(false);
    if (r.ok) {
      setMessage({ tone: "ok", text: UNPUBLISHED_TEXT });
      setCelebrate(false);
      refresh();
    } else {
      setMessage({ tone: "error", text: unpublishErrorCopy(r.error), signIn: r.error === "signed_out" });
    }
  };

  /** Task 9: revoke the link for good; publishing again makes a new one. */
  const onResetLink = async () => {
    if (!actions.resetLink) return;
    setBusy("reset");
    setMessage(null);
    let r: ResetShareLinkResult;
    try {
      r = await actions.resetLink();
    } catch {
      r = { ok: false, error: "failed" };
    }
    setBusy(null);
    setConfirmUnpublish(false);
    if (r.ok) {
      setMessage({ tone: "ok", text: RESET_LINK_TEXT });
      setCelebrate(false);
      refresh();
    } else {
      setMessage({ tone: "error", text: unpublishErrorCopy(r.error), signIn: r.error === "signed_out" });
    }
  };

  const onPasswordChanged = (text: string) => {
    setMessage({ tone: "ok", text });
    refresh();
  };

  return { busy, message, celebrate, publishedOn, confirmUnpublish, setConfirmUnpublish, onPublish, onUnpublish, onResetLink, onPasswordChanged };
}
