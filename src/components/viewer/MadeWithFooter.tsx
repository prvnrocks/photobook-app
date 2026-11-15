// Free books only (D-040): thin leather strip under the viewer "Made with Photobook — create yours"
// (M23: VW_FOOTER). The caller adds the bottom safe-area inset (it is the last row).

import { MADE_WITH, APP_TAGLINE } from "@/lib/brand";
import { cx } from "@/lib/cx";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";
import { VW_FOOTER, VW_FOOTER_LINK, VW_FOOTER_STRONG } from "./viewer-classes";

export function MadeWithFooter({ className }: { className?: string }) {
  return (
    <div className={cx(VW_FOOTER, className)} data-testid="made-with-footer">
      <a href={CREATE_YOURS_HREF} className={VW_FOOTER_LINK}>
        {MADE_WITH} — <span className={VW_FOOTER_STRONG}>{APP_TAGLINE}</span>
      </a>
    </div>
  );
}
