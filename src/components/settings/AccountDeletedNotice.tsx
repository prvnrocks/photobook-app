"use client";

// One-time "Your account was deleted" notice on "/" after deleteAccountAction (M9 T10). Reads the
// query flag on mount (keeps the landing page static — no searchParams), then removes it from the URL.
// M24 (D-076): drawn for the home hero's emerald leather — a solid deep-emerald status card with a
// mint check and cream text (cream #f2e8d8 on #0f3a2d 11.6:1, mint #9ee6bd 8.7:1), keeping the
// Notice semantics (role="status", visually hidden "Done:" prefix).

import { useEffect, useState } from "react";
import { CircleCheck } from "lucide-react";
import { ACCOUNT_COPY, ACCOUNT_DELETED_PARAM, ACCOUNT_DELETED_VALUE } from "@/lib/settings/account";

export function AccountDeletedNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get(ACCOUNT_DELETED_PARAM) !== ACCOUNT_DELETED_VALUE) return;
    setShow(true);
    url.searchParams.delete(ACCOUNT_DELETED_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  if (!show) return null;
  return (
    <div
      role="status"
      data-tone="success"
      className="mx-auto mb-8 flex w-full max-w-md items-start gap-3 rounded-2xl border border-[#7fd6a6]/50 bg-[#0f3a2d] p-4 text-start text-[#f2e8d8] shadow-[0_14px_28px_-16px_rgb(0_0_0/0.6)]"
      data-testid="account-deleted-notice"
    >
      <CircleCheck className="mt-0.5 size-5 shrink-0 text-[#9ee6bd]" aria-hidden="true" />
      <p className="type-small min-w-0 flex-1">
        <span className="sr-only">Done: </span>
        {ACCOUNT_COPY.deletedNotice}
      </p>
    </div>
  );
}
