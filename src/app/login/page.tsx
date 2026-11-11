import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/LoginForm";
import { SiteWordmark } from "@/components/marketing/Wordmark";
import { APP_NAME } from "@/lib/brand";
import { safeNextPath } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/current-user";

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

const LEGAL_LINK =
  "rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  const error = first(params.error);

  if (await isSignedIn()) redirect(next);

  return (
    <div className="flex min-h-dvh flex-col bg-gradient-to-b from-secondary/70 via-background to-background">
      <div className="mx-auto flex h-14 w-full max-w-wide items-center px-gutter sm:px-6">
        <SiteWordmark />
      </div>
      <main className="mx-auto flex w-full max-w-sm min-w-0 flex-1 flex-col gap-6 px-gutter pt-6 pb-12 sm:justify-center sm:pt-0">
        <div className="flex min-w-0 flex-col gap-6 rounded-2xl border border-border bg-card px-5 py-7 shadow-lift sm:px-7">
          <header className="flex flex-col gap-2">
            <p className="type-eyebrow">Welcome</p>
            <h1 className="type-h1 break-words text-foreground">Sign in to {APP_NAME}</h1>
            <p className="type-body text-muted-foreground">No password needed. We&apos;ll email you a link and a code.</p>
          </header>
          <LoginForm next={next} error={error === "auth"} />
        </div>
        <p className="text-center text-xs text-muted-foreground" data-testid="login-legal">
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
