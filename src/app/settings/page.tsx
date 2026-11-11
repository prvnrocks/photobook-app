import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { AppHeader } from "@/components/layout/AppHeader";
import { DeleteAccount } from "@/components/settings/DeleteAccount";
import { EmailRemindersToggle } from "@/components/settings/EmailRemindersToggle";
import { SettingsMemory } from "@/components/settings/SettingsMemory";
import { buttonVariants } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOwnEmailReminders } from "@/lib/db/account";
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

  const [profile, memory, remindersOn] = await Promise.all([
    getMyProfile().catch(() => null),
    loadMemory(),
    // null = couldn't load (the section shows a friendly error instead of a possibly wrong switch).
    getOwnEmailReminders(user.id).catch(() => null),
  ]);
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;
  const email = profile?.email ?? user.email ?? null;

  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto w-full max-w-app px-gutter pt-4 pb-12">
        <Link
          href="/dashboard"
          className="-ms-3 inline-flex h-11 w-fit items-center gap-1 rounded-lg ps-2 pe-3 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
          My books
        </Link>
        <header className="mt-2 mb-stack">
          <p className="type-eyebrow mb-2">Account</p>
          <h1 className="type-h1 text-foreground" data-testid="settings-heading">
            {SETTINGS_COPY.heading}
          </h1>
          {email ? (
            <p className="type-small mt-2 text-muted-foreground">
              Signed in as{" "}
              <span dir="auto" className="font-medium break-all text-foreground" data-testid="settings-email">
                {email}
              </span>
            </p>
          ) : null}
        </header>
        <div className="flex min-w-0 flex-col gap-4">
          <EmailRemindersToggle initialOn={remindersOn} />
          <SettingsMemory view={memory} />
        </div>

        {/* Danger zone: set apart by space, a rule and its own label so it never reads as a regular setting. */}
        <div className="mt-section border-t border-dashed border-destructive-border pt-stack">
          <p className="mb-3 text-xs font-semibold tracking-[0.14em] text-destructive uppercase">Danger zone</p>
          <DeleteAccount />
        </div>

        <Link
          href="/dashboard"
          className={cn(buttonVariants({ variant: "ghost", size: "touch" }), "mt-6 w-full text-base")}
          data-testid="back-to-dashboard"
        >
          Back to my books
        </Link>
      </main>
    </>
  );
}
