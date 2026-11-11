// Publish screen header (M11 T15, D-067): back to the editor, "Step 6 of 6: Share", the book title
// as an eyebrow (user text → dir="auto") and the serif page title. Shared by the real page and the
// /dev-publish fixture so screenshots show the real header.

import { PageHeader } from "@/components/app/PageHeader";
import { flowStepForRoute } from "@/lib/app/flow-steps";

const SHARE_STEP = flowStepForRoute("publish") ?? "share";

export function PublishHeader({ bookId, title }: { bookId: string; title: string }) {
  return (
    <PageHeader
      back={{ href: `/books/${bookId}/edit`, label: "Back to editor", testId: "publish-back" }}
      step={SHARE_STEP}
      // "text" eyebrow, not the tracked label: letter-spacing would break Arabic joining in titles.
      eyebrow={title}
      eyebrowVariant="text"
      eyebrowTestId="publish-title"
      title="Share your book"
    />
  );
}
