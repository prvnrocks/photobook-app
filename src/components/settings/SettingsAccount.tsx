// Settings → "Account" card (M24, D-076): the signed-in email in a cream definition list. Display
// only (no new features). The email is user text → dir="auto". Server component.

import { UserRound } from "lucide-react";
import { SETTINGS_CARD, SETTINGS_CARD_HEAD, SETTINGS_CARD_HEADING, SETTINGS_ICON_CHIP } from "@/components/settings/settings-classes";
import { SETTINGS_DD, SETTINGS_DT, SETTINGS_ROW, SETTINGS_WELL } from "@/components/settings/settings-page-classes";

export function SettingsAccount({ email }: { email: string | null }) {
  return (
    <section aria-labelledby="settings-account-heading" className={SETTINGS_CARD} data-testid="settings-account">
      <div className={SETTINGS_CARD_HEAD}>
        <span aria-hidden="true" className={SETTINGS_ICON_CHIP}>
          <UserRound className="size-5" />
        </span>
        <h2 id="settings-account-heading" className={`${SETTINGS_CARD_HEADING} self-center`}>
          Account
        </h2>
      </div>
      <dl className={SETTINGS_WELL}>
        <div className={SETTINGS_ROW}>
          <dt className={SETTINGS_DT}>Email</dt>
          <dd className={`${SETTINGS_DD} break-all`}>
            {email ? (
              <span dir="auto" data-testid="settings-account-email">
                {email}
              </span>
            ) : (
              <span className="font-normal text-muted-foreground">Not available</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
