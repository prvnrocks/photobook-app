"use client";

// Optional book password (D-040): set / change / remove. 4–64 characters; the server validates
// again and hashes (scrypt). The password itself is never kept after submit, logged or shown.

import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import type { SetBookPasswordResult } from "@/app/books/[id]/publish/actions";
import { buttonVariants } from "@/components/ui/button";
import { PASSWORD_MAX, passwordErrorCopy, passwordLengthError } from "@/lib/publish/ui";
import { cn } from "@/lib/utils";

export type PasswordFieldProps = {
  hasPassword: boolean;
  /** Bound setBookPasswordAction: string = set/change, null = remove. */
  setPassword: (password: string | null) => Promise<SetBookPasswordResult>;
  /** Called after a successful change (page refresh). */
  onChanged: (message: string) => void;
  disabled?: boolean;
};

// Shared Button looks (M11, D-067): 44 px targets with a visible focus ring.
const PRIMARY = buttonVariants({ variant: "default", size: "touch" });
const OUTLINE = cn(buttonVariants({ variant: "outline", size: "touch" }), "bg-card");
const DANGER = cn(buttonVariants({ variant: "outline", size: "touch" }), "bg-card text-destructive hover:bg-destructive-soft hover:text-destructive");

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
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-5" data-testid="password-section">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-primary">
          <KeyRound className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="type-h2 text-foreground">Password</h2>
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
              className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-card px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive"
              data-testid="password-input"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide password" : "Show password"}
              className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-input bg-card outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
