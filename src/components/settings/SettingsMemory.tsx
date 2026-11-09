// "What the AI has learned" section of /settings (D-032). Presentational: the page loads the
// view; `view === undefined` means loading failed. Only friendly labels are shown, never raw prefs.
import { SettingsClearButton } from "@/components/settings/SettingsClearButton";
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
          <li
            key={`${i}-${v}`}
            dir="auto"
            className="max-w-full rounded-full bg-muted px-2.5 py-0.5 text-sm break-words"
          >
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
      className="flex min-w-0 flex-col gap-4 rounded-xl border p-4"
      data-testid="settings-memory"
    >
      <h2 id="settings-memory-heading" className="text-lg font-semibold">
        {SETTINGS_COPY.memoryHeading}
      </h2>
      {failed ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="settings-error"
        >
          {SETTINGS_COPY.loadError}
        </p>
      ) : empty ? (
        <p className="text-sm text-muted-foreground" data-testid="settings-empty">
          {SETTINGS_COPY.empty}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <dl className="flex min-w-0 flex-col divide-y" data-testid="settings-memory-list">
            {rows.map((row) => (
              <div
                key={row.key}
                className="flex min-w-0 flex-col gap-1 py-2.5 first:pt-0 last:pb-0"
                data-testid={`settings-row-${row.key}`}
              >
                <dt className="text-sm text-muted-foreground">{row.label}</dt>
                <dd className="min-w-0 text-base font-medium">
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
      <p className="text-sm text-muted-foreground" data-testid="settings-privacy">
        {SETTINGS_COPY.privacy}
      </p>
      {/* Stable position: keeps the "Cleared" message across router.refresh(). */}
      <SettingsClearButton hasMemory={!failed && !empty} />
    </section>
  );
}
