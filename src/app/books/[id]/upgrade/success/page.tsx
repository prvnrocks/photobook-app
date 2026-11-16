import type { Metadata } from "next";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { UpgradeBand } from "@/components/upgrade/UpgradeBand";
import { UP_BODY, UP_CARD, UP_HEADING } from "@/components/upgrade/upgrade-classes";
import {
  UPGRADE_BAND_BACK,
  UPGRADE_BODY,
  UPGRADE_COLUMN,
  UPGRADE_CONTAINER,
  UPGRADE_RETRY,
} from "@/components/upgrade/upgrade-page-classes";
import { UpgradeStatusPoller } from "@/components/upgrade/UpgradeStatusPoller";
import "@/components/upgrade/upgrade-motion.css";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyProfile } from "@/lib/db/profiles";
import { getPublishRow } from "@/lib/db/publish";
import { isUuid } from "@/lib/uuid";
import { getUpgradeStatus } from "../actions";

// Stripe Checkout return page (M7 T7). The `session_id` query param Stripe appends is ignored on
// purpose: only the webhook sets books.is_paid, and this page shows success only once the live
// is_paid (read here or via getUpgradeStatus polling) is true.
// M26 (D-078): library-width app header, compact emerald band (back to the editor, "Upgrade", the
// book title) and the poller's cream status card centred on the cream body. Restyle only.

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Upgrade", robots: { index: false, follow: false } };

export default async function UpgradeSuccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const loginNext = `/login?next=${encodeURIComponent(`/books/${rawId}/upgrade/success`)}`;
  const user = await getCurrentUser();
  if (!user) redirect(loginNext);
  if (!isUuid(rawId)) notFound();
  const id = rawId.toLowerCase();

  const profile = getMyProfile().catch(() => null);

  // Owner-scoped (id AND user_id): someone else's / unknown book → null → 404.
  let row: Awaited<ReturnType<typeof getPublishRow>>;
  try {
    row = await getPublishRow(id, user.id.toLowerCase());
  } catch {
    const p = await profile;
    return (
      <div className="flex min-h-dvh flex-col bg-background">
        <AppHeader displayName={p?.name ?? p?.email ?? user.email ?? null} variant="plain" width="library" />
        <main className={`${UPGRADE_CONTAINER} ${UPGRADE_BODY} flex-1`} data-testid="upgrade-load-error">
          <div className={UPGRADE_COLUMN}>
            <div className={UP_CARD}>
              <h1 className={UP_HEADING}>We couldn&apos;t load this page</h1>
              <p className={UP_BODY}>Please check your connection and try again.</p>
              <Link href={`/books/${id}/upgrade/success`} className={UPGRADE_RETRY}>
                Try again
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }
  if (!row) notFound();
  const p = await profile;

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeader displayName={p?.name ?? p?.email ?? user.email ?? null} variant="plain" width="library" />
      <main className="flex w-full flex-1 flex-col" data-testid="upgrade-main">
        <UpgradeBand
          title={row.title}
          back={
            <Link href={`/books/${id}/edit`} className={UPGRADE_BAND_BACK} data-testid="upgrade-back">
              <ChevronLeft className="size-4 shrink-0 rtl:rotate-180" aria-hidden="true" />
              Back to editor
            </Link>
          }
        />
        <div className={`${UPGRADE_CONTAINER} ${UPGRADE_BODY}`}>
          <div className={UPGRADE_COLUMN}>
            <UpgradeStatusPoller
              bookId={id}
              initialPaid={row.is_paid === true}
              liveSlug={row.live && row.slug ? row.slug : null}
              check={getUpgradeStatus.bind(null, id)}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
