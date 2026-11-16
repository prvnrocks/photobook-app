"use client";

// Settings → "Email reminders" switch (M9 T10, D-057). Saves immediately (optimistic); on failure
// it flips back and shows why. <EmailRemindersToggleView> takes the action as a prop (unit tests).
// M24 (D-076): emerald card + switch (on = emerald, off = muted); recipes from settings-classes.ts,
// plain strings picked per state (no cn in this first-load island).

import { Bell } from "lucide-react";
import { useState } from "react";
import { setEmailRemindersAction } from "@/app/settings/actions";
import { REMINDERS_OFF_NOTICE } from "@/lib/cleanup/rules";
import {
  ACCOUNT_COPY,
  remindersErrorCopy,
  type SetEmailRemindersResult,
} from "@/lib/settings/account";
import { Notice } from "@/components/app/Notice";
import {
  SETTINGS_CARD,
  SETTINGS_CARD_HEAD,
  SETTINGS_CARD_HEADING,
  SETTINGS_ICON_CHIP,
  SETTINGS_SWITCH_BUTTON,
  SETTINGS_SWITCH_THUMB_OFF,
  SETTINGS_SWITCH_THUMB_ON,
  SETTINGS_SWITCH_TRACK_OFF,
  SETTINGS_SWITCH_TRACK_ON,
} from "@/components/settings/settings-classes";

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
  // Local busy flag, not useTransition: the action's revalidatePath("/settings") re-renders a route
  // with loading.tsx, and a transition's pending can stay true until reload (refresh-hang lesson) —
  // that left the switch disabled after one tap (M24 test). Busy ends when the action answers.
  const [pending, setPending] = useState(false);

  const toggle = async () => {
    if (pending) return;
    const next = !on;
    setOn(next);
    setMessage(null);
    setPending(true);
    let result: SetEmailRemindersResult | null = null;
    try {
      result = await save(next);
    } catch {
      result = null;
    } finally {
      setPending(false);
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
  };

  return (
    <section
      aria-labelledby="settings-reminders-heading"
      className={SETTINGS_CARD}
      data-testid="settings-reminders"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className={SETTINGS_CARD_HEAD}>
          <span aria-hidden="true" className={SETTINGS_ICON_CHIP}>
            <Bell className="size-5" />
          </span>
          <h2 id="settings-reminders-heading" className={`${SETTINGS_CARD_HEADING} self-center`}>
            {ACCOUNT_COPY.remindersHeading}
          </h2>
        </div>
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
            className={SETTINGS_SWITCH_BUTTON}
            data-testid="settings-reminders-toggle"
            data-state={on ? "on" : "off"}
          >
            <span
              className={on ? "w-7 text-end text-[#0e3b2e]" : "w-7 text-end text-muted-foreground"}
              aria-hidden="true"
            >
              {on ? ACCOUNT_COPY.remindersOn : ACCOUNT_COPY.remindersOff}
            </span>
            <span aria-hidden="true" className={on ? SETTINGS_SWITCH_TRACK_ON : SETTINGS_SWITCH_TRACK_OFF}>
              <span className={on ? SETTINGS_SWITCH_THUMB_ON : SETTINGS_SWITCH_THUMB_OFF} />
            </span>
          </button>
        )}
      </div>
      <p
        id="settings-reminders-detail"
        className="type-small text-muted-foreground"
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
      {/* Empty live region: cancel SETTINGS_CARD's gap-4 so no blank row shows (keep -mt-4 in sync with that gap). */}
      <div aria-live="polite" className="empty:-mt-4">
        {message ? (
          <p
            className={
              message.tone === "error"
                ? "text-sm text-destructive"
                : "text-sm font-medium text-[#0e3b2e]"
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
