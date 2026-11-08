// Shared state shape for auth forms (useActionState). Lives outside the
// "use server" file because those may only export async functions.

export type AuthFormState = {
  ok: boolean;
  error?: string;
  email?: string;
};

export const initialAuthFormState: AuthFormState = { ok: false };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed + lowercased email, or null if invalid. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  return EMAIL_RE.test(email) ? email : null;
}

/** Six digits, ignoring spaces/dashes the user may type; or null. */
export function normalizeOtpCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}
