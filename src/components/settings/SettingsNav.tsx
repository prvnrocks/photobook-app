// Settings section nav (M24, D-076): ≥ lg a sticky card of plain anchor links to the cards on the
// right (44 px rows); hidden on phones, where the four cards stack on a short page. Server component.

import { Bell, Sparkles, TriangleAlert, UserRound, type LucideIcon } from "lucide-react";
import { SETTINGS_NAV, SETTINGS_NAV_LINK, SETTINGS_NAV_LINK_DANGER } from "@/components/settings/settings-page-classes";
import { ACCOUNT_COPY } from "@/lib/settings/account";
import { SETTINGS_COPY } from "@/lib/settings/ui";

/** Anchor ids of the settings sections, in page order. */
export const SETTINGS_SECTIONS: readonly { id: string; label: string; icon: LucideIcon; danger?: boolean }[] = [
  { id: "account", label: "Account", icon: UserRound },
  { id: "email-reminders", label: ACCOUNT_COPY.remindersHeading, icon: Bell },
  { id: "ai-memory", label: SETTINGS_COPY.memoryHeading, icon: Sparkles },
  { id: "danger-zone", label: "Danger zone", icon: TriangleAlert, danger: true },
];

export function SettingsNav() {
  return (
    <nav aria-label="Settings sections" className={SETTINGS_NAV} data-testid="settings-nav">
      <ul className="flex flex-col gap-0.5">
        {SETTINGS_SECTIONS.map(({ id, label, icon: Icon, danger }) => (
          <li key={id}>
            <a href={`#${id}`} className={danger ? SETTINGS_NAV_LINK_DANGER : SETTINGS_NAV_LINK} data-testid={`settings-nav-${id}`}>
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
