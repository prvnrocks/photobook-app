// /b/[slug] when a free link has expired (D-002, D-039). Everyone sees the expiry + "Create your
// own"; the signed-in owner also sees "Upgrade to bring it back" (payments arrive in M7 — shown
// as coming soon) and a link back to the editor. No title or cover for anyone (D-040).

import Link from "next/link";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";
import { VIEWER_PRIMARY_LINK, VIEWER_SECONDARY_LINK, ViewerMessage } from "./ViewerMessage";

export function ExpiredBook({ isOwner, editorHref }: { isOwner: boolean; editorHref?: string | null }) {
  return (
    <ViewerMessage title="This photobook has expired" testId="expired-book">
      {isOwner ? (
        <>
          <p className="text-sm text-neutral-600">
            Free links stay open for 30 days. Your book is still safe in your account — upgrade it to bring the link
            back for good.
          </p>
          <button
            type="button"
            disabled
            aria-describedby="upgrade-soon"
            className={`${VIEWER_PRIMARY_LINK} cursor-not-allowed opacity-60`}
            data-testid="expired-upgrade"
          >
            Upgrade to bring it back
          </button>
          <p id="upgrade-soon" className="-mt-2 text-xs text-neutral-500">
            Coming soon
          </p>
          {editorHref ? (
            <Link href={editorHref} className={VIEWER_SECONDARY_LINK} data-testid="expired-open-editor">
              Open in editor
            </Link>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-sm text-neutral-600">
            The link to this book is no longer active. You can make a photobook of your own in a few minutes.
          </p>
          <Link href={CREATE_YOURS_HREF} className={VIEWER_PRIMARY_LINK} data-testid="expired-create">
            Create your own
          </Link>
        </>
      )}
    </ViewerMessage>
  );
}
