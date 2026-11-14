import type { Metadata } from "next";
import { DemoVideo } from "@/components/marketing/DemoVideo";
import { ExampleBooks } from "@/components/marketing/ExampleBooks";
import { Faq } from "@/components/marketing/Faq";
import { HomeHero } from "@/components/marketing/HomeHero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { Marquee } from "@/components/marketing/Marquee";
import { Pricing } from "@/components/marketing/Pricing";
import { AccountDeletedNotice } from "@/components/settings/AccountDeletedNotice";
import { APP_NAME } from "@/lib/brand";
import { LANDING_DESCRIPTION, LANDING_TITLE } from "@/lib/marketing/copy";
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
      {/* M16 Emerald & gold: leather hero → foil marquee → how it works → pricing → FAQ (shelf removed). */}
      <HomeHero notice={<AccountDeletedNotice />} />
      <Marquee />

      <div className={WRAP}>
        <HowItWorks />
      </div>

      <div className={`${WRAP} flex flex-col gap-20 pt-20 pb-20 sm:gap-28 sm:pt-28 sm:pb-28`}>
        {demo ? <DemoVideo video={demo} /> : null}
        <ExampleBooks books={EXAMPLE_BOOKS} />
        <Pricing />
        <Faq />
      </div>
    </main>
  );
}
