// Shown on the dashboard when the user has no books yet (M11 T8: the shared app EmptyState).
import Link from "next/link";
import { EmptyState as AppEmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

export function EmptyState() {
  return (
    <AppEmptyState
      data-testid="dashboard-empty"
      title="No books yet"
      description="Upload your photos and we'll lay out the first draft for you."
      action={
        <Link
          href="/books/new"
          className={cn(buttonVariants({ variant: "accent", size: "cta" }))}
          data-testid="create-first-book"
        >
          Create your first book
        </Link>
      }
    />
  );
}
