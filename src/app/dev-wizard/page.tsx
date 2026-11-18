// Dev-only: the wizard's Story (step 4) and Design (step 5) steps with fixture data, for 375 px checks
// and screenshots without auth, photos or a database (Task 5; docs/design/task5-*.png).
//   /dev-wizard?step=story[&occasion=travel|birthday|…][&fill=1]
//   /dev-wizard?step=design[&occasion=…][&rec=landscape|portrait|mixed|none]
//   /dev-wizard?step=occasion   (the seven occasion cards)
// The server actions are replaced by local stubs (nothing is loaded or saved).
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OCCASIONS, type Occasion } from "@/lib/book/options";
import { DevWizardClient, type DevWizardRec, type DevWizardStep } from "./DevWizardClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Wizard steps (dev)" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function DevWizardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const stepParam = first(params.step);
  const step: DevWizardStep = stepParam === "design" || stepParam === "occasion" ? stepParam : "story";
  const occasionParam = first(params.occasion) ?? "travel";
  const occasion = (OCCASIONS as readonly string[]).includes(occasionParam) ? (occasionParam as Occasion) : null;
  const recParam = first(params.rec);
  const rec: DevWizardRec = recParam === "portrait" || recParam === "mixed" || recParam === "none" ? recParam : "landscape";
  return <DevWizardClient step={step} occasion={occasion} rec={rec} fill={first(params.fill) === "1"} />;
}
