"use client";

// Optional book password (D-040): set / change / remove. 4–64 characters; the server validates
// again and hashes (scrypt). The password itself is never kept after submit, logged or shown.
// M21 T4: the share page's "Privacy" card (ivory card, emerald pills); behaviour + testids unchanged.

import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import type { SetBookPasswordResult } from "@/app/books/[id]/publish/actions";
import { PASSWORD_MAX, passwordErrorCopy, passwordLengthError } from "@/lib/publish/ui";
import {
  SHARE_CARD,
  SHARE_CARD_HEADING,
  SHARE_CTA_DANGER_QUIET,
  SHARE_CTA_EMERALD,
  SHARE_CTA_EMERALD_SOLID,
  SHARE_EYEBROW,
  SHARE_ICON_BUTTON,
  SHARE_ICON_CHIP,
  SHARE_INPUT,
} from "./share-classes";

export type PasswordFieldProps = {
  hasPassword: boolean;
  /** Bound setBookPasswordAction: string = set/change, null = remove. */
  setPassword: (password: string | null) => Promise<SetBookPasswordResult>;
  /** Called after a successful change (page refresh). */
  onChanged: (message: string) => void;
  disabled?: boolean;
};

// Share page pills (share-classes.ts): 44 px targets with a visible focus ring.
const PRIMARY = SHARE_CTA_EMERALD_SOLID;
const OUTLINE = SHARE_CTA_EMERALD;
const DANGER = SHARE_CTA_DANGER_QUIET;

export function PasswordField({ hasPassword, setPassword, onChanged, disabled = false }: PasswordFieldProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const errorId = useId();

  const close = () => {
    setEditing(false);
    setValue("");
    setShow(false);
    setError(null);
  };

  const run = async (pw: string | null) => {
    setBusy(true);
    setError(null);
    let r: SetBookPasswordResult;
    try {
      r = await setPassword(pw);
    } catch {
      r = { ok: false, error: "failed" };
    }
    setBusy(false);
    if (r.ok) {
      close();
      onChanged(r.hasPassword ? "Password saved" : "Password removed");
    } else {
      setError(passwordErrorCopy(r.error));
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const local = passwordLengthError(value);
    if (local) {
      setError(passwordErrorCopy(local));
      return;
    }
    void run(value);
  };

  return (
    <section className={`${SHARE_CARD} flex flex-col gap-4`} data-testid="password-section">
      <div className="flex items-start gap-3">
        <span className={SHARE_ICON_CHIP}>
          <KeyRound className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className={SHARE_EYEBROW}>Privacy</p>
          <h2 className={`${SHARE_CARD_HEADING} mt-1`}>Password</h2>
          <p className="type-small mt-0.5 text-muted-foreground" data-testid="password-status">
            {hasPassword ? "On — people need the password to open your book." : "Off — anyone with the link can open your book."}
          </p>
        </div>
      </div>

      {editing ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
          <label htmlFor={inputId} className="type-small font-medium text-foreground">
            {hasPassword ? "New password" : "Password"}
          </label>
          <div className="flex items-center gap-2">
            <input
              id={inputId}
              type={show ? "text" : "password"}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              autoComplete="new-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={PASSWORD_MAX * 2}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              className={SHARE_INPUT}
              data-testid="password-input"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide password" : "Show password"}
              className={SHARE_ICON_BUTTON}
            >
              {show ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">4–64 characters. Share it separately from the link.</p>
          {error ? (
            <p id={errorId} className="type-small text-destructive" data-testid="password-error">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || disabled} className={PRIMARY} data-testid="password-save">
              {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              Save password
            </button>
            <button type="button" onClick={close} disabled={busy} className={OUTLINE}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy || disabled}
            className={OUTLINE}
            data-testid="password-edit"
          >
            {hasPassword ? "Change password" : "Add a password"}
          </button>
          {hasPassword ? (
            <button
              type="button"
              onClick={() => void run(null)}
              disabled={busy || disabled}
              className={DANGER}
              data-testid="password-remove"
            >
              {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              Remove password
            </button>
          ) : null}
          {error ? (
            <p className="type-small w-full text-destructive" data-testid="password-error">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
