// /b/[slug] when the book exists but can't be shown right now (snapshot fails the public schema,
// or the database is unreachable). Never renders any book content.
// M23 T5: the create link is a side door here (the real answer is "try again later"), so it is the
// emerald outline, not gold (gold: password / expired / not-found only).

import { CloudOff } from "lucide-react";
import { VW_CTA_EMERALD_OUTLINE } from "@/components/viewer/viewer-classes";
import { cx } from "@/lib/cx";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";
import { ViewerMessage } from "./ViewerMessage";

export function BookUnavailable() {
  return (
    <ViewerMessage
      eyebrow="Temporarily unavailable"
      title="This photobook can't be shown right now"
      description="Please try again in a little while."
      icon={<CloudOff className="size-6" />}
      testId="book-unavailable"
    >
      <a href={CREATE_YOURS_HREF} className={cx(VW_CTA_EMERALD_OUTLINE, "w-full")}>
        Create your own photobook
      </a>
    </ViewerMessage>
  );
}
