"use client";

// /b/[slug] for a password-protected book without a valid access cookie (D-040). Shows no title
// or cover. On success the server action sets the per-book cookie and router.refresh() swaps this
// for the viewer (the button stays busy until then).

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { unlockBookAction } from "@/app/b/[slug]/actions";
import type { UnlockErrorCode } from "@/lib/publish/unlock-types";
import { unlockErrorCopy } from "@/lib/viewer/unlock-copy";
import { VIEWER_PRIMARY_LINK, ViewerMessage } from "./ViewerMessage";

export function PasswordGate({ slug }: { slug: string }) {
  const router = useRouter();
  const [error, setError] = useState<UnlockErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const password = formData.get("password");
    if (typeof password !== "string" || password.length === 0) {
      setError("invalid_input");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await unlockBookAction(slug, formData);
        if (res.ok) {
          router.refresh();
          return;
        }
        setError(res.error);
      } catch {
        setError("unavailable");
      }
    });
  }

  return (
    <ViewerMessage title="This photobook is private" testId="password-gate">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-neutral-100" aria-hidden>
        <Lock className="size-5 text-neutral-700" />
      </div>
      <p className="text-sm text-neutral-600">Enter the password you were given to open it.</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3 text-left" noValidate>
        <label htmlFor="book-password" className="text-sm font-medium text-neutral-800">
          Password
        </label>
        <input
          id="book-password"
          name="password"
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={256}
          required
          dir="auto"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "book-password-error" : undefined}
          className="h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-900 outline-none focus:border-neutral-900 focus:ring-2 focus:ring-neutral-900/10"
          data-testid="password-input"
        />
        {error ? (
          <p id="book-password-error" role="status" className="text-sm text-red-700" data-testid="password-error">
            {unlockErrorCopy(error)}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className={`${VIEWER_PRIMARY_LINK} disabled:opacity-60`}
          data-testid="password-submit"
        >
          {pending ? "Opening…" : "Open photobook"}
        </button>
      </form>
    </ViewerMessage>
  );
}
