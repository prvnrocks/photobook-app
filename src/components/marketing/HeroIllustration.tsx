// Decorative mock of an open flipbook for the hero (pure CSS, no images to download).
// Not a book render — real pages always go through <BookPage>. Captions use dir="auto"; the
// Arabic one is set in Cairo (font-arabic). "Photos" are soft gradients in the book palette
// (dusk / sea / sand / garden), the same scenes as the M11 style board.
import { HERO_SAMPLE_CAPTION_AR, HERO_SAMPLE_CAPTION_EN } from "@/lib/marketing/copy";

const DUSK = "linear-gradient(180deg,#2f3b55 0%,#8a6f7d 62%,#e2b48f 100%)";
const SEA = "linear-gradient(180deg,#c9d6dc 0%,#8fb0bd 62%,#e8dcc6 100%)";
const SAND = "linear-gradient(180deg,#e9d8c2 0%,#c9a27e 62%,#5e4a3c 100%)";
const GARDEN = "linear-gradient(180deg,#dfe5df 0%,#9fb3a0 62%,#566b5c 100%)";

function Photo({ bg, className }: { bg: string; className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-[2px] ${className ?? ""}`} style={{ background: bg }}>
      <span className="absolute top-[22%] right-[24%] size-[14%] rounded-full bg-white/50" />
    </div>
  );
}

export function HeroIllustration() {
  return (
    <div className="relative mx-auto w-full max-w-[20rem] select-none sm:max-w-sm" aria-label="Example album pages" role="img">
      <div className="grid rotate-[-1.5deg] grid-cols-2 overflow-hidden rounded-md bg-card shadow-lift ring-1 ring-black/5 motion-reduce:rotate-0">
        <div className="flex aspect-[148/210] flex-col gap-2 border-e border-black/5 p-3">
          <Photo bg={DUSK} className="min-h-0 flex-1" />
          <p dir="auto" className="shrink-0 font-display text-[0.7rem] leading-snug text-foreground/80">
            {HERO_SAMPLE_CAPTION_EN}
          </p>
        </div>
        <div className="flex aspect-[148/210] flex-col gap-2 p-3">
          <div className="grid min-h-0 flex-1 grid-rows-2 gap-2">
            <Photo bg={SEA} />
            <div className="grid grid-cols-2 gap-2">
              <Photo bg={GARDEN} />
              <Photo bg={SAND} />
            </div>
          </div>
          <p dir="auto" lang="ar" data-testid="sample-caption-ar" className="shrink-0 font-arabic text-[0.8rem] leading-snug text-foreground/80">
            {HERO_SAMPLE_CAPTION_AR}
          </p>
        </div>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-6 -translate-x-1/2 rotate-[-1.5deg] bg-gradient-to-r from-transparent via-black/10 to-transparent motion-reduce:rotate-0"
      />
    </div>
  );
}
