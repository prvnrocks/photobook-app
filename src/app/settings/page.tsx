// Settings (M9 T10 / D-032; M24 emerald restyle, D-076): the library-width app header, the emerald
// SettingsBand (back to My books, ACCOUNT, Settings, signed-in email chip), then ≥ lg a sticky section
// nav beside the cards column (Account, Email reminders, What the AI has learned, Danger zone); phones
// stack the cards. Restyle only: same settings, copy, testids and server actions.
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ChevronLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { DeleteAccount } from "@/components/settings/DeleteAccount";
import { EmailRemindersToggle } from "@/components/settings/EmailRemindersToggle";
import { SettingsAccount } from "@/components/settings/SettingsAccount";
import { SettingsBand } from "@/components/settings/SettingsBand";
import { SettingsMemory } from "@/components/settings/SettingsMemory";
import { SettingsNav } from "@/components/settings/SettingsNav";
import {
  SETTINGS_ANCHOR,
  SETTINGS_BAND_BACK,
  SETTINGS_COLUMNS,
  SETTINGS_CONTAINER,
  SETTINGS_CONTENT,
  SETTINGS_DANGER_LABEL,
  SETTINGS_DANGER_ZONE,
  SETTINGS_FOOT_LINK,
} from "@/components/settings/settings-page-classes";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOwnEmailReminders } from "@/lib/db/account";
import { getOwnMemoryView, type OwnMemoryView } from "@/lib/db/memory";
import { getMyProfile } from "@/lib/db/profiles";

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
      <AppHeader displayName={displayName} width="library" />
      <main>
        <SettingsBand
          email={email}
          back={
            <Link href="/dashboard" className={SETTINGS_BAND_BACK}>
              <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
              My books
            </Link>
          }
        />
        <div className={`${SETTINGS_CONTAINER} ${SETTINGS_COLUMNS}`}>
          <aside className="hidden lg:block lg:self-stretch">
            <SettingsNav />
          </aside>
          <div className={SETTINGS_CONTENT}>
            <div id="account" className={SETTINGS_ANCHOR}>
              <SettingsAccount email={email} />
            </div>
            <div id="email-reminders" className={SETTINGS_ANCHOR}>
              <EmailRemindersToggle initialOn={remindersOn} />
            </div>
            <div id="ai-memory" className={SETTINGS_ANCHOR}>
              <SettingsMemory view={memory} />
            </div>

            {/* Danger zone: set apart by space, a dashed rule and its own label so it never reads as a regular setting. */}
            <div id="danger-zone" className={`${SETTINGS_ANCHOR} ${SETTINGS_DANGER_ZONE}`} data-testid="settings-danger-zone">
              <p className={SETTINGS_DANGER_LABEL}>Danger zone</p>
              <DeleteAccount />
            </div>

            <Link href="/dashboard" className={SETTINGS_FOOT_LINK} data-testid="back-to-dashboard">
              <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
              Back to my books
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
