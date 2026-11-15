// The viewer's 404 screen (unknown or unpublished slug). M23 T5: leather + cream card; the create
// link is the screen's one action, so it is the gold one. Server component, no client islands —
// shared by /b/[slug]/not-found.tsx and the dev-viewer ?state=notFound preview.

import { SearchX } from "lucide-react";
import { VW_CTA_GOLD } from "@/components/viewer/viewer-classes";
import { cx } from "@/lib/cx";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";
import { ViewerMessage } from "./ViewerMessage";

export function BookNotFoundScreen() {
  return (
    <ViewerMessage
      eyebrow="Link not found"
      title="We couldn't find this photobook"
      description="The link may be mistyped, or the owner may have taken the book down."
      icon={<SearchX className="size-6" />}
      testId="book-not-found"
    >
      <a href={CREATE_YOURS_HREF} className={cx(VW_CTA_GOLD, "w-full")} data-testid="not-found-create">
        Create your own photobook
      </a>
    </ViewerMessage>
  );
}
