import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/LoginForm";
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

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  const error = first(params.error);

  if (await isSignedIn()) redirect(next);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm min-w-0 flex-col gap-6 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight break-words">
          Sign in to Photobook
        </h1>
        <p className="text-base text-muted-foreground">
          No password needed. We&apos;ll email you a link and a code.
        </p>
      </header>
      <LoginForm next={next} error={error === "auth"} />
    </main>
  );
}
