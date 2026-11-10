// Free books only (D-040): small bar under the viewer "Made with Photobook — create yours".

import { MADE_WITH, APP_TAGLINE } from "@/lib/brand";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";

export function MadeWithFooter({ className }: { className?: string }) {
  return (
    <div
      className={`shrink-0 border-t bg-neutral-900 px-[max(0.75rem,env(safe-area-inset-left))] text-center text-xs text-white/80 ${className ?? ""}`}
      data-testid="made-with-footer"
    >
      <a href={CREATE_YOURS_HREF} className="inline-flex min-h-8 items-center gap-1 py-1.5 hover:text-white">
        {MADE_WITH} — <span className="font-semibold text-white underline underline-offset-2">{APP_TAGLINE}</span>
      </a>
    </div>
  );
}
