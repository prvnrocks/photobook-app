// /b/[slug] 404 (unknown or unpublished slug). M23 T5: leather + cream card; the create link is
// the screen's one action, so it is the gold one.

import { SearchX } from "lucide-react";
import { ViewerMessage } from "@/components/viewer/public/ViewerMessage";
import { VW_CTA_GOLD } from "@/components/viewer/viewer-classes";
import { cx } from "@/lib/cx";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";

export default function BookNotFound() {
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
