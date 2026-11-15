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
import { cx } from "@/lib/cx";
import { VW_CTA_GOLD } from "@/components/viewer/viewer-classes";
import { ViewerMessage } from "./ViewerMessage";

// White field on the ivory card: #8c8270 hairline 3.49:1 (non-text ≥ 3), emerald focus ring.
const INPUT =
  "h-11 w-full rounded-xl border border-[#8c8270] bg-white px-3 text-base text-[#1b1b1d] outline-none transition-[box-shadow,border-color] focus-visible:border-[#0e3b2e] focus-visible:ring-2 focus-visible:ring-[#0e3b2e]/35 aria-invalid:border-[#b42318] motion-reduce:transition-none";

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
    <ViewerMessage
      eyebrow="Private book"
      title="This photobook is private"
      icon={<Lock className="size-6" />}
      description="Enter the password you were given to open it."
      testId="password-gate"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3 text-start" noValidate>
        <label htmlFor="book-password" className="text-sm font-semibold text-[#1b1b1d]">
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
          className={INPUT}
          data-testid="password-input"
        />
        {error ? (
          <p id="book-password-error" role="status" className="text-sm font-medium text-[#b42318]" data-testid="password-error">
            {unlockErrorCopy(error)}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className={cx(VW_CTA_GOLD, "mt-1 w-full")}
          data-testid="password-submit"
        >
          {pending ? "Opening…" : "Open photobook"}
        </button>
      </form>
    </ViewerMessage>
  );
}
