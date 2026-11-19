// Share page (M6 T8; M21 T5 redesign): the plain app header, the emerald ShareBand (back to the
// editor, "SHARE", the book title as the page h1, the status chip, the 3-step mini progress), then a
// library-width body — the client <PublishPanel> lays out the cards (two columns from lg, a phone
// sticky bar below). The preview, plan and PDF cards only change with server state, so they are
// rendered here (shareSlots) and passed in as slots. Paid status is only ever the server's
// (getPublishState → books.is_paid, set by the Stripe webhook). No title / slug / URL in logs.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { ChevronLeft } from "lucide-react";
import { AppHeader } from "@/components/layout/AppHeader";
import { PublishPanel } from "@/components/publish/PublishPanel";
import { SHARE_CTA_GOLD } from "@/components/publish/share-classes";
import { SHARE_BACK_LINK, SHARE_BODY, shareChipKind } from "@/components/publish/share-page-classes";
import { ShareBand } from "@/components/publish/ShareBand";
import { shareSlots } from "@/components/publish/share-slots";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyBookTitle } from "@/lib/db/books";
import { getMyProfile } from "@/lib/db/profiles";
import { publishCompare } from "@/lib/publish/compare";
import { shareStatus } from "@/lib/publish/status";
import { isPaymentsEnabled } from "@/lib/stripe";
import { getPublishState, publishBookAction, resetShareLinkAction, setBookPasswordAction, unpublishBookAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Share your book" };

export default async function PublishPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ shared?: string | string[] }>;
}) {
  const { id } = await params;
  // Editor Share just published (M13 T9): one-time "Your book is live" / "Changes published".
  const sharedParam = (await searchParams).shared;
  const shared = sharedParam === "live" || sharedParam === "changes" ? sharedParam : null;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/books/${id}/publish`)}`);

  const [res, profile] = await Promise.all([getPublishState(id), getMyProfile().catch(() => null)]);
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;
  if (!res.ok) {
    if (res.error === "signed_out") redirect(`/login?next=${encodeURIComponent(`/books/${id}/publish`)}`);
    if (res.error === "not_found") notFound();
    return (
      <div className="flex min-h-dvh flex-col bg-background">
        <AppHeader displayName={displayName} variant="plain" width="library" />
        <main className={`${SHARE_BODY} flex flex-1 flex-col items-center justify-center py-10`} data-testid="publish-load-error">
          <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-[1.75rem] border border-[#e9dfca] bg-card p-6 text-center shadow-[0_18px_40px_-28px_rgb(14_59_46/0.45)] sm:p-8">
            <h1 className="font-display text-2xl leading-tight font-semibold text-[#0e3b2e] sm:text-3xl">We couldn&apos;t load this page</h1>
            <p className="type-body text-muted-foreground">Please check your connection and try again.</p>
            <Link href={`/books/${id}/publish`} className={`${SHARE_CTA_GOLD} w-full sm:w-auto`}>
              Try again
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const title = (await getMyBookTitle(id).catch(() => null)) || "Our photobook";
  const paymentsEnabled = isPaymentsEnabled();
  const status = shareStatus(res.state, new Date());
  const slots = shareSlots({ bookId: id, title, state: res.state, preview: res.preview, compare: publishCompare(), paymentsEnabled });

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeader displayName={displayName} variant="plain" width="library" />
      <main className="flex w-full flex-1 flex-col" data-testid="publish-main">
        <ShareBand
          title={title}
          chip={{ text: status.chip, kind: shareChipKind(status) }}
          back={
            <Link href={`/books/${id}/edit`} className={SHARE_BACK_LINK} data-testid="publish-back">
              <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
              Back to editor
            </Link>
          }
        />
        <div className={`${SHARE_BODY} pt-4 pb-10 sm:pt-8 lg:pt-10 lg:pb-16`}>
          <h2 className="sr-only">Share your book</h2>
          <Suspense fallback={null}>
            <UpgradeCancelledNotice className="mb-4 sm:mb-stack" />
          </Suspense>
          <PublishPanel
            bookId={id}
            paymentsEnabled={paymentsEnabled}
            title={title}
            state={res.state}
            shared={shared}
            preview={slots.preview}
            plan={slots.plan}
            pdf={slots.pdf}
            actions={{
              publish: publishBookAction.bind(null, id),
              unpublish: unpublishBookAction.bind(null, id),
              resetLink: resetShareLinkAction.bind(null, id),
              setPassword: setBookPasswordAction.bind(null, id),
            }}
          />
        </div>
      </main>
    </div>
  );
}
