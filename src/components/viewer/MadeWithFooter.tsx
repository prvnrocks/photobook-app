// Free books only (D-040): small bar under the viewer "Made with Photobook — create yours".

import { MADE_WITH, APP_TAGLINE } from "@/lib/brand";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";

export function MadeWithFooter({ className }: { className?: string }) {
  return (
    <div
      className={`shrink-0 border-t border-primary bg-primary px-[max(0.75rem,env(safe-area-inset-left))] text-center text-xs text-primary-foreground/85 ${className ?? ""}`}
      data-testid="made-with-footer"
    >
      <a
        href={CREATE_YOURS_HREF}
        className="inline-flex min-h-11 items-center gap-1 rounded py-1 outline-none hover:text-primary-foreground focus-visible:ring-2 focus-visible:ring-primary-foreground"
      >
        {MADE_WITH} — <span className="font-semibold text-primary-foreground underline underline-offset-2">{APP_TAGLINE}</span>
      </a>
    </div>
  );
}
