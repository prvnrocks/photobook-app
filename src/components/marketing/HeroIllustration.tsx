// Decorative mock of an open flipbook for the hero (pure CSS, no images to download).
// Not a book render — real pages always go through <BookPage>. Captions use dir="auto"; the
// Arabic one is set in Cairo (font-arabic).
import { HERO_SAMPLE_CAPTION_AR, HERO_SAMPLE_CAPTION_EN } from "@/lib/marketing/copy";

export function HeroIllustration() {
  return (
    <div className="relative mx-auto w-full max-w-[20rem] select-none sm:max-w-sm" aria-label="Example album pages" role="img">
      <div className="grid grid-cols-2 overflow-hidden rounded-xl bg-white shadow-xl ring-1 ring-black/5">
        <div className="flex aspect-[148/210] flex-col gap-2 border-r border-black/5 p-3">
          <div className="flex-1 rounded-sm bg-gradient-to-br from-amber-200 via-orange-300 to-rose-400" />
          <p dir="auto" className="text-[0.7rem] leading-snug text-neutral-700 [font-family:var(--font-playfair),serif]">
            {HERO_SAMPLE_CAPTION_EN}
          </p>
        </div>
        <div className="flex aspect-[148/210] flex-col gap-2 p-3">
          <div className="grid flex-1 grid-rows-2 gap-2">
            <div className="rounded-sm bg-gradient-to-br from-sky-200 to-sky-500" />
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-sm bg-gradient-to-br from-emerald-200 to-teal-500" />
              <div className="rounded-sm bg-gradient-to-br from-yellow-100 to-amber-400" />
            </div>
          </div>
          <p
            dir="auto"
            lang="ar"
            data-testid="sample-caption-ar"
            className="font-arabic text-[0.8rem] leading-snug text-neutral-700"
          >
            {HERO_SAMPLE_CAPTION_AR}
          </p>
        </div>
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-6 -translate-x-1/2 bg-gradient-to-r from-transparent via-black/10 to-transparent" />
    </div>
  );
}
