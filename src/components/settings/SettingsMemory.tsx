// "What the AI has learned" section of /settings (D-032). Presentational: the page loads the
// view; `view === undefined` means loading failed. Only friendly labels are shown, never raw prefs.
// M24 (D-076): ivory card, the rows as a definition list in a cream well, emerald outline Clear.
import { Sparkles } from "lucide-react";
import { Notice } from "@/components/app/Notice";
import { SettingsClearButton } from "@/components/settings/SettingsClearButton";
import { SETTINGS_CARD, SETTINGS_CARD_HEAD, SETTINGS_CARD_HEADING, SETTINGS_ICON_CHIP } from "@/components/settings/settings-classes";
import {
  SETTINGS_DD,
  SETTINGS_DT,
  SETTINGS_ROW,
  SETTINGS_VALUE_CHIP,
  SETTINGS_WELL,
} from "@/components/settings/settings-page-classes";
import {
  isMemoryViewEmpty,
  lastUpdatedLabel,
  memoryRows,
  SETTINGS_COPY,
  type MemoryRow,
  type MemoryViewLike,
} from "@/lib/settings/ui";

function RowValue({ row }: { row: MemoryRow }) {
  if (row.key === "language") {
    return row.lang === "ar" ? (
      <span lang="ar" dir="rtl" className="font-arabic" data-testid="settings-language-value">
        {row.value}
      </span>
    ) : (
      <span data-testid="settings-language-value">{row.value}</span>
    );
  }
  if ("values" in row) {
    return (
      <ul className="flex min-w-0 flex-wrap gap-1.5">
        {row.values.map((v, i) => (
          <li key={`${i}-${v}`} dir="auto" className={SETTINGS_VALUE_CHIP}>
            {v}
          </li>
        ))}
      </ul>
    );
  }
  return <span>{row.value}</span>;
}

export function SettingsMemory({ view }: { view: MemoryViewLike | null | undefined }) {
  const failed = view === undefined;
  const empty = !failed && isMemoryViewEmpty(view);
  const rows = failed ? [] : memoryRows(view);
  const updated = failed || empty ? null : lastUpdatedLabel(view?.updatedAt);

  return (
    <section
      aria-labelledby="settings-memory-heading"
      className={SETTINGS_CARD}
      data-testid="settings-memory"
    >
      <div className={SETTINGS_CARD_HEAD}>
        <span aria-hidden="true" className={SETTINGS_ICON_CHIP}>
          <Sparkles className="size-5" />
        </span>
        <h2 id="settings-memory-heading" className={`${SETTINGS_CARD_HEADING} self-center`}>
          {SETTINGS_COPY.memoryHeading}
        </h2>
      </div>
      {failed ? (
        <Notice tone="error" data-testid="settings-error">
          {SETTINGS_COPY.loadError}
        </Notice>
      ) : empty ? (
        <p className="type-small text-muted-foreground" data-testid="settings-empty">
          {SETTINGS_COPY.empty}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <dl className={`${SETTINGS_WELL} flex flex-col divide-y divide-[#e9dfca]`} data-testid="settings-memory-list">
            {rows.map((row) => (
              <div key={row.key} className={SETTINGS_ROW} data-testid={`settings-row-${row.key}`}>
                <dt className={SETTINGS_DT}>{row.label}</dt>
                <dd className={SETTINGS_DD}>
                  <RowValue row={row} />
                </dd>
              </div>
            ))}
          </dl>
          {updated ? (
            <p className="text-xs text-muted-foreground" data-testid="settings-updated">
              {updated}
            </p>
          ) : null}
        </div>
      )}
      <p className="type-small text-muted-foreground" data-testid="settings-privacy">
        {SETTINGS_COPY.privacy}
      </p>
      {/* Stable position: keeps the "Cleared" message across router.refresh(). */}
      <SettingsClearButton hasMemory={!failed && !empty} />
    </section>
  );
}
