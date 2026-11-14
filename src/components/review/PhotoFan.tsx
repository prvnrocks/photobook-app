// Fanned stack of three photos for the wizard's "Sorting your photos" step (M19 T7, D-071; layout
// after wizard.png). Server component, no hooks. Photos are the draft album's already-signed 512 px
// thumbs; missing ones are soft placeholders. Gentle tilt; the fade/zoom entrance only runs when the
// user allows motion (motion-safe). Decorative: the headline + checklist carry the meaning.
import { ImageIcon } from "lucide-react";

const TILT = ["-rotate-6 translate-y-2", "z-10 -translate-y-1 scale-105", "rotate-6 translate-y-2"] as const;

export function PhotoFan({ urls }: { urls: readonly string[] }) {
  return (
    <div
      aria-hidden="true"
      className="mx-auto flex w-full max-w-sm items-center justify-center px-3 py-4 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-500"
      data-testid="build-photo-fan"
      data-count={urls.length}
    >
      {TILT.map((tilt, i) => {
        const url = urls[i];
        return (
          <div
            key={i}
            className={`relative -mx-[3%] aspect-[4/5] w-[36%] shrink-0 rounded-sm bg-card p-1.5 shadow-card ring-1 ring-foreground/10 ${tilt}`}
            data-testid="build-photo-fan-item"
          >
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed thumb URL
              <img src={url} alt="" decoding="async" className="size-full rounded-[1px] bg-muted object-cover" />
            ) : (
              <span className="flex size-full items-center justify-center rounded-[1px] bg-secondary text-primary/40">
                <ImageIcon className="size-8" strokeWidth={1.5} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
