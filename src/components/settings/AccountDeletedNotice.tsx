"use client";

// One-time "Your account was deleted" notice on "/" after deleteAccountAction (M9 T10). Reads the
// query flag on mount (keeps the landing page static — no searchParams), then removes it from the URL.

import { useEffect, useState } from "react";
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
    <p
      role="status"
      className="mx-auto mt-4 w-full max-w-5xl rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
      data-testid="account-deleted-notice"
    >
      {ACCOUNT_COPY.deletedNotice}
    </p>
  );
}
