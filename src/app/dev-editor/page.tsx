// Dev-only: the editor shell with fixture data and a stubbed save, for 375 px checks without
// auth. `?save=ok|conflict|unavailable|offline|invalid|readonly` picks the save outcome;
// `?ai=off|replay|limit` the AI caption state (Task 10).
// `?pages=20` grows the fixture to 20 pages in 3 chapters (free-limit checks, Task 11).
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { DEV_AI_MODES, DEV_SAVE_MODES, type DevAiMode, type DevSaveMode } from "@/lib/editor/dev-fixture";
import { parseDevPages } from "@/lib/editor/dev-pages-fixture";
import { DevEditorClient } from "./DevEditorClient";

export const dynamic = "force-dynamic";

export const viewport: Viewport = { viewportFit: "cover" };

export default async function DevEditorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const q = params.save;
  const mode = (DEV_SAVE_MODES as readonly string[]).includes(String(q)) ? (q as DevSaveMode) : "ok";
  const ai = (DEV_AI_MODES as readonly string[]).includes(String(params.ai)) ? (params.ai as DevAiMode) : "off";
  return <DevEditorClient mode={mode} ai={ai} pages={parseDevPages(params.pages)} />;
}
