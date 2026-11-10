"use client";

// Optional book password (D-040): set / change / remove. 4–64 characters; the server validates
// again and hashes (scrypt). The password itself is never kept after submit, logged or shown.

import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import type { SetBookPasswordResult } from "@/app/books/[id]/publish/actions";
import { PASSWORD_MAX, passwordErrorCopy, passwordLengthError } from "@/lib/publish/ui";

export type PasswordFieldProps = {
  hasPassword: boolean;
  /** Bound setBookPasswordAction: string = set/change, null = remove. */
  setPassword: (password: string | null) => Promise<SetBookPasswordResult>;
  /** Called after a successful change (page refresh). */
  onChanged: (message: string) => void;
  disabled?: boolean;
};

const BTN = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium disabled:opacity-50";

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
    <section className="flex flex-col gap-3 rounded-xl border p-4" data-testid="password-section">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <KeyRound className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Password</h2>
          <p className="text-sm text-muted-foreground" data-testid="password-status">
            {hasPassword ? "On — people need the password to open your book." : "Off — anyone with the link can open your book."}
          </p>
        </div>
      </div>

      {editing ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
          <label htmlFor={inputId} className="text-sm font-medium">
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
              className="h-11 min-w-0 flex-1 rounded-lg border px-3 text-base"
              data-testid="password-input"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide password" : "Show password"}
              className="flex size-11 shrink-0 items-center justify-center rounded-lg border hover:bg-muted"
            >
              {show ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">4–64 characters. Share it separately from the link.</p>
          {error ? (
            <p id={errorId} className="text-sm text-destructive" data-testid="password-error">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || disabled} className={`${BTN} bg-primary text-primary-foreground`} data-testid="password-save">
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Save password
            </button>
            <button type="button" onClick={close} disabled={busy} className={`${BTN} border`}>
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
            className={`${BTN} border`}
            data-testid="password-edit"
          >
            {hasPassword ? "Change password" : "Add a password"}
          </button>
          {hasPassword ? (
            <button
              type="button"
              onClick={() => void run(null)}
              disabled={busy || disabled}
              className={`${BTN} border text-destructive`}
              data-testid="password-remove"
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Remove password
            </button>
          ) : null}
          {error ? (
            <p className="w-full text-sm text-destructive" data-testid="password-error">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
