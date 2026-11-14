import type { Metadata } from "next";
import Link from "next/link";
import { Bookshelf } from "@/components/marketing/Bookshelf";
import { DemoVideo } from "@/components/marketing/DemoVideo";
import { ExampleBooks } from "@/components/marketing/ExampleBooks";
import { Faq } from "@/components/marketing/Faq";
import { HomeHero } from "@/components/marketing/HomeHero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { Marquee } from "@/components/marketing/Marquee";
import { Pricing } from "@/components/marketing/Pricing";
import { AccountDeletedNotice } from "@/components/settings/AccountDeletedNotice";
import { APP_NAME } from "@/lib/brand";
import {
  CTA_HREF,
  LANDING_DESCRIPTION,
  LANDING_TITLE,
  SHELF_PREVIEW_CTA_LABEL,
  SHELF_SECTION_TEXT,
  SHELF_SECTION_TITLE,
} from "@/lib/marketing/copy";
import { getDemoVideo } from "@/lib/marketing/demo";
import { EXAMPLE_BOOKS } from "@/lib/marketing/examples";

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} — ${LANDING_TITLE}` },
  description: LANDING_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: APP_NAME, title: `${APP_NAME} — ${LANDING_TITLE}`, description: LANDING_DESCRIPTION, url: "/" },
  twitter: { card: "summary_large_image", title: `${APP_NAME} — ${LANDING_TITLE}`, description: LANDING_DESCRIPTION },
};

const WRAP = "mx-auto w-full max-w-[80rem] min-w-0 px-gutter sm:px-6";

export default function LandingPage() {
  const demo = getDemoVideo();
  return (
    <main className="flex flex-col">
      {/* M15 Direction A: blush hero → benefits marquee → how it works → bookshelf → pricing → FAQ. */}
      <HomeHero notice={<AccountDeletedNotice />} />
      <Marquee />

      <div className={WRAP}>
        <HowItWorks />
      </div>

      <section
        data-testid="section-shelf"
        aria-labelledby="shelf-heading"
        className="mx-3 mt-16 overflow-x-clip rounded-[2.5rem] bg-[#ffd1ea] pt-12 pb-6 sm:mx-6 sm:mt-24 sm:rounded-[3.5rem] sm:pt-16 sm:pb-10"
      >
        <div className="flex flex-col items-center gap-3 px-gutter text-center sm:px-6">
          <h2 id="shelf-heading" className="font-brand text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] text-balance text-[#16121c] sm:text-6xl lg:text-7xl">
            {SHELF_SECTION_TITLE}
          </h2>
          <p className="max-w-xl text-lg leading-snug text-balance text-[#4a3b4d]">{SHELF_SECTION_TEXT}</p>
        </div>
        <div className="mt-6 w-full sm:mt-8">
          <Bookshelf
            previewCta={
              <Link
                href={CTA_HREF}
                data-testid="shelf-preview-cta"
                className="inline-flex h-12 w-full items-center justify-center rounded-full bg-[#d1006a] px-8 font-brand text-lg font-bold text-white shadow-[0_4px_0_#16121c] transition-[transform,box-shadow,background-color] outline-none hover:translate-y-[2px] hover:bg-[#b8005c] hover:shadow-[0_2px_0_#16121c] focus-visible:ring-[3px] focus-visible:ring-[#16121c] focus-visible:ring-offset-2 focus-visible:ring-offset-white motion-reduce:transition-none md:w-auto md:self-start"
              >
                {SHELF_PREVIEW_CTA_LABEL}
              </Link>
            }
          />
        </div>
      </section>

      <div className={`${WRAP} flex flex-col gap-20 pt-20 pb-20 sm:gap-28 sm:pt-28 sm:pb-28`}>
        {demo ? <DemoVideo video={demo} /> : null}
        <ExampleBooks books={EXAMPLE_BOOKS} />
        <Pricing />
        <Faq />
      </div>
    </main>
  );
}
