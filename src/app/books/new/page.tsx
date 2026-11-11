import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { NewBookForm } from "@/components/books/NewBookForm";
import { AppHeader } from "@/components/layout/AppHeader";
import { StepProgress } from "@/components/app/StepProgress";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOwnMemoryView } from "@/lib/db/memory";
import { getMyProfile } from "@/lib/db/profiles";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New book" };

export default async function NewBookPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=%2Fbooks%2Fnew");

  const [profile, memory] = await Promise.all([
    getMyProfile().catch(() => null),
    // Best effort prefill (D-032): a memory error must never block creating a book.
    getOwnMemoryView().catch(() => null),
  ]);
  const initialTone = memory?.tone;
  const initialLang = memory?.language;
  const fromMemory = initialTone !== undefined || initialLang !== undefined;
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto w-full max-w-app px-gutter pt-4 pb-6 sm:pt-6">
        {/* Own header markup (not <PageHeader>) so the back link and h1 keep their data-testids. */}
        <header className="mb-stack flex flex-col gap-4">
          <Link
            href="/dashboard"
            className="-ms-3 inline-flex h-11 w-fit items-center gap-1 rounded-lg ps-2 pe-3 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-testid="back-to-dashboard"
          >
            <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
            Back to my books
          </Link>
          <StepProgress current="new" />
          <div>
            <h1 className="type-h1 text-foreground" data-testid="new-book-heading">
              New book
            </h1>
            <p className="type-body mt-2 text-muted-foreground" data-testid="new-book-intro">
              Page shape and style are set now. Everything else can change later.
            </p>
          </div>
        </header>
        <NewBookForm initialTone={initialTone} initialLang={initialLang} fromMemory={fromMemory} />
      </main>
    </>
  );
}
