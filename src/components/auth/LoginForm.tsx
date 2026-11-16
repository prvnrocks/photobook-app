"use client";

import { MailCheck } from "lucide-react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { sendMagicLink, signInWithGoogle, verifyEmailCode } from "@/app/auth/actions";
import { Notice } from "@/components/app/Notice";
import {
  LG_CODE_INPUT,
  LG_CTA_GHOST,
  LG_CTA_GOLD,
  LG_CTA_OUTLINE,
  LG_DIVIDER,
  LG_DIVIDER_LINE,
  LG_HINT,
  LG_INPUT,
  LG_LABEL,
  LG_SENT_CARD,
  LG_SENT_ICON,
} from "@/components/auth/login-classes";
import { initialAuthFormState, type AuthFormState } from "@/lib/auth/form-state";

const LINK_ERROR =
  "That sign-in link has expired or was already used. Request a new one below.";

type LoginFormProps = {
  /** Already sanitised with safeNextPath on the server. */
  next: string;
  /** True when /login?error=auth (bad or expired link / OAuth failure). */
  error?: boolean;
};

// Plain <button> + recipe strings (no shadcn Button / cn / buttonVariants): keeps this first-load
// island small (lessons M17–M24). className is one complete recipe from login-classes.
function SubmitButton({
  children,
  pendingText,
  testId,
  className,
}: {
  children: React.ReactNode;
  pendingText: string;
  testId?: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} data-testid={testId} className={className}>
      {pending ? pendingText : children}
    </button>
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
          <div aria-live="polite" className={LG_SENT_CARD}>
            <MailCheck className={LG_SENT_ICON} aria-hidden="true" />
            <p className="type-small min-w-0 break-words">
              Check your email — we sent a link and a 6-digit code to{" "}
              <strong className="font-semibold [overflow-wrap:anywhere]">{sendState.email}</strong>
            </p>
          </div>

          <form action={verifyAction} className="flex flex-col gap-3">
            <input type="hidden" name="email" value={sendState.email} />
            <NextInput next={next} testId />
            <label htmlFor="login-code" className={LG_LABEL}>
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
              className={LG_CODE_INPUT}
            />
            {verifyState.error ? (
              <div id="login-code-error">
                <ErrorBanner message={verifyState.error} />
              </div>
            ) : null}
            <SubmitButton pendingText="Signing in…" testId="login-verify" className={LG_CTA_GOLD}>
              Sign in with code
            </SubmitButton>
          </form>

          <div className="flex flex-col gap-2">
            <button type="button" className={LG_CTA_GHOST} onClick={() => setDismissed(sendState)}>
              Use a different email
            </button>
            <form action={sendAction}>
              <input type="hidden" name="email" value={sendState.email} />
              <NextInput next={next} />
              <SubmitButton pendingText="Sending…" className={LG_CTA_OUTLINE}>
                Resend
              </SubmitButton>
            </form>
          </div>
        </div>
      ) : (
        <form action={sendAction} className="flex flex-col gap-3">
          {showLinkError ? <ErrorBanner message={LINK_ERROR} /> : null}
          <NextInput next={next} testId />
          <label htmlFor="login-email" className={LG_LABEL}>
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
            className={LG_INPUT}
          />
          {sendState.error ? <ErrorBanner message={sendState.error} /> : null}
          <SubmitButton pendingText="Sending…" testId="login-send" className={`${LG_CTA_GOLD} mt-1`}>
            Email me a sign-in link
          </SubmitButton>
        </form>
      )}

      <div className={LG_DIVIDER} aria-hidden="true">
        <span className={LG_DIVIDER_LINE} />
        or
        <span className={LG_DIVIDER_LINE} />
      </div>

      <form action={signInWithGoogle} className="flex flex-col gap-2">
        <NextInput next={next} />
        <SubmitButton pendingText="Opening Google…" testId="login-google" className={LG_CTA_OUTLINE}>
          Continue with Google
        </SubmitButton>
        <p className={LG_HINT}>
          Opening this from WhatsApp? Use email — Google sign-in may not work inside the
          WhatsApp browser.
        </p>
      </form>
    </div>
  );
}
