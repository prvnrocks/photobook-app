"use client";

// Settings → "Delete account" danger zone (M9 T10, D-060). Type DELETE → button enables. On success
// the server action signs out and redirects to "/?account=deleted" (it never returns); any returned
// value is an error. <DeleteAccountView> takes the action as a prop (unit tests).
// M24 (D-076): a quiet card until DELETE is typed, then red-tinted with the solid red button (the
// button stays disabled until then — unchanged logic). Plain button + settings-classes.ts recipes as
// full alternatives (no Button/cn in this island).

import { Loader2, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { deleteAccountAction } from "@/app/settings/actions";
import { Notice } from "@/components/app/Notice";
import {
  SETTINGS_CARD_HEADING,
  SETTINGS_DANGER_CARD_ARMED,
  SETTINGS_DANGER_CARD_QUIET,
  SETTINGS_DANGER_INPUT,
  SETTINGS_DELETE_BUTTON_IDLE,
  SETTINGS_DELETE_BUTTON_READY,
} from "@/components/settings/settings-classes";
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
      className={confirmed ? SETTINGS_DANGER_CARD_ARMED : SETTINGS_DANGER_CARD_QUIET}
      data-testid="settings-delete-account"
      data-state={confirmed ? "armed" : "quiet"}
    >
      <h2 id="settings-delete-heading" className={`flex items-center gap-2 ${SETTINGS_CARD_HEADING}`}>
        <TriangleAlert className="size-5 shrink-0 text-destructive" aria-hidden="true" />
        {ACCOUNT_COPY.dangerHeading}
      </h2>
      <p className="type-small text-foreground">{ACCOUNT_COPY.dangerDetail}</p>
      <p className="type-small text-muted-foreground">{ACCOUNT_COPY.dangerPayments}</p>
      <form onSubmit={onSubmit} className="mt-1 flex min-w-0 flex-col gap-3">
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
          className={SETTINGS_DANGER_INPUT}
          data-testid="settings-delete-input"
        />
        {error ? (
          <Notice tone="error" data-testid="settings-delete-error">
            {error}
          </Notice>
        ) : null}
        <button
          type="submit"
          className={confirmed ? SETTINGS_DELETE_BUTTON_READY : SETTINGS_DELETE_BUTTON_IDLE}
          disabled={!confirmed || pending}
          aria-busy={pending}
          data-testid="settings-delete-button"
        >
          {pending ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {pending ? ACCOUNT_COPY.deleting : ACCOUNT_COPY.button}
        </button>
      </form>
    </section>
  );
}
