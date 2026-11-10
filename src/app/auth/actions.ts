"use server";

import { isAuthApiError } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  normalizeEmail,
  normalizeOtpCode,
  type AuthFormState,
} from "@/lib/auth/form-state";
import { authFlash, withAnalyticsFlash, type AnalyticsFlash } from "@/lib/analytics/flash";
import { getSiteUrl, MISSING_APP_URL_ERROR, safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

const MSG_INVALID_EMAIL = "Please enter a valid email address.";
const MSG_INVALID_CODE = "Please enter the 6-digit code from the email.";
const MSG_RATE_LIMIT = "Too many attempts. Please wait a minute and try again.";
const MSG_SEND_FAILED = "We couldn't send the email right now. Please try again.";
const MSG_BAD_CODE = "That code is wrong or has expired. Check the latest email or request a new code.";
const MSG_GENERIC = "Something went wrong. Please try again.";

async function siteUrl(): Promise<string> {
  // Production: NEXT_PUBLIC_APP_URL is required; getSiteUrl throws without it
  // and headers are never consulted. Header fallback is for dev/test only.
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (fromEnv || process.env.NODE_ENV === "production") return getSiteUrl();
  const h = await headers();
  let origin = h.get("origin") ?? undefined;
  if (!origin) {
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? "https";
    if (host) origin = `${proto}://${host}`;
  }
  return getSiteUrl(origin);
}

function isRateLimited(error: unknown): boolean {
  return (
    isAuthApiError(error) &&
    (error.status === 429 || (error.code ?? "").includes("rate_limit"))
  );
}

function field(formData: FormData, name: string): string | null {
  const v = formData.get(name);
  return typeof v === "string" ? v : null;
}

/**
 * Sends a sign-in email with a link (/auth/confirm) and a 6-digit code.
 * Form fields: `email`, optional `next`. Never reveals whether the account exists.
 */
export async function sendMagicLink(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = normalizeEmail(formData.get("email"));
  if (!email) return { ok: false, error: MSG_INVALID_EMAIL };

  const next = safeNextPath(field(formData, "next"));

  try {
    const site = await siteUrl();
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // NOTE: the hosted Supabase email template builds its link from
        // {{ .SiteURL }} (not {{ .RedirectTo }}), so this `next` is not carried
        // by the emailed link; it is only kept on the 6-digit code path
        // (verifyEmailCode receives `next` from the form).
        emailRedirectTo: `${site}/auth/confirm?next=${encodeURIComponent(next)}`,
        shouldCreateUser: true,
      },
    });
    if (error) {
      if (isRateLimited(error)) return { ok: false, error: MSG_RATE_LIMIT, email };
      console.error("[auth] signInWithOtp failed:", error.code ?? error.status);
      return { ok: false, error: MSG_SEND_FAILED, email };
    }
  } catch (err) {
    // Server misconfiguration (e.g. MISSING_APP_URL_ERROR) is logged, never shown.
    if (err instanceof Error && err.message === MISSING_APP_URL_ERROR) console.error("[auth]", err.message);
    return { ok: false, error: MSG_SEND_FAILED, email };
  }

  return { ok: true, email };
}

/**
 * Verifies the 6-digit code from the email. Form fields: `email`, `token`,
 * optional `next`. On success redirects (never returns).
 */
export async function verifyEmailCode(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = normalizeEmail(formData.get("email"));
  if (!email) return { ok: false, error: MSG_INVALID_EMAIL };
  const token = normalizeOtpCode(formData.get("token"));
  if (!token) return { ok: false, error: MSG_INVALID_CODE, email };

  const next = safeNextPath(field(formData, "next"));

  let flash: AnalyticsFlash;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
    if (error) {
      if (isRateLimited(error)) return { ok: false, error: MSG_RATE_LIMIT, email };
      return { ok: false, error: MSG_BAD_CODE, email };
    }
    flash = authFlash(data.user, "email");
  } catch {
    return { ok: false, error: MSG_GENERIC, email };
  }

  // analytics (M9 T14): one-shot ?_ev= code only when PostHog is configured.
  redirect(withAnalyticsFlash(next, flash));
}

/** Starts Google OAuth. Form field: optional `next`. Redirects to Google. */
export async function signInWithGoogle(formData: FormData): Promise<void> {
  const next = safeNextPath(field(formData, "next"));

  let url: string | null = null;
  try {
    const site = await siteUrl();
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${site}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    if (!error) url = data.url;
    else console.error("[auth] signInWithOAuth failed:", error.code ?? error.status);
  } catch (err) {
    if (err instanceof Error && err.message === MISSING_APP_URL_ERROR) console.error("[auth]", err.message);
    url = null;
  }

  redirect(url ?? "/login?error=auth");
}

/** Signs out and returns to the landing page. */
export async function signOut(): Promise<void> {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut();
  } catch {
    // Still send the user home; cookies are cleared by signOut when it succeeds.
  }
  redirect("/");
}
