// /login (M25, D-077): emerald leather + cream sign-in card.
// Phones: full-bleed leather, cream wordmark on top, the card centred under it (like the viewer's
// password screen). ≥lg: two columns — a leather brand panel (wordmark, home eyebrow + headline +
// subcopy, the home hero's book floating, decorative) and the cream card on a cream panel that curves
// into the leather. Server component: everything here is static markup; the only client island is
// LoginForm (recipes in login-classes.ts). The page's own classes stay inline so none of them ship.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/LoginForm";
import { SiteWordmark } from "@/components/marketing/Wordmark";
import { APP_NAME } from "@/lib/brand";
import { safeNextPath } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/current-user";
import { HERO_EYEBROW, HERO_HEADLINE_ACCENT, HERO_HEADLINE_LEAD, HERO_SUBCOPY } from "@/lib/marketing/copy";
import { HERO_BOOK } from "@/lib/marketing/hero";

export const metadata: Metadata = { title: "Sign in" };

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function isSignedIn(): Promise<boolean> {
  try {
    return Boolean(await getCurrentUser());
  } catch {
    // Missing env / network: treat as signed out so the form still renders.
    return false;
  }
}

/** Cream wordmark on the leather (7.19:1 at its lightest point), gold focus ring. */
const WORDMARK = "text-[#f2e8d8] focus-visible:ring-[#e3c766] focus-visible:ring-offset-[#0e3b2e]";

/**
 * Terms / Privacy: cream on the leather (phones), emerald on the cream panel (≥lg). Inline links in a
 * sentence (WCAG 2.5.8 inline exception).
 */
const LEGAL_LINK =
  "rounded-sm font-medium text-[#f2e8d8] underline underline-offset-4 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-[#e3c766] lg:text-[#0e3b2e] lg:hover:text-[#145240] lg:focus-visible:ring-[#0e3b2e]";

/** The ≥lg brand panel: the home hero's eyebrow, headline and subcopy beside a floating book. */
function BrandPanel() {
  return (
    <div
      data-testid="login-brand"
      className="relative hidden min-h-dvh min-w-0 flex-col px-12 pt-6 pb-12 lg:flex xl:px-16"
    >
      {/* the gold foil rule of the home cover */}
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute top-20 bottom-10 left-6 w-px xl:left-8" />
      <div className="flex h-14 items-center">
        <SiteWordmark className={WORDMARK} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-10 py-10">
        <div className="max-w-[30rem]">
          <p className="flex flex-col items-start text-xs font-semibold tracking-[0.32em] text-[#e3c766] uppercase">
            <span>{HERO_EYEBROW}</span>
            <span aria-hidden="true" className="home-foil-h mt-3 block h-px w-12" />
          </p>
          <p className="mt-6 font-display text-[clamp(2.75rem,3.6vw+0.5rem,4.25rem)] leading-[1.02] font-semibold tracking-[-0.01em] text-balance text-[#f2e8d8]">
            {HERO_HEADLINE_LEAD}
            <span className="home-foil-text">{HERO_HEADLINE_ACCENT}</span>
          </p>
          <p className="mt-5 max-w-[26rem] text-lg leading-snug text-[#d7cdb9]">{HERO_SUBCOPY}</p>
        </div>
        {/* Decorative: the home hero's book, tilted, bobbing gently (home-float — static under reduced motion). */}
        <div aria-hidden="true" data-testid="login-book" className="ms-[12%] w-[clamp(12rem,17vw,16rem)] rotate-[6deg]">
          {/* eslint-disable-next-line @next/next/no-img-element -- one static decorative image (next/image would add client JS); lazy, so phones (hidden panel) never fetch it */}
          <img
            src={HERO_BOOK.src}
            width={HERO_BOOK.w}
            height={HERO_BOOK.h}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className="home-float block h-auto w-full drop-shadow-[0_28px_26px_rgb(0_0_0/0.5)] select-none"
          />
        </div>
      </div>
    </div>
  );
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  const error = first(params.error);

  if (await isSignedIn()) redirect(next);

  return (
    <div className="home-leather flex min-h-dvh w-full min-w-0 flex-col overflow-x-clip lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="flex h-14 shrink-0 items-center px-gutter sm:px-6 lg:hidden">
        <SiteWordmark className={WORDMARK} />
      </div>
      <BrandPanel />
      <main className="flex w-full min-w-0 flex-1 flex-col items-center px-gutter pt-4 pb-10 sm:justify-center sm:px-6 sm:pt-0 lg:min-h-dvh lg:rounded-s-[2.5rem] lg:bg-[#f4ede0] lg:bg-[radial-gradient(ellipse_80%_60%_at_50%_45%,#fbf7ef_0%,#f4ede0_70%)] lg:px-12 lg:py-12 lg:shadow-[-30px_0_60px_-40px_rgb(0_0_0/0.7)]">
        <div className="flex w-full max-w-md min-w-0 flex-col gap-6 rounded-3xl bg-[#fffdf8] px-5 py-7 text-[#1b1b1d] shadow-[0_30px_60px_-30px_rgb(0_0_0/0.65)] ring-1 ring-[#e3c766]/30 sm:px-8 sm:py-9 lg:shadow-[0_30px_60px_-34px_rgb(14_59_46/0.45)] lg:ring-[#e3d8c3]">
          <header className="flex flex-col gap-2">
            <p className="text-[0.7rem] font-semibold tracking-[0.24em] text-[#7a5f0e] uppercase">Welcome</p>
            <h1 className="font-display text-[1.75rem] leading-tight font-semibold break-words text-[#0e3b2e] sm:text-3xl">
              Sign in to {APP_NAME}
            </h1>
            <p className="text-base leading-relaxed text-[#4a4740]">No password needed. We&apos;ll email you a link and a code.</p>
          </header>
          <LoginForm next={next} error={error === "auth"} />
        </div>
        <p className="mt-6 max-w-md text-center text-xs leading-relaxed text-[#d7cdb9] lg:text-[#4a4740]" data-testid="login-legal">
          By continuing you agree to the{" "}
          <Link href="/terms" className={LEGAL_LINK}>
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className={LEGAL_LINK}>
            Privacy Policy
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
