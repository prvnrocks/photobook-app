import type { Metadata, Viewport } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { EditorShell } from "@/components/editor/EditorShell";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import { getCurrentUser } from "@/lib/auth/current-user";
import { touchWarnedDraft } from "@/lib/db/draft-activity";
import { getEditorData } from "@/lib/db/editor";
import { aiSummary } from "@/lib/editor/ai-summary";
import { editorRedirect, toEditorShellData } from "@/lib/editor/page-data";
import { isPaymentsEnabled } from "@/lib/stripe";
import { shareBookAction } from "../publish/actions";
import { EditorInvalid } from "./EditorInvalid";

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
    return <EditorInvalid bookId={data.book.id} />;
  }

  // Header "Share" (M13 T9): flush saves client-side, then publish + share screen (Memory Keeper
  // learns inside the publish action).
  const share = shareBookAction.bind(null, data.book.id);
  // "AI kept X of Y · See left out" (M13 T7): counts from the photos' kept/dropped status.
  const summary = aiSummary(shell.doc.meta?.generator, shell.photos);
  return (
    <>
      <EditorShell data={shell} share={share} paymentsEnabled={isPaymentsEnabled()} aiSummary={summary} />
      <Suspense fallback={null}>
        <UpgradeCancelledNotice floating />
      </Suspense>
    </>
  );
}
