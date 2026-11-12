"use client";

// Dashboard book card "⋯" menu → "Delete book" → destructive confirm dialog (M9 T10, D-060).
// The server action is passed in as a prop (dashboard page → BookList → here), so this module never
// imports server code. <BookCardMenu> wires useRefreshTransition (a bare router.refresh can hang
// under dashboard/loading.tsx); <BookCardMenuView> takes `refresh` so it
// renders without an app router (unit tests).

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Menu } from "@base-ui/react/menu";
import { Loader2, MoreVertical, Trash2 } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { useRefreshTransition } from "@/components/app/use-refresh-transition";
import { Button } from "@/components/ui/button";
import { displayBookTitle } from "@/lib/book/display-title";
import {
  DELETE_BOOK_COPY,
  deleteBookErrorCopy,
  type DeleteBookActionResult,
} from "@/lib/dashboard/delete-book";

export type DeleteBookFn = (bookId: string) => Promise<DeleteBookActionResult>;

type Props = {
  bookId: string;
  title: string | null;
  deleteBook: DeleteBookFn;
};

export function BookCardMenu(props: Props) {
  const [, refresh] = useRefreshTransition();
  return <BookCardMenuView {...props} refresh={refresh} />;
}

export function BookCardMenuView({
  bookId,
  title,
  deleteBook,
  refresh,
  initialConfirmOpen = false,
}: Props & { refresh: () => void; initialConfirmOpen?: boolean }) {
  const [confirmOpen, setConfirmOpen] = useState(initialConfirmOpen);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const shownTitle = displayBookTitle(title);
  const titleId = useId();
  const detailId = useId();

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      let result: DeleteBookActionResult | null = null;
      try {
        result = await deleteBook(bookId);
      } catch {
        result = null;
      }
      if (result?.ok || (result && result.error === "not_found")) {
        // Gone (or already gone): the refreshed list drops this card, dialog included.
        setConfirmOpen(false);
        refresh();
        return;
      }
      setError(deleteBookErrorCopy(result?.error));
    });
  };

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className="flex min-h-11 min-w-11 flex-1 items-center justify-center text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-muted"
          aria-label={`${DELETE_BOOK_COPY.menuLabel}: ${shownTitle}`}
          data-testid="book-menu"
        >
          <MoreVertical className="size-5" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4} align="end" className="z-50 outline-none">
            <Menu.Popup className="min-w-44 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lift outline-none">
              <Menu.Item
                className="flex min-h-11 cursor-default items-center gap-2 rounded-lg px-3 text-base text-destructive outline-none select-none data-highlighted:bg-destructive-soft"
                onClick={() => {
                  setError(null);
                  setConfirmOpen(true);
                }}
                data-testid="book-menu-delete"
              >
                <Trash2 className="size-4" aria-hidden="true" />
                {DELETE_BOOK_COPY.menuItem}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <AlertDialog.Root
        open={confirmOpen}
        onOpenChange={(open) => {
          if (pending) return; // never close mid-delete
          setConfirmOpen(open);
          if (!open) setError(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 min-h-dvh bg-primary/40" />
          <AlertDialog.Popup
            className="fixed inset-x-0 bottom-0 z-50 mx-auto w-full max-w-md rounded-t-2xl border border-border bg-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-lift outline-none sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
            aria-labelledby={titleId}
            aria-describedby={detailId}
            data-testid="delete-book-dialog"
          >
            <DeleteBookConfirmContent
              titleId={titleId}
              detailId={detailId}
              title={shownTitle}
              error={error}
              pending={pending}
              onCancel={() => setConfirmOpen(false)}
              onConfirm={onConfirm}
            />
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}

/** Dialog body (presentational, portal-free → static-render testable). */
export function DeleteBookConfirmContent({
  titleId,
  detailId,
  title,
  error,
  pending,
  onCancel,
  onConfirm,
}: {
  titleId?: string;
  detailId?: string;
  title: string;
  error: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h2 id={titleId} className="type-h2">
          {DELETE_BOOK_COPY.title}
        </h2>
        <p dir="auto" className="truncate text-base font-medium" data-testid="delete-book-title">
          {title}
        </p>
        <p id={detailId} className="text-sm text-muted-foreground">
          {DELETE_BOOK_COPY.detail}
        </p>
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive"
          data-testid="delete-book-error"
        >
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="text-base"
          disabled={pending}
          onClick={onCancel}
          data-testid="delete-book-cancel"
        >
          {DELETE_BOOK_COPY.cancel}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="touch"
          className="bg-destructive text-base text-white hover:bg-destructive/90 focus-visible:ring-destructive"
          disabled={pending}
          aria-busy={pending}
          onClick={onConfirm}
          data-testid="delete-book-confirm"
        >
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {pending ? DELETE_BOOK_COPY.deleting : DELETE_BOOK_COPY.confirm}
        </Button>
      </div>
    </div>
  );
}
