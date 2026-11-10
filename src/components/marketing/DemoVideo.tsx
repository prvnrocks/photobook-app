// Demo video slot. Rendered by the landing page only when the files exist (getDemoVideo()).
// preload="none" + poster: nothing heavy downloads until the visitor presses play.
import type { DemoVideoInfo } from "@/lib/marketing/demo";

export function DemoVideo({ video }: { video: DemoVideoInfo }) {
  return (
    <section aria-label="Demo video" data-testid="section-demo" className="mx-auto w-full max-w-sm">
      <video
        className="aspect-[375/812] w-full rounded-2xl bg-muted object-cover shadow-lg"
        poster={video.poster}
        muted
        playsInline
        loop
        controls
        preload="none"
      >
        <source src={video.src} type={video.type} />
      </video>
    </section>
  );
}
