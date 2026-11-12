import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { EditorShell } from "@/components/editor/EditorShell";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import { buttonVariants } from "@/components/ui/button-variants";
import { getCurrentUser } from "@/lib/auth/current-user";
import { touchWarnedDraft } from "@/lib/db/draft-activity";
import { getEditorData } from "@/lib/db/editor";
import { editorRedirect, toEditorShellData } from "@/lib/editor/page-data";
import { isPaymentsEnabled } from "@/lib/stripe";
import { cn } from "@/lib/utils";
import { shareBookAction } from "../publish/actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Edit your book" };

// Full-height editor: let the toolbar sit above the iPhone home indicator (env(safe-area-inset-*)).
export const viewport: Viewport = { viewportFit: "cover" };

export default async function EditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/books/${id}/edit`)}`);

  const data = await getEditorData(id);
  if (!data) notFound();
  // Owner opened a warned draft: counts as activity (review S3). Never throws.
  await touchWarnedDraft(data.book.id, user.id);

  const to = editorRedirect(data);
  if (to) redirect(to);

  const shell = toEditorShellData(data);
  if (!shell) {
    // docError 'invalid': the stored album doesn't parse. Never show a half-broken editor.
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-10" data-testid="editor-invalid">
        <h1 className="text-2xl font-semibold">We can&apos;t open this album</h1>
        <p className="text-base text-muted-foreground">
          Something in this album&apos;s data doesn&apos;t look right, so the editor can&apos;t open it safely. Your photos
          are fine. You can go back to your photos and rebuild the album.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href={`/books/${data.book.id}/review`} className={cn(buttonVariants({ variant: "default" }), "h-11 px-4 text-base")}>
            Back to photos
          </Link>
          <Link href="/dashboard" className={cn(buttonVariants({ variant: "outline" }), "h-11 px-4 text-base")}>
            My books
          </Link>
        </div>
      </main>
    );
  }

  // Header "Share" (M13 T9): flush saves client-side, then publish + share screen (Memory Keeper
  // learns inside the publish action).
  const share = shareBookAction.bind(null, data.book.id);
  return (
    <>
      <EditorShell data={shell} share={share} paymentsEnabled={isPaymentsEnabled()} />
      <Suspense fallback={null}>
        <UpgradeCancelledNotice floating />
      </Suspense>
    </>
  );
}
