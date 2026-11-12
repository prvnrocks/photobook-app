import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/app/PageHeader";
import { AppHeader } from "@/components/layout/AppHeader";
import { StartPicker } from "@/components/upload/StartPicker";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyProfile } from "@/lib/db/profiles";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Make your book" };

// Photos-first start (M13 T5, D-070): one big "Choose photos". Picking photos creates the draft
// with defaults and moves to the upload screen, where everything else can still be changed while
// the photos upload. /books/new stays for people who want to choose the style first.
export default async function StartBookPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=%2Fbooks%2Fstart");

  const profile = await getMyProfile().catch(() => null);
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto flex w-full max-w-app flex-col gap-stack px-gutter py-6 sm:py-8">
        <PageHeader
          back={{ href: "/dashboard", label: "Back to my books", testId: "back-to-dashboard" }}
          step="photos"
          title="Make your book"
          titleTestId="start-heading"
          description="Choose your photos. We'll set up the rest — you can change it while they upload."
        />
        <StartPicker variant="hero" testId="start-pick" />
        <p className="text-center text-sm text-muted-foreground">
          Prefer to pick the look first?{" "}
          <Link
            href="/books/new"
            className="inline-flex min-h-11 items-center rounded-md font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="start-choose-style"
          >
            Choose style first
          </Link>
        </p>
      </main>
    </>
  );
}
