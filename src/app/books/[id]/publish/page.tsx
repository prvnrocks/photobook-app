import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PublishPanel } from "@/components/publish/PublishPanel";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyBookTitle } from "@/lib/db/books";
import { getPublishState, publishBookAction, setBookPasswordAction, unpublishBookAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Share your book" };

export default async function PublishPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/books/${id}/publish`)}`);

  const res = await getPublishState(id);
  if (!res.ok) {
    if (res.error === "signed_out") redirect(`/login?next=${encodeURIComponent(`/books/${id}/publish`)}`);
    if (res.error === "not_found") notFound();
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-10" data-testid="publish-load-error">
        <h1 className="text-2xl font-semibold">We couldn&apos;t load this page</h1>
        <p className="text-base text-muted-foreground">Please check your connection and try again.</p>
        <Link href={`/books/${id}/publish`} className="min-h-11 font-medium underline underline-offset-4">
          Try again
        </Link>
      </main>
    );
  }

  const title = (await getMyBookTitle(id).catch(() => null)) || "Our photobook";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-3">
      <header className="flex items-center gap-1">
        <Link
          href={`/books/${id}/edit`}
          className="-ml-2 flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium hover:bg-muted"
          data-testid="publish-back"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to editor
        </Link>
      </header>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">Share your book</h1>
        <p dir="auto" className="truncate text-sm text-muted-foreground" data-testid="publish-title">
          {title}
        </p>
      </div>
      <PublishPanel
        bookId={id}
        title={title}
        state={res.state}
        actions={{
          publish: publishBookAction.bind(null, id),
          unpublish: unpublishBookAction.bind(null, id),
          setPassword: setBookPasswordAction.bind(null, id),
        }}
      />
    </main>
  );
}
