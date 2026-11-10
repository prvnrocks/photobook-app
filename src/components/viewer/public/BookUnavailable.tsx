// /b/[slug] when the book exists but can't be shown right now (snapshot fails the public schema,
// or the database is unreachable). Never renders any book content.

import Link from "next/link";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";
import { VIEWER_SECONDARY_LINK, ViewerMessage } from "./ViewerMessage";

export function BookUnavailable() {
  return (
    <ViewerMessage title="This photobook can't be shown right now" testId="book-unavailable">
      <p className="text-sm text-neutral-600">Please try again in a little while.</p>
      <Link href={CREATE_YOURS_HREF} className={VIEWER_SECONDARY_LINK}>
        Create your own photobook
      </Link>
    </ViewerMessage>
  );
}
