// Shown on the dashboard when the user has no books yet (M11 T8: the shared app EmptyState).
// M13 T5 (D-070): the call to action is the photo picker's label — picking photos starts the book;
// "Choose style first" keeps the old form-first path.
import Link from "next/link";
import { EmptyState as AppEmptyState } from "@/components/app/EmptyState";
import { StartPicker } from "@/components/upload/StartPicker";

export function EmptyState() {
  return (
    <AppEmptyState
      data-testid="dashboard-empty"
      title="No books yet"
      description="Choose your photos and we'll lay out the first draft for you."
      action={
        <>
          <StartPicker variant="cta" label="Create your first book" testId="create-first-book" />
          <Link
            href="/books/new"
            className="mx-auto inline-flex min-h-11 items-center rounded-md text-sm font-medium text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="empty-choose-style"
          >
            Choose style first
          </Link>
        </>
      }
    />
  );
}
