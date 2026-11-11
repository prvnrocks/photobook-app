import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { NewBookForm } from "@/components/books/NewBookForm";
import { AppHeader } from "@/components/layout/AppHeader";
import { PageHeader } from "@/components/app/PageHeader";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOwnMemoryView } from "@/lib/db/memory";
import { getMyProfile } from "@/lib/db/profiles";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New book" };

/** Only page shape + style are fixed (D-063); occasion, feel and caption language have no edit path yet. */
const NEW_BOOK_INTRO = "Page shape and style are set now. You can change the title, photos and captions later.";

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
      {/* pb-0 on phones: the sticky Create book bar sits flush with the screen bottom. */}
      <main className="mx-auto w-full max-w-app px-gutter pt-4 pb-0 sm:pt-6 sm:pb-6">
        <PageHeader
          className="mb-stack"
          back={{ href: "/dashboard", label: "Back to my books", testId: "back-to-dashboard" }}
          step="new"
          title="New book"
          titleTestId="new-book-heading"
          description={NEW_BOOK_INTRO}
          descriptionTestId="new-book-intro"
        />
        <NewBookForm initialTone={initialTone} initialLang={initialLang} fromMemory={fromMemory} />
      </main>
    </>
  );
}
