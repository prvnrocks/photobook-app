// GET /api/cron/cleanup — daily housekeeping (D-055 / D-056).
//
// Vercel Cron calls this with GET at "0 1 * * *" (vercel.json) and, when the CRON_SECRET env var
// is set, sends `Authorization: Bearer <CRON_SECRET>`. Hobby plan: at most one run per day, fired
// at some point within the scheduled hour (01:00–01:59 UTC); the sweeps don't depend on the minute.
// maxDuration 300 = the Hobby + Fluid compute ceiling; the cleanup stops starting new batches
// after CRON_TIME_BUDGET_MS (240 s) and the next day continues.
//
// Excluded from the middleware matcher (no cookies / session). Responses carry counts only.
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cleanup/cron-auth";
import { runCleanup } from "@/lib/cleanup/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  // The only place CRON_SECRET is read.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cleanup] CRON_SECRET missing — see .env.example");
    return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });
  }
  if (!isAuthorizedCron(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  try {
    const counts = await runCleanup();
    return NextResponse.json(counts, { status: counts.ok ? 200 : 500, headers: NO_STORE });
  } catch {
    console.error("[cleanup] run failed");
    return NextResponse.json({ error: "cleanup_failed" }, { status: 500, headers: NO_STORE });
  }
}
