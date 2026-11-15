// The password screen's markup (D-040): no title or cover. No hooks, no "use client" and no client
// imports: PasswordGate (client) renders it with live state, and the dev-viewer ?state=password
// preview renders it statically on the server without referencing /b's client modules.
// Kept tiny (it ships in PasswordGate's island): no next/link, cn or button variants.

import type { FormEventHandler } from "react";
import { Lock } from "lucide-react";
import type { UnlockErrorCode } from "@/lib/publish/unlock-types";
import { unlockErrorCopy } from "@/lib/viewer/unlock-copy";
import { cx } from "@/lib/cx";
import { VW_CTA_GOLD, VW_FIELD_ERROR, VW_FIELD_LABEL, VW_INPUT } from "@/components/viewer/viewer-classes";
import { ViewerMessage } from "./ViewerMessage";

export function PasswordGateScreen({
  error = null,
  pending = false,
  onSubmit,
}: {
  error?: UnlockErrorCode | null;
  pending?: boolean;
  /** Omitted in the static dev preview. */
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  return (
    <ViewerMessage
      eyebrow="Private book"
      title="This photobook is private"
      icon={<Lock className="size-6" />}
      description="Enter the password you were given to open it."
      testId="password-gate"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3 text-start" noValidate>
        <label htmlFor="book-password" className={VW_FIELD_LABEL}>
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
          className={VW_INPUT}
          data-testid="password-input"
        />
        {error ? (
          <p id="book-password-error" role="status" className={VW_FIELD_ERROR} data-testid="password-error">
            {unlockErrorCopy(error)}
          </p>
        ) : null}
        <button type="submit" disabled={pending} className={cx(VW_CTA_GOLD, "mt-1 w-full")} data-testid="password-submit">
          {pending ? "Opening…" : "Open photobook"}
        </button>
      </form>
    </ViewerMessage>
  );
}
