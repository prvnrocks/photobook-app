// User-facing copy for /b/[slug] password unlock errors (D-040). Pure — safe in client code.
import type { UnlockErrorCode } from "@/lib/publish/unlock-types";

export const UNLOCK_ERROR_COPY: Record<UnlockErrorCode, string> = {
  wrong_password: "That password isn't right. Check it with the person who shared the link.",
  rate_limited: "Too many tries — wait 15 minutes and try again.",
  unavailable: "We can't open protected books right now. Please try again later.",
  invalid_input: "Enter the password to open this photobook.",
  not_found: "We couldn't find this photobook. Check the link you were sent.",
};

export function unlockErrorCopy(code: UnlockErrorCode): string {
  return UNLOCK_ERROR_COPY[code] ?? UNLOCK_ERROR_COPY.unavailable;
}
