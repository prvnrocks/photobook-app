"use client";

import { MailCheck } from "lucide-react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { sendMagicLink, signInWithGoogle, verifyEmailCode } from "@/app/auth/actions";
import { Notice } from "@/components/app/Notice";
import { Button } from "@/components/ui/button";
import { initialAuthFormState, type AuthFormState } from "@/lib/auth/form-state";
import { cn } from "@/lib/utils";

const LINK_ERROR =
  "That sign-in link has expired or was already used. Request a new one below.";

const inputClass =
  "h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive";

type LoginFormProps = {
  /** Already sanitised with safeNextPath on the server. */
  next: string;
  /** True when /login?error=auth (bad or expired link / OAuth failure). */
  error?: boolean;
};

function SubmitButton({
  children,
  pendingText,
  variant = "default",
  testId,
  className,
}: {
  children: React.ReactNode;
  pendingText: string;
  variant?: "default" | "outline" | "ghost";
  testId?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending}
      aria-busy={pending}
      data-testid={testId}
      size="cta"
      className={className}
    >
      {pending ? pendingText : children}
    </Button>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <Notice tone="error" data-testid="login-error" className="break-words">
      {message}
    </Notice>
  );
}

function NextInput({ next, testId }: { next: string; testId?: boolean }) {
  return (
    <input type="hidden" name="next" value={next} data-testid={testId ? "login-next" : undefined} />
  );
}

export function LoginForm({ next, error = false }: LoginFormProps) {
  const [sendState, sendAction] = useActionState<AuthFormState, FormData>(
    sendMagicLink,
    initialAuthFormState,
  );
  const [verifyState, verifyAction] = useActionState<AuthFormState, FormData>(
    verifyEmailCode,
    initialAuthFormState,
  );
  // The successful send the user backed out of via "Use a different email".
  const [dismissed, setDismissed] = useState<AuthFormState | null>(null);

  const showCodeStep = sendState.ok && sendState !== dismissed && Boolean(sendState.email);
  const showLinkError = error && sendState === initialAuthFormState;

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      {showCodeStep ? (
        <div className="flex flex-col gap-4">
          <div aria-live="polite" className="flex items-start gap-3 rounded-xl border border-success-border bg-success-soft p-4">
            <MailCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
            <p className="type-small break-words text-foreground">
              Check your email — we sent a link and a 6-digit code to{" "}
              <strong className="font-semibold break-all">{sendState.email}</strong>
            </p>
          </div>

          <form action={verifyAction} className="flex flex-col gap-3">
            <input type="hidden" name="email" value={sendState.email} />
            <NextInput next={next} testId />
            <label htmlFor="login-code" className="text-sm font-medium">
              6-digit code
            </label>
            <input
              id="login-code"
              name="token"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="\d{6}"
              required
              data-testid="login-code"
              aria-invalid={verifyState.error ? true : undefined}
              aria-describedby={verifyState.error ? "login-code-error" : undefined}
              className={cn(inputClass, "text-center font-mono text-lg tracking-[0.3em]")}
            />
            {verifyState.error ? (
              <div id="login-code-error">
                <ErrorBanner message={verifyState.error} />
              </div>
            ) : null}
            <SubmitButton pendingText="Signing in…" testId="login-verify">
              Sign in with code
            </SubmitButton>
          </form>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="ghost"
              size="touch"
              className="w-full text-base sm:flex-1"
              onClick={() => setDismissed(sendState)}
            >
              Use a different email
            </Button>
            <form action={sendAction} className="sm:flex-1">
              <input type="hidden" name="email" value={sendState.email} />
              <NextInput next={next} />
              <SubmitButton variant="outline" pendingText="Sending…">
                Resend
              </SubmitButton>
            </form>
          </div>
        </div>
      ) : (
        <form action={sendAction} className="flex flex-col gap-3">
          {showLinkError ? <ErrorBanner message={LINK_ERROR} /> : null}
          <NextInput next={next} testId />
          <label htmlFor="login-email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            defaultValue={sendState.email ?? ""}
            placeholder="you@example.com"
            data-testid="login-email"
            aria-invalid={sendState.error ? true : undefined}
            className={inputClass}
          />
          {sendState.error ? <ErrorBanner message={sendState.error} /> : null}
          <SubmitButton pendingText="Sending…" testId="login-send">
            Email me a sign-in link
          </SubmitButton>
        </form>
      )}

      <div className="flex items-center gap-3 text-sm text-muted-foreground" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <form action={signInWithGoogle} className="flex flex-col gap-2">
        <NextInput next={next} />
        <SubmitButton variant="outline" pendingText="Opening Google…" testId="login-google">
          Continue with Google
        </SubmitButton>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Opening this from WhatsApp? Use email — Google sign-in may not work inside the
          WhatsApp browser.
        </p>
      </form>
    </div>
  );
}
