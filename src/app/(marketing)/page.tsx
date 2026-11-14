import type { Metadata } from "next";
import Link from "next/link";
import { Bookshelf } from "@/components/marketing/Bookshelf";
import { DemoVideo } from "@/components/marketing/DemoVideo";
import { ExampleBooks } from "@/components/marketing/ExampleBooks";
import { Faq } from "@/components/marketing/Faq";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { Pricing } from "@/components/marketing/Pricing";
import { AccountDeletedNotice } from "@/components/settings/AccountDeletedNotice";
import { buttonVariants } from "@/components/ui/button-variants";
import { APP_NAME } from "@/lib/brand";
import {
  CTA_HREF,
  HERO_CTA_LABEL,
  HERO_HEADLINE,
  HERO_SUBCOPY,
  LANDING_DESCRIPTION,
  LANDING_TITLE,
  SHELF_PREVIEW_CTA_LABEL,
} from "@/lib/marketing/copy";
import { getDemoVideo } from "@/lib/marketing/demo";
import { EXAMPLE_BOOKS } from "@/lib/marketing/examples";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} — ${LANDING_TITLE}` },
  description: LANDING_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: APP_NAME, title: `${APP_NAME} — ${LANDING_TITLE}`, description: LANDING_DESCRIPTION, url: "/" },
  twitter: { card: "summary_large_image", title: `${APP_NAME} — ${LANDING_TITLE}`, description: LANDING_DESCRIPTION },
};

export default function LandingPage() {
  const demo = getDemoVideo();
  return (
    <main className="flex flex-col">
      <div className="px-gutter sm:px-6">
        <AccountDeletedNotice />
      </div>
      {/* M14 hero: headline, one terracotta CTA, then the clickable bookshelf (client island). */}
      <section data-testid="section-hero" aria-labelledby="hero-heading" className="flex flex-col items-center overflow-x-clip pt-4 pb-2 sm:pt-3 lg:pt-1">
        <div className="flex w-full max-w-wide min-w-0 flex-col items-center gap-3 px-gutter text-center sm:gap-3.5 sm:px-6">
          <h1
            id="hero-heading"
            data-testid="hero-heading"
            className="type-display text-[2.5rem] leading-[1.05] text-balance break-words text-foreground sm:text-6xl sm:leading-[1.04] lg:text-[4.25rem]"
          >
            {HERO_HEADLINE}
          </h1>
          <p className="type-body max-w-2xl text-balance text-foreground/85 sm:text-[1.3rem] sm:leading-snug">{HERO_SUBCOPY}</p>
          <Link
            href={CTA_HREF}
            data-testid="cta-create"
            className={cn(buttonVariants({ variant: "accent", size: "cta" }), "mt-1 w-auto rounded-full px-10 text-lg sm:mt-2 sm:h-13 sm:px-12")}
          >
            {HERO_CTA_LABEL}
          </Link>
        </div>
        <div className="mt-5 w-full sm:mt-6">
          <Bookshelf
            previewCta={
              <Link
                href={CTA_HREF}
                data-testid="shelf-preview-cta"
                className={cn(buttonVariants({ variant: "accent", size: "cta" }), "rounded-full md:w-auto md:self-start md:px-8")}
              >
                {SHELF_PREVIEW_CTA_LABEL}
              </Link>
            }
          />
        </div>
      </section>

      <div className="mx-auto w-full max-w-wide min-w-0 px-gutter sm:px-6">
        <HowItWorks />
      </div>

      <div className="mx-auto flex w-full max-w-wide min-w-0 flex-col gap-section px-gutter pt-section pb-16 sm:gap-16 sm:px-6">
        {demo ? <DemoVideo video={demo} /> : null}
        <ExampleBooks books={EXAMPLE_BOOKS} />
        <Pricing />
        <Faq />
      </div>
    </main>
  );
}
