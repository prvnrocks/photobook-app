import type { Metadata } from "next";
import Link from "next/link";
import { DemoVideo } from "@/components/marketing/DemoVideo";
import { ExampleBooks } from "@/components/marketing/ExampleBooks";
import { Faq } from "@/components/marketing/Faq";
import { HeroIllustration } from "@/components/marketing/HeroIllustration";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { Pricing } from "@/components/marketing/Pricing";
import { buttonVariants } from "@/components/ui/button";
import { APP_NAME } from "@/lib/brand";
import { CTA_HREF, CTA_LABEL, HERO_CLAIM, HERO_SUBCOPY, LANDING_DESCRIPTION, LANDING_TITLE } from "@/lib/marketing/copy";
import { hasDemoVideo } from "@/lib/marketing/demo";
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
  const showDemo = hasDemoVideo();
  return (
    <main className="flex flex-col">
      <section
        data-testid="section-hero"
        className="bg-gradient-to-b from-amber-50 via-background to-background"
      >
        <div className="mx-auto grid w-full max-w-5xl items-center gap-10 px-4 pt-10 pb-12 sm:px-6 md:grid-cols-2 md:pt-16">
          <div className="flex min-w-0 flex-col gap-5">
            <h1
              data-testid="hero-heading"
              className="font-heading text-[2rem] leading-tight font-semibold tracking-tight break-words sm:text-5xl"
            >
              {HERO_CLAIM}
            </h1>
            <p className="text-base text-muted-foreground sm:text-lg">{HERO_SUBCOPY}</p>
            <div className="flex flex-col gap-2">
              <Link
                href={CTA_HREF}
                data-testid="cta-create"
                className={cn(buttonVariants({ size: "lg" }), "h-12 w-full px-6 text-base sm:w-auto sm:self-start")}
              >
                {CTA_LABEL}
              </Link>
              <p className="text-sm text-muted-foreground">Free to try. No card needed.</p>
            </div>
          </div>
          <HeroIllustration />
        </div>
      </section>

      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-16 px-4 pt-6 pb-16 sm:px-6">
        {showDemo ? <DemoVideo /> : null}
        <HowItWorks />
        <ExampleBooks books={EXAMPLE_BOOKS} />
        <Pricing />
        <Faq />
      </div>
    </main>
  );
}
