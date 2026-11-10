"use client";

// Settings → "Delete account" danger zone (M9 T10, D-060). Type DELETE → button enables. On success
// the server action signs out and redirects to "/?account=deleted" (it never returns); any returned
// value is an error. <DeleteAccountView> takes the action as a prop (unit tests).

import { Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { deleteAccountAction } from "@/app/settings/actions";
import { Button } from "@/components/ui/button";
import {
  ACCOUNT_COPY,
  deleteAccountErrorCopy,
  isDeleteConfirmed,
  type DeleteAccountActionResult,
} from "@/lib/settings/account";

export function DeleteAccount() {
  return <DeleteAccountView deleteAccount={deleteAccountAction} />;
}

export function DeleteAccountView({
  deleteAccount,
  initialText = "",
}: {
  deleteAccount: (confirm: string) => Promise<DeleteAccountActionResult | void>;
  initialText?: string;
}) {
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirmed = isDeleteConfirmed(text);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmed || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await deleteAccount(text);
        // Success redirects away; anything returned is an error.
        if (result && !result.ok) setError(deleteAccountErrorCopy(result.error));
      } catch (err) {
        // A redirect is surfaced by Next as a thrown control-flow error — let it through.
        if (err && typeof err === "object" && "digest" in err && String(err.digest).startsWith("NEXT_REDIRECT")) throw err;
        setError(deleteAccountErrorCopy(null));
      }
    });
  };

  return (
    <section
      aria-labelledby="settings-delete-heading"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-destructive/40 p-4"
      data-testid="settings-delete-account"
    >
      <h2 id="settings-delete-heading" className="text-lg font-semibold text-destructive">
        {ACCOUNT_COPY.dangerHeading}
      </h2>
      <p className="text-sm">{ACCOUNT_COPY.dangerDetail}</p>
      <p className="text-sm text-muted-foreground">{ACCOUNT_COPY.dangerPayments}</p>
      <form onSubmit={onSubmit} className="flex min-w-0 flex-col gap-3">
        <label htmlFor="settings-delete-confirm" className="text-sm font-medium">
          {ACCOUNT_COPY.confirmLabel}
        </label>
        <input
          id="settings-delete-confirm"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          dir="ltr"
          disabled={pending}
          className="h-11 w-full min-w-0 rounded-lg border bg-background px-3 text-base"
          data-testid="settings-delete-input"
        />
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="settings-delete-error"
          >
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="destructive"
          className="h-11 w-full bg-destructive text-base text-white hover:bg-destructive/90 disabled:opacity-50"
          disabled={!confirmed || pending}
          aria-busy={pending}
          data-testid="settings-delete-button"
        >
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {pending ? ACCOUNT_COPY.deleting : ACCOUNT_COPY.button}
        </Button>
      </form>
    </section>
  );
}
