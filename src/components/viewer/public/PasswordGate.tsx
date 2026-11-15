"use client";

// /b/[slug] for a password-protected book without a valid access cookie (D-040). Shows no title
// or cover. On success the server action sets the per-book cookie and router.refresh() swaps this
// for the viewer (the button stays busy until then). Markup: PasswordGateScreen.

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { unlockBookAction } from "@/app/b/[slug]/actions";
import type { UnlockErrorCode } from "@/lib/publish/unlock-types";
import { PasswordGateScreen } from "./PasswordGateScreen";

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

  return <PasswordGateScreen error={error} pending={pending} onSubmit={onSubmit} />;
}
