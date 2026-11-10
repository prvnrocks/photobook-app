// Demo video slot. Rendered by the landing page only when the files exist (hasDemoVideo()).
// preload="none" + poster: nothing heavy downloads until the visitor presses play.
import { DEMO_POSTER_SRC, DEMO_VIDEO_SRC } from "@/lib/marketing/demo";

export function DemoVideo() {
  return (
    <section aria-label="Demo video" data-testid="section-demo" className="mx-auto w-full max-w-sm">
      <video
        className="aspect-[9/16] w-full rounded-2xl bg-muted object-cover shadow-lg"
        src={DEMO_VIDEO_SRC}
        poster={DEMO_POSTER_SRC}
        muted
        playsInline
        loop
        controls
        preload="none"
      />
    </section>
  );
}
