// One selectable card in a wizard choice grid (M19 T2, D-071): occasion icons (compact) and shape /
// style previews (large). A visually hidden native radio inside the label does selection, keyboard
// (arrow keys within the name group) and form submission; the card styles itself with has-checked:
// (deep emerald border + soft emerald tint + corner check badge) and has-focus-visible: (ring).
// No hooks and no cn/next/link: cheap inside first-load client islands. Fits 2- or 3-column grids
// at 375 px (min-w-0, label wraps, ≥ 44 px tall).

import type { ChangeEvent, ReactNode } from "react";

const join = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export type ChoiceCardProps = {
  /** Radio group name (also the form field name). */
  name: string;
  value: string;
  label: string;
  /** Icon (compact) or preview art (large). Decorative: give it aria-hidden. */
  media?: ReactNode;
  /** Optional second line under the label. */
  hint?: string;
  /** Controlled; omit and use defaultChecked for an uncontrolled form. */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  required?: boolean;
  /** "compact" = icon over label (occasion); "large" = big preview over label (shape, style). */
  size?: "compact" | "large";
  testId?: string;
  className?: string;
};

export function ChoiceCard({
  name,
  value,
  label,
  media,
  hint,
  checked,
  defaultChecked,
  onChange,
  disabled,
  required,
  size = "compact",
  testId,
  className,
}: ChoiceCardProps) {
  return (
    <label
      data-testid={testId}
      data-choice={value}
      className={join(
        "group/choice relative flex min-h-11 min-w-0 cursor-pointer flex-col items-center justify-center rounded-2xl border border-border bg-card text-center shadow-card transition-colors motion-reduce:transition-none",
        size === "compact" ? "gap-2 px-2 py-4" : "gap-3 p-3 pb-4",
        "hover:border-input/60",
        "has-checked:border-primary has-checked:bg-success-soft has-checked:ring-1 has-checked:ring-primary",
        "has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-background",
        "has-disabled:cursor-not-allowed has-disabled:opacity-60",
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        defaultChecked={defaultChecked}
        onChange={onChange ? (e) => onChange(value, e) : undefined}
        // A controlled radio without onChange would warn; readOnly only when nothing handles change.
        readOnly={checked !== undefined && !onChange ? true : undefined}
        disabled={disabled}
        required={required}
        className="sr-only"
      />
      {/* Corner check badge, shown only when checked. */}
      <span
        aria-hidden="true"
        className="absolute end-2 top-2 hidden size-6 items-center justify-center rounded-full bg-primary text-primary-foreground group-has-checked/choice:flex"
      >
        <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {media ? (
        <span
          aria-hidden="true"
          className={join(
            "flex items-center justify-center text-accent-text",
            size === "compact" ? "[&_svg]:size-8" : "w-full",
          )}
        >
          {media}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-col items-center">
        <span className="text-base leading-snug font-medium break-words text-foreground">{label}</span>
        {hint ? <span className="type-small mt-0.5 text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}
