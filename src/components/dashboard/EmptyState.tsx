// Shown on the dashboard when the user has no books yet.
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function EmptyState() {
  return (
    <div
      className="rounded-xl border border-dashed px-6 py-10 text-center"
      data-testid="dashboard-empty"
    >
      <h2 className="text-lg font-semibold">No books yet</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Upload your photos and we&apos;ll lay out the first draft for you.
      </p>
      <Link
        href="/books/new"
        className={cn(buttonVariants(), "mt-6 h-11 px-4")}
        data-testid="create-first-book"
      >
        Create your first book
      </Link>
    </div>
  );
}
