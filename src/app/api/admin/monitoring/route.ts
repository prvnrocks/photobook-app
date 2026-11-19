// GET /api/admin/monitoring?days=7 (Task 10) — the production monitoring summary as JSON (AI failure /
// refusal / retry rates, storybook stage + run times p50/p95, cost per day by bucket, export failures
// and times, alert codes). ADMIN_USER_IDS only; everyone else (signed out included) gets a plain 404
// so the route's existence is never revealed. Numbers and codes only. no-store.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isAdminUser } from "@/lib/auth/is-admin";
import { errorCodeOf, json } from "@/lib/http/json";
import { clampDays, getMonitoringSummary } from "@/lib/monitoring/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user || !isAdminUser(user.id)) return json({ error: "not_found" }, 404);
    return json(await getMonitoringSummary(clampDays(request.nextUrl.searchParams.get("days") ?? undefined)), 200);
  } catch (err) {
    console.error(`[monitor] route_failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
