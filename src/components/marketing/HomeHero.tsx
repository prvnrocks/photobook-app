// Home hero (M15 structure, M16 "Emerald & gold"): deep emerald leather framed by two gold foil rules
// (the reference menu cover), small caps eyebrow over a gold hairline, the headline with its last
// words in foil, the gold "Make my book" pill, and a real book bursting out of the bottom-right edge
// with a foil seal. A cream card carries the Arabic sample title. Server component: no client JS.
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  CTA_HREF,
  HERO_CTA_LABEL,
  HERO_EYEBROW,
  HERO_HEADLINE_ACCENT,
  HERO_HEADLINE_LEAD,
  HERO_SEAL,
  HERO_SUBCOPY,
  HERO_TAG_LINE,
  HERO_TAG_TITLE_AR,
} from "@/lib/marketing/copy";
import { HERO_BOOK } from "@/lib/marketing/hero";
import { HeroFlecks } from "./HeroFlecks";

/**
 * Cream card with a gold foil frame: the Arabic sample title in Lalezar + one line. Bottom-left of the
 * stage at every width, balancing the book (which sits right of centre on phones to make room).
 */
function HeroTag() {
  return (
    <div
      data-testid="hero-tag"
      className="absolute bottom-[3.5%] left-[4%] z-10 w-[8.75rem] -rotate-[5deg] rounded-[0.4rem] bg-[#f2e8d8] px-3 pt-4 pb-3.5 shadow-[0_22px_34px_-14px_rgb(0_0_0/0.7)] sm:bottom-[9%] sm:left-[5%] sm:w-[11.5rem] sm:px-5 sm:pt-6 sm:pb-5 lg:bottom-[13%] lg:left-[6%] lg:w-[15rem] lg:-rotate-[4deg] xl:left-[8%]"
    >
      <span aria-hidden="true" className="pointer-events-none absolute inset-[5px] rounded-[0.2rem] border border-[#c9a227]/70" />
      <p lang="ar" data-testid="hero-tag-ar" className="text-center font-brand-ar text-[1.85rem] leading-[1.15] text-[#0e3b2e] sm:text-[2.3rem] lg:text-[2.6rem]">
        <span dir="auto">{HERO_TAG_TITLE_AR}</span>
      </p>
      <span aria-hidden="true" className="home-foil-h mx-auto mt-1.5 mb-2 block h-px w-10 sm:mt-2 sm:mb-2.5 sm:w-12" />
      <p className="text-center text-[0.62rem] leading-snug font-semibold tracking-[0.16em] text-balance text-[#4a4740] uppercase sm:text-[0.7rem]">
        {HERO_TAG_LINE}
      </p>
    </div>
  );
}

/** Round gold foil seal on the book's corner (top-right on phones, clear of the Arabic card; top-left from sm): small caps in ink (≥ 6.09:1 on the darkest foil). */
function HeroSeal() {
  return (
    <div className="home-seal absolute -top-6 -right-4 flex size-[4.75rem] rotate-[10deg] sm:right-auto sm:-rotate-[14deg] items-center justify-center rounded-full shadow-[0_10px_20px_-8px_rgb(0_0_0/0.6)] sm:-left-8 sm:size-24 sm:-top-5 lg:-top-7 lg:-left-10 lg:size-[6.5rem]">
      <span aria-hidden="true" className="absolute inset-[4px] rounded-full border border-[#1b1b1d]/40 sm:inset-[5px]" />
      <span aria-hidden="true" className="absolute inset-[7px] rounded-full border border-dashed border-[#1b1b1d]/25 sm:inset-[9px]" />
      <p className="relative flex flex-col items-center text-center text-[0.62rem] leading-[1.25] font-bold tracking-[0.2em] text-[#1b1b1d] uppercase sm:text-[0.75rem] lg:text-[0.82rem]">
        {HERO_SEAL.map((line) => (
          <span key={line} className="block whitespace-nowrap ps-[0.2em]">
            {line}
          </span>
        ))}
      </p>
    </div>
  );
}

export function HomeHero({ notice }: { notice?: ReactNode }) {
  return (
    <section
      data-testid="section-hero"
      aria-labelledby="hero-heading"
      className="home-leather relative isolate overflow-hidden rounded-b-[2rem] pt-[4.75rem] text-[#f2e8d8] sm:rounded-b-[3rem]"
    >
      {/* the two gold foil rules of the reference cover */}
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute top-[4.25rem] bottom-0 left-3 -z-10 w-px sm:left-6 lg:left-[3.5%]" />
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute top-[4.25rem] bottom-0 right-3 -z-10 w-px sm:right-6 lg:right-[3.5%]" />
      <HeroFlecks layer="back" className="-z-10" />

      <div className="relative mx-auto flex w-full max-w-[80rem] min-w-0 flex-col items-center px-gutter pt-10 text-center sm:px-6 sm:pt-16 lg:min-h-[40rem] lg:pt-20 lg:pb-44">
        {notice}
        <p className="flex flex-col items-center text-[0.7rem] font-semibold tracking-[0.32em] text-[#e3c766] uppercase sm:text-xs">
          <span className="ps-[0.32em]">{HERO_EYEBROW}</span>
          <span aria-hidden="true" className="home-foil-h mt-3 block h-px w-12" />
        </p>
        <h1
          id="hero-heading"
          data-testid="hero-heading"
          className="mt-5 max-w-[12ch] font-brand text-[clamp(3.6rem,8vw+2rem,9.25rem)] leading-[0.9] font-light tracking-[-0.035em] text-balance break-words sm:mt-7"
        >
          {HERO_HEADLINE_LEAD}
          <span className="home-foil-text font-normal">{HERO_HEADLINE_ACCENT}</span>
        </h1>
        <p className="mt-6 max-w-[30rem] text-lg leading-snug text-balance text-[#d7cdb9] sm:mt-8 sm:max-w-[36rem] sm:text-xl sm:leading-snug">{HERO_SUBCOPY}</p>
        <Link
          href={CTA_HREF}
          data-testid="cta-create"
          className="home-foil-fill mt-8 inline-flex h-14 items-center gap-3 rounded-full ps-7 pe-2 font-brand text-lg font-semibold tracking-[0.005em] text-[#1b1b1d] shadow-[0_16px_32px_-14px_rgb(0_0_0/0.75),inset_0_1px_0_rgb(255_255_255/0.4)] transition-[filter,transform] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[#f2e8d8] focus-visible:ring-offset-[3px] focus-visible:ring-offset-[#0e3b2e] active:translate-y-px motion-reduce:transition-none sm:mt-10 sm:h-16 sm:ps-9 sm:text-xl"
        >
          {HERO_CTA_LABEL}
          <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-[#1b1b1d] text-[#e3c766] sm:size-12">
            <ArrowRight className="size-5 stroke-[2]" />
          </span>
        </Link>
      </div>

      {/* The real book: in the flow under the CTA on phones/tablets, bursting out bottom-right on desktop. */}
      <div className="relative ms-auto me-[8%] mt-12 -mb-[20%] w-[min(62%,15.5rem)] rotate-[6deg] sm:mx-auto sm:mt-16 sm:-mb-[13%] sm:w-[22rem] lg:absolute lg:right-[7%] lg:bottom-[-8rem] lg:mx-0 lg:mt-0 lg:mb-0 lg:w-[clamp(19rem,25vw,25rem)] lg:rotate-[8deg]">
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
          className="block h-auto w-full drop-shadow-[0_30px_30px_rgb(0_0_0/0.5)] select-none"
        />
        <HeroSeal />
        <HeroFlecks layer="front" />
      </div>
      <HeroTag />
    </section>
  );
}
