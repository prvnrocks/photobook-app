// Dev-only: the publish screen body with fixture states and stubbed actions, for 375 px checks
// without auth or migration 1000. `?state=draft|draft-paid|empty|page_limit|invalid_doc|live|
// live-paid|changes|password|expired|unpublished`; `?result=ok|conflict|conflict2|failed` picks
// what Publish returns (conflict = first call only, conflict2 = both calls).
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import { notFound } from "next/navigation";
import { parseDevPublishState } from "@/lib/publish/dev-fixture";
import { DevPublishClient } from "./DevPublishClient";

export const dynamic = "force-dynamic";

export default async function DevPublishPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const result = ["ok", "conflict", "conflict2", "failed"].includes(String(params.result)) ? String(params.result) : "ok";
  return <DevPublishClient name={parseDevPublishState(params.state)} result={result as "ok" | "conflict" | "conflict2" | "failed"} />;
}
