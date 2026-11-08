import "server-only";
// Admin allow-list for internal tools like /admin/runs/[id] (D-027).
// ADMIN_USER_IDS = comma-separated Supabase auth user uuids. Read on every call
// (no module cache) so tests and env changes apply immediately. Empty or
// missing → nobody is admin. Invalid entries are ignored.
import { isUuid } from "@/lib/uuid";

export function isAdminUser(userId: string | null | undefined): boolean {
  if (!isUuid(userId)) return false;
  const raw = process.env.ADMIN_USER_IDS;
  if (!raw) return false;
  const wanted = userId.toLowerCase();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => isUuid(s))
    .some((s) => s.toLowerCase() === wanted);
}
