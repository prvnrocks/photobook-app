// Test helper (M21 T5): <PublishPanelView> with the server slots built the way the share page does
// (shareSlots, router-free). Accepts the pre-slot props (compare, preview data, pdfTransport) so
// panel tests read like the page. Like the page, a preview is always rendered (it carries the one
// publish-open); pass preview={null} to render the panel without it.
import type { ComponentProps } from "react";
import type { PublishPreview } from "@/app/books/[id]/publish/actions";
import { PublishPanelView } from "@/components/publish/PublishPanel";
import { shareSlots } from "@/components/publish/share-slots";
import type { PdfTransport } from "@/lib/pdf/ui";
import type { PublishCompare } from "@/lib/publish/compare";

export type SharePanelProps = Omit<ComponentProps<typeof PublishPanelView>, "preview" | "plan" | "pdf"> & {
  compare: PublishCompare;
  preview?: PublishPreview | null;
  pdfTransport?: PdfTransport;
};

export const TEST_PREVIEW: PublishPreview = { coverThumbUrl: null, format: "A5_PORTRAIT", designStyle: "classic" };

export function SharePanel({ compare, preview = TEST_PREVIEW, pdfTransport, ...props }: SharePanelProps) {
  const slots = shareSlots({
    bookId: props.bookId,
    title: props.title,
    state: props.state,
    preview,
    compare,
    paymentsEnabled: props.paymentsEnabled,
    now: props.now,
    refresh: props.refresh,
    pdfTransport,
  });
  return <PublishPanelView {...props} preview={slots.preview} plan={slots.plan} pdf={slots.pdf} />;
}
