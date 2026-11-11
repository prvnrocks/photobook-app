import type { Metadata } from "next";
import Link from "next/link";
import { DemoVideo } from "@/components/marketing/DemoVideo";
import { ExampleBooks } from "@/components/marketing/ExampleBooks";
import { Faq } from "@/components/marketing/Faq";
import { HeroIllustration } from "@/components/marketing/HeroIllustration";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { Pricing } from "@/components/marketing/Pricing";
import { AccountDeletedNotice } from "@/components/settings/AccountDeletedNotice";
import { buttonVariants } from "@/components/ui/button-variants";
import { APP_NAME } from "@/lib/brand";
import {
  CTA_HREF,
  CTA_LABEL,
  CTA_NOTE,
  HERO_CLAIM,
  HERO_EYEBROW,
  HERO_SUBCOPY,
  LANDING_DESCRIPTION,
  LANDING_TITLE,
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
      <section data-testid="section-hero" className="border-b border-border bg-gradient-to-b from-secondary/70 to-background">
        <div className="mx-auto grid w-full max-w-wide items-center gap-10 px-gutter pt-10 pb-14 sm:px-6 md:grid-cols-2 md:pt-20 md:pb-20">
          <div className="flex min-w-0 flex-col gap-5">
            <p className="type-eyebrow">{HERO_EYEBROW}</p>
            <h1 data-testid="hero-heading" className="type-display break-words text-foreground lining-nums sm:text-5xl sm:leading-[1.08]">
              {HERO_CLAIM}
            </h1>
            <p className="type-body text-muted-foreground sm:text-lg">{HERO_SUBCOPY}</p>
            <div className="flex flex-col gap-2 pt-1">
              <Link
                href={CTA_HREF}
                data-testid="cta-create"
                className={cn(buttonVariants({ variant: "accent", size: "cta" }), "sm:w-auto sm:self-start sm:px-8")}
              >
                {CTA_LABEL}
              </Link>
              <p className="type-small text-muted-foreground">{CTA_NOTE}</p>
            </div>
          </div>
          <HeroIllustration />
        </div>
      </section>

      <div className="mx-auto flex w-full max-w-wide min-w-0 flex-col gap-section px-gutter pt-section pb-16 sm:gap-16 sm:px-6">
        {demo ? <DemoVideo video={demo} /> : null}
        <HowItWorks />
        <ExampleBooks books={EXAMPLE_BOOKS} />
        <Pricing />
        <Faq />
      </div>
    </main>
  );
}
