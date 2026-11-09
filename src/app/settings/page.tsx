import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { SettingsMemory } from "@/components/settings/SettingsMemory";
import { buttonVariants } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOwnMemoryView, type OwnMemoryView } from "@/lib/db/memory";
import { getMyProfile } from "@/lib/db/profiles";
import { SETTINGS_COPY } from "@/lib/settings/ui";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings" };

/** undefined = couldn't load (shown as a friendly error); null = nothing learned yet. */
async function loadMemory(): Promise<OwnMemoryView | null | undefined> {
  try {
    return await getOwnMemoryView();
  } catch {
    return undefined;
  }
}

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=%2Fsettings");

  const [profile, memory] = await Promise.all([getMyProfile().catch(() => null), loadMemory()]);
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto w-full max-w-md px-4 py-6">
        <h1 className="mb-6 text-2xl font-semibold" data-testid="settings-heading">
          {SETTINGS_COPY.heading}
        </h1>
        <SettingsMemory view={memory} />
        <Link
          href="/dashboard"
          className={cn(buttonVariants({ variant: "ghost" }), "mt-4 h-11 w-full px-4 text-base")}
          data-testid="back-to-dashboard"
        >
          Back to my books
        </Link>
      </main>
    </>
  );
}
