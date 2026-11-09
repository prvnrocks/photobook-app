// Dev-only: the editor shell with fixture data and a stubbed save, for 375 px checks without
// auth. `?save=ok|conflict|unavailable|offline|invalid|readonly` picks the save outcome.
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { DEV_SAVE_MODES, type DevSaveMode } from "@/lib/editor/dev-fixture";
import { DevEditorClient } from "./DevEditorClient";

export const dynamic = "force-dynamic";

export const viewport: Viewport = { viewportFit: "cover" };

export default async function DevEditorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const q = (await searchParams).save;
  const mode = (DEV_SAVE_MODES as readonly string[]).includes(String(q)) ? (q as DevSaveMode) : "ok";
  return <DevEditorClient mode={mode} />;
}
