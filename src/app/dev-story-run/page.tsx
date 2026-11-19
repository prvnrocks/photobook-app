// Dev-only (Task 8): the wizard's step 6 "Your memories are becoming a story." with a stubbed job,
// for 375 px checks, screenshots (docs/design/task8-*.png) and the signed-out e2e spec — no auth,
// no database, no AI. The job never moves on its own: each state is a fixed server answer.
//   /dev-story-run?state=running     stage 3 in progress ("Chapter 2 of 3"), Stop enabled
//   /dev-story-run?state=failed      stopped at stage 4 with a plain reason + Try again
//   /dev-story-run?state=cancelled   stopped by the user at stage 3 + "Continue my story"
//   /dev-story-run?state=starting    the start request is out (skeleton rows)
//   /dev-story-run?state=rule        finished without AI (the honest outcome line)
//   &photos=N (1–12)                the user's photos above the stages (public/dev-photos, git-ignored;
//                                   tiles stay grey where a file is missing), "Your 40 photos"
// Try again / Stop answer from local stubs (running → cancelled, Try again → running again).
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DevStoryRunClient, type DevStoryRunState } from "./DevStoryRunClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Story generation (dev)" };

const STATES: readonly DevStoryRunState[] = ["running", "failed", "cancelled", "starting", "rule"];

export default async function DevStoryRunPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const raw = typeof sp.state === "string" ? sp.state : "running";
  const state = (STATES as readonly string[]).includes(raw) ? (raw as DevStoryRunState) : "running";
  const n = typeof sp.photos === "string" && /^\d{1,2}$/.test(sp.photos) ? Math.min(12, Number(sp.photos)) : 0;
  return <DevStoryRunClient state={state} photos={n} />;
}
