// One selectable card in a wizard choice grid (M19 T2 D-071; M20 T2 D-072): occasion icons (compact)
// and shape / style previews (large). A visually hidden native radio inside the label does selection,
// keyboard (arrow keys within the name group) and form submission; the card styles itself with
// has-checked: (emerald #1f6f54 border + ring, soft emerald tint, emerald check badge with a white
// tick 5.9:1) and has-focus-visible: (ring). Motion (wizard-motion.css, .wz-choice): a springy bounce
// when checked, the badge pops in, a hover lift on pointer devices, a press-in on tap; reduced motion:
// no transforms (colour change only).
// No hooks and no cn/next/link: cheap inside first-load client islands. Fits 2- or 3-column grids
// at 375 px (min-w-0, label wraps, ≥ 44 px tall).

import type { ChangeEvent, ReactNode } from "react";
import { cx as join } from "@/lib/cx";
import "./wizard-motion.css";

export type ChoiceCardProps = {
  /** Radio group name (also the form field name). */
  name: string;
  value: string;
  label: string;
  /** Icon (compact) or preview art (large). Decorative: give it aria-hidden. */
  media?: ReactNode;
  /** Optional second line under the label. */
  hint?: string;
  /**
   * Optional small pill in the top start corner (e.g. "Recommended"). Part of the label, so it is
   * read with the option's name; text, never colour alone.
   */
  badge?: string;
  /** Controlled; omit and use defaultChecked for an uncontrolled form. */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  /**
   * Also called when the option is tapped while it is already selected (a radio fires no change
   * then) — for groups where "shown as selected" (a default / a recommendation) and "chosen by the
   * user" differ.
   */
  onPick?: (value: string) => void;
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
  badge,
  checked,
  defaultChecked,
  onChange,
  onPick,
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
        "wz-choice group/choice relative flex min-h-11 min-w-0 cursor-pointer flex-col items-center justify-center rounded-2xl border border-border bg-card text-center shadow-card",
        size === "compact" ? "gap-2 px-2 py-4" : "gap-3 p-3 pb-4",
        "hover:border-success-border",
        "has-checked:border-success has-checked:bg-success-soft has-checked:ring-1 has-checked:ring-success",
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
        onClick={onPick ? () => onPick(value) : undefined}
        // A controlled radio without onChange would warn; readOnly only when nothing handles change.
        readOnly={checked !== undefined && !onChange ? true : undefined}
        disabled={disabled}
        required={required}
        className="sr-only"
      />
      {/* Corner check badge, shown only when checked. */}
      <span
        aria-hidden="true"
        className="wz-choice-check absolute end-2 top-2 hidden size-6 items-center justify-center rounded-full bg-success text-white shadow-card group-has-checked/choice:flex"
      >
        <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {badge ? (
        <span
          className="absolute start-2 top-2 z-[1] max-w-[calc(100%-3rem)] truncate rounded-full border border-accent-strong/70 bg-accent-strong px-2 py-0.5 text-xs leading-5 font-semibold text-accent-strong-foreground shadow-card"
          data-testid="choice-badge"
        >
          {badge}
        </span>
      ) : null}
      {media ? (
        <span
          aria-hidden="true"
          className={join(
            "flex items-center justify-center text-accent-text group-has-checked/choice:text-success",
            size === "compact" ? "[&_svg]:size-8" : "w-full",
          )}
        >
          {media}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-col items-center">
        <span className="text-base leading-snug font-medium break-words text-foreground group-has-checked/choice:text-primary">
          {label}
        </span>
        {hint ? <span className="type-small mt-0.5 text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}
