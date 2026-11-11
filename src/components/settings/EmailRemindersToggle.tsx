"use client";

// Settings → "Email reminders" switch (M9 T10, D-057). Saves immediately (optimistic); on failure
// it flips back and shows why. <EmailRemindersToggleView> takes the action as a prop (unit tests).

import { useState, useTransition } from "react";
import { setEmailRemindersAction } from "@/app/settings/actions";
import { REMINDERS_OFF_NOTICE } from "@/lib/cleanup/rules";
import {
  ACCOUNT_COPY,
  remindersErrorCopy,
  type SetEmailRemindersResult,
} from "@/lib/settings/account";
import { Notice } from "@/components/app/Notice";
import { cn } from "@/lib/utils";

export function EmailRemindersToggle({
  initialOn,
}: {
  initialOn: boolean | null;
}) {
  return (
    <EmailRemindersToggleView
      initialOn={initialOn}
      save={setEmailRemindersAction}
    />
  );
}

export function EmailRemindersToggleView({
  initialOn,
  save,
}: {
  /** null = the current value couldn't be loaded. */
  initialOn: boolean | null;
  save: (on: boolean) => Promise<SetEmailRemindersResult>;
}) {
  const [on, setOn] = useState(initialOn === true);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    const next = !on;
    setOn(next);
    setMessage(null);
    startTransition(async () => {
      let result: SetEmailRemindersResult | null = null;
      try {
        result = await save(next);
      } catch {
        result = null;
      }
      if (result?.ok) {
        setOn(result.on);
        setMessage({ tone: "ok", text: ACCOUNT_COPY.remindersSaved });
      } else {
        setOn(!next);
        setMessage({
          tone: "error",
          text: remindersErrorCopy(result && !result.ok ? result.error : null),
        });
      }
    });
  };

  return (
    <section
      aria-labelledby="settings-reminders-heading"
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-5 shadow-card"
      data-testid="settings-reminders"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 id="settings-reminders-heading" className="type-h2 text-foreground">
          {ACCOUNT_COPY.remindersHeading}
        </h2>
        {initialOn === null ? null : (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby="settings-reminders-heading"
            aria-describedby="settings-reminders-detail"
            aria-busy={pending}
            disabled={pending}
            onClick={toggle}
            className="flex min-h-11 shrink-0 items-center gap-2 rounded-full px-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-60"
            data-testid="settings-reminders-toggle"
            data-state={on ? "on" : "off"}
          >
            <span
              className="w-7 text-end text-muted-foreground"
              aria-hidden="true"
            >
              {on ? ACCOUNT_COPY.remindersOn : ACCOUNT_COPY.remindersOff}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "relative inline-flex h-7 w-12 items-center rounded-full transition-colors",
                on ? "bg-primary" : "bg-input",
              )}
            >
              <span
                className={cn(
                  "inline-block size-6 rounded-full bg-card shadow-card transition-transform motion-reduce:transition-none",
                  on ? "translate-x-[1.375rem] rtl:-translate-x-[1.375rem]" : "translate-x-0.5 rtl:-translate-x-0.5",
                )}
              />
            </span>
          </button>
        )}
      </div>
      <p
        id="settings-reminders-detail"
        className="text-sm text-muted-foreground"
      >
        {ACCOUNT_COPY.remindersDetail}{" "}
        {/* Unknown setting (null) → the off notice too: deletions happen either way. */}
        <span data-testid="settings-reminders-note">
          {on ? ACCOUNT_COPY.remindersOnHint : REMINDERS_OFF_NOTICE}
        </span>
      </p>
      {initialOn === null ? (
        <Notice tone="error" data-testid="settings-reminders-load-error">
          {ACCOUNT_COPY.remindersLoadError}
        </Notice>
      ) : null}
      <div aria-live="polite">
        {message ? (
          <p
            className={
              message.tone === "error"
                ? "text-sm text-destructive"
                : "text-sm text-success"
            }
            data-testid={
              message.tone === "error"
                ? "settings-reminders-error"
                : "settings-reminders-saved"
            }
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
