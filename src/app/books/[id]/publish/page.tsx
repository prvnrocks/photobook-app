import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { PublishHeader } from "@/components/publish/PublishHeader";
import { PublishPanel } from "@/components/publish/PublishPanel";
import { buttonVariants } from "@/components/ui/button-variants";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyBookTitle } from "@/lib/db/books";
import { publishCompare } from "@/lib/publish/compare";
import { isPaymentsEnabled } from "@/lib/stripe";
import { getPublishState, publishBookAction, setBookPasswordAction, unpublishBookAction } from "./actions";

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

  const res = await getPublishState(id);
  if (!res.ok) {
    if (res.error === "signed_out") redirect(`/login?next=${encodeURIComponent(`/books/${id}/publish`)}`);
    if (res.error === "not_found") notFound();
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-gutter py-10" data-testid="publish-load-error">
        <h1 className="type-h1 text-foreground">We couldn&apos;t load this page</h1>
        <p className="type-body text-muted-foreground">Please check your connection and try again.</p>
        <Link href={`/books/${id}/publish`} className={buttonVariants({ variant: "default", size: "cta" })}>
          Try again
        </Link>
      </main>
    );
  }

  const title = (await getMyBookTitle(id).catch(() => null)) || "Our photobook";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-app flex-col gap-stack px-gutter pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-3">
      <PublishHeader bookId={id} title={title} />
      <Suspense fallback={null}>
        <UpgradeCancelledNotice />
      </Suspense>
      <PublishPanel
        bookId={id}
        paymentsEnabled={isPaymentsEnabled()}
        compare={publishCompare()}
        title={title}
        state={res.state}
        shared={shared}
        actions={{
          publish: publishBookAction.bind(null, id),
          unpublish: unpublishBookAction.bind(null, id),
          setPassword: setBookPasswordAction.bind(null, id),
        }}
      />
    </main>
  );
}
