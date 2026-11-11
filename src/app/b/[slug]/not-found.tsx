import Link from "next/link";
import { ViewerMessage, VIEWER_PRIMARY_LINK } from "@/components/viewer/public/ViewerMessage";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";

export default function BookNotFound() {
  return (
    <ViewerMessage
      title="We couldn't find this photobook"
      description="The link may be mistyped, or the owner may have taken the book down."
      testId="book-not-found"
    >
      <Link href={CREATE_YOURS_HREF} className={VIEWER_PRIMARY_LINK} data-testid="not-found-create">
        Create your own photobook
      </Link>
    </ViewerMessage>
  );
}
