import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NewBookForm } from "@/components/books/NewBookForm";
import { AppHeader } from "@/components/layout/AppHeader";
import { buttonVariants } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyProfile } from "@/lib/db/profiles";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New book" };

export default async function NewBookPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=%2Fbooks%2Fnew");

  const profile = await getMyProfile().catch(() => null);
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto w-full max-w-md px-4 py-6">
        <h1 className="text-2xl font-semibold" data-testid="new-book-heading">
          New book
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tell us a little about it — you can change everything later.
        </p>
        <div className="mt-6">
          <NewBookForm />
        </div>
        <Link
          href="/dashboard"
          className={cn(buttonVariants({ variant: "ghost" }), "mt-4 h-11 w-full px-4 text-base")}
          data-testid="back-to-dashboard"
        >
          Back to my books
        </Link>
      </main>
    </>
  );
}
