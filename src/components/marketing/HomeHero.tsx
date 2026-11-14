// Home hero, Direction A "Confetti" (M15): blush stage with soft blobs and paper confetti, one giant
// headline, the pink "Make my book" pill, and a real book bursting out of the bottom-right edge
// (under the CTA and cropped by the rounded bottom on phones). Server component: no client JS.
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CTA_HREF, HERO_CTA_LABEL, HERO_HEADLINE, HERO_STICKER, HERO_SUBCOPY, HERO_TAG_LINE } from "@/lib/marketing/copy";
import { HERO_BOOK, STICKER_POINTS } from "@/lib/marketing/hero";
import { SHELF_BOOKS } from "@/lib/marketing/shelf";
import { HeroConfetti } from "./HeroConfetti";

/** The Arabic sample title (Family Reunion on the shelf) shown on the desktop paper tag. */
const ARABIC_SAMPLE = SHELF_BOOKS.find((b) => b.arabic)?.arabic?.title;

/** Desktop-only paper tag at the bottom left (balances the book): Arabic title in Lalezar + one line. */
function HeroTag({ title }: { title: string }) {
  return (
    <div className="absolute bottom-[13%] left-[6%] hidden w-[15.5rem] -rotate-[7deg] rounded-[1.25rem] bg-white px-6 pt-7 pb-5 shadow-[0_5px_0_#16121c] ring-2 ring-[#16121c] lg:block xl:left-[8%]">
      <span aria-hidden="true" className="absolute -top-3 left-1/2 h-6 w-20 -translate-x-1/2 rotate-[4deg] rounded-[3px] bg-[#ffc93c]/80" />
      <p lang="ar" className="text-center font-brand-ar text-[2.6rem] leading-[1.15] text-[#16121c]">
        <span dir="auto">{title}</span>
      </p>
      <p className="mt-1 text-center text-[0.95rem] leading-snug font-semibold text-balance text-[#4a3b4d]">{HERO_TAG_LINE}</p>
    </div>
  );
}

export function HomeHero({ notice }: { notice?: ReactNode }) {
  return (
    <section
      data-testid="section-hero"
      aria-labelledby="hero-heading"
      className="relative isolate overflow-hidden rounded-b-[2.5rem] bg-[#ffd1ea] pt-[4.75rem] text-[#16121c] sm:rounded-b-[4rem]"
    >
      {/* soft organic blobs */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <span className="home-blob absolute top-[44%] -left-[30%] h-[78%] w-[110%] bg-[#ffb3da] sm:top-[40%] sm:-left-[18%] sm:w-[80%] lg:top-[34%] lg:h-[90%] lg:w-[62%]" />
        <span className="home-blob absolute -top-[12%] -right-[34%] h-[46%] w-[80%] bg-[#ffb3da]/80 [animation-delay:-9s] sm:-right-[16%] sm:w-[50%] lg:-top-[18%] lg:h-[62%] lg:w-[40%]" />
        <span className="home-blob absolute top-[58%] -right-[10%] hidden h-[60%] w-[38%] bg-[#ffc2e2] [animation-delay:-4s] lg:block" />
      </div>
      <HeroConfetti layer="back" className="-z-10" />

      <div className="relative mx-auto flex w-full max-w-[80rem] min-w-0 flex-col items-center px-gutter pt-8 text-center sm:px-6 sm:pt-14 lg:min-h-[40rem] lg:pt-16 lg:pb-44">
        {notice}
        <h1
          id="hero-heading"
          data-testid="hero-heading"
          className="max-w-[12ch] font-brand text-[clamp(4rem,9vw+2.5rem,10.5rem)] leading-[0.86] font-extrabold tracking-[-0.035em] text-balance lg:tracking-[-0.028em] break-words"
        >
          {HERO_HEADLINE}
        </h1>
        <p className="mt-5 max-w-[30rem] text-lg leading-snug font-medium text-balance text-[#4a3b4d] sm:mt-7 sm:max-w-[36rem] sm:text-2xl sm:leading-snug">
          {HERO_SUBCOPY}
        </p>
        <Link
          href={CTA_HREF}
          data-testid="cta-create"
          className="mt-7 inline-flex h-14 items-center gap-3 rounded-full bg-accent-strong text-accent-strong-foreground ps-7 pe-2 font-brand text-lg font-bold tracking-[-0.01em] shadow-[0_5px_0_#16121c] transition-[transform,box-shadow,background-color] outline-none hover:translate-y-[2px] hover:bg-[#b8005c] hover:shadow-[0_3px_0_#16121c] focus-visible:ring-[3px] focus-visible:ring-[#16121c] focus-visible:ring-offset-[3px] focus-visible:ring-offset-[#ffd1ea] active:translate-y-[5px] active:shadow-none motion-reduce:transition-none sm:mt-9 sm:h-16 sm:ps-9 sm:text-xl"
        >
          {HERO_CTA_LABEL}
          <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-white text-[#16121c] sm:size-12">
            <ArrowRight className="size-5 stroke-[2.5]" />
          </span>
        </Link>
      </div>

      {/* The real book: in the flow under the CTA on phones/tablets, bursting out bottom-right on desktop. */}
      <div className="relative mx-auto mt-12 -mb-[24%] w-[min(76%,21rem)] rotate-[7deg] sm:mt-14 sm:-mb-[13%] sm:w-[22rem] lg:absolute lg:right-[6%] lg:bottom-[-8rem] lg:mx-0 lg:mt-0 lg:mb-0 lg:w-[clamp(19rem,25vw,25rem)] lg:rotate-[10deg]">
        {/* eslint-disable-next-line @next/next/no-img-element -- one hero image with fixed natural size; swap in HERO_BOOK */}
        <img
          src={HERO_BOOK.src}
          width={HERO_BOOK.w}
          height={HERO_BOOK.h}
          alt={HERO_BOOK.alt}
          loading="eager"
          fetchPriority="high"
          decoding="async"
          draggable={false}
          className="block h-auto w-full drop-shadow-[0_28px_28px_rgb(22_18_28/0.3)] select-none"
        />
        <div className="absolute -top-6 -left-8 size-[5.75rem] -rotate-[22deg] sm:-left-12 sm:size-28 lg:-top-8 lg:-left-14 lg:size-32">
          <svg aria-hidden="true" viewBox="0 0 100 100" className="absolute inset-0 size-full drop-shadow-[0_4px_0_#16121c]">
            <polygon points={STICKER_POINTS} fill="#ff1f84" />
          </svg>
          <p className="relative flex size-full flex-col items-center justify-center text-center font-brand text-[1.15rem] leading-[0.92] font-extrabold tracking-[-0.02em] text-[#16121c] sm:text-[1.35rem] lg:text-[1.55rem]">
            {HERO_STICKER.map((line) => (
              <span key={line} className="block whitespace-nowrap">
                {line}
              </span>
            ))}
          </p>
        </div>
        <HeroConfetti layer="front" />
      </div>
      {ARABIC_SAMPLE ? <HeroTag title={ARABIC_SAMPLE} /> : null}
    </section>
  );
}
