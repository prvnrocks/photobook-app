import Link from "next/link";
import { ViewerMessage, VIEWER_PRIMARY_LINK } from "@/components/viewer/public/ViewerMessage";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";

export default function BookNotFound() {
  return (
    <ViewerMessage title="We couldn't find this photobook" testId="book-not-found">
      <p className="text-sm text-neutral-600">
        The link may be mistyped, or the owner may have taken the book down.
      </p>
      <Link href={CREATE_YOURS_HREF} className={VIEWER_PRIMARY_LINK} data-testid="not-found-create">
        Create your own photobook
      </Link>
    </ViewerMessage>
  );
}
