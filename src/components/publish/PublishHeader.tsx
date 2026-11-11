// Publish screen header (M11 T15, D-067): back to the editor, "Step 6 of 6: Share", the book title
// as an eyebrow (user text → dir="auto") and the serif page title. Shared by the real page and the
// /dev-publish fixture so screenshots show the real header.

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { StepProgress } from "@/components/app/StepProgress";
import { flowStepForRoute } from "@/lib/app/flow-steps";

const SHARE_STEP = flowStepForRoute("publish") ?? "share";

export function PublishHeader({ bookId, title }: { bookId: string; title: string }) {
  return (
    <header className="flex flex-col gap-4" data-testid="page-header">
      <Link
        href={`/books/${bookId}/edit`}
        className="-ms-3 inline-flex h-11 w-fit items-center gap-1 rounded-lg ps-2 pe-3 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        data-testid="publish-back"
      >
        <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
        Back to editor
      </Link>
      <StepProgress current={SHARE_STEP} />
      <div className="min-w-0">
        {/* Not type-eyebrow: uppercase + letter-spacing would break Arabic joining in titles. */}
        <p dir="auto" className="type-small mb-1 truncate font-medium text-muted-foreground" data-testid="publish-title">
          {title}
        </p>
        <h1 className="type-h1 text-foreground">Share your book</h1>
      </div>
    </header>
  );
}
