// Plain class joiner for client islands that must stay small (no tailwind-merge). Only use it where
// the joined classes never conflict; use cn() from src/lib/utils everywhere else.
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
