"use client";

// Accent colour panel (M30 T13, D-090; lazy chunk — the tool descriptor is ./accent-colour.tsx):
// pick the book's accent colourway — the colour of the rules,
// headings, panels and cover details in magazine / editorial books. Six swatches with their names;
// the one in use carries the emerald ring + check. A tap = one setColourway edit = one undo step,
// stored as the user's choice (source "user": the AI never replaces it). Like Cover style (D-083)
// the panel docks under the page on phones and stays open, so colours can be compared on the page.
// Absent for the four older styles (no colourways).

import { Check } from "lucide-react";
import { setColourway } from "@/lib/book/edit-ops";
import type { ColourwayId } from "@/lib/book/types";
import { accentOptions, type AccentOption } from "@/lib/editor/accent";
import { cx } from "@/lib/cx";
import type { EditorContextValue } from "../editor-context";
import { CHECK_BADGE, TOOL_OPTION, TOOL_OPTION_ACTIVE } from "./tool-classes";
import type { EditorPanelProps } from "./types";

/** Apply a colourway: one edit (one undo step); a no-op for the one in use or read-only. */
export function applyAccent(ctx: Pick<EditorContextValue, "readOnly" | "actions" | "state">, id: ColourwayId): void {
  if (ctx.readOnly) return;
  if (accentOptions(ctx.state.doc).some((o) => o.current && o.colourway.id === id)) return;
  ctx.actions.edit((d) => setColourway(d, id));
}

export function AccentColourPanel({ ctx }: EditorPanelProps) {
  const options = accentOptions(ctx.state.doc);
  return (
    <div className="flex flex-col gap-3" data-testid="accent-picker">
      <p className="text-sm text-muted-foreground">Changes headings, lines and panels in the whole book. Tap a colour to try it.</p>
      <ul className="grid grid-cols-3 gap-2 lg:grid-cols-2" aria-label="Accent colours">
        {options.map((o) => (
          <AccentSwatch key={o.colourway.id} o={o} ctx={ctx} />
        ))}
      </ul>
    </div>
  );
}

function AccentSwatch({ o, ctx }: { o: AccentOption; ctx: EditorContextValue }) {
  const { colourway: c, swatch } = o;
  return (
    <li>
      <button
        type="button"
        onClick={() => applyAccent(ctx, c.id)}
        disabled={ctx.readOnly}
        aria-pressed={o.current}
        aria-label={`${c.label}${o.current ? " (current)" : ""}`}
        className={cx(o.current ? TOOL_OPTION_ACTIVE : TOOL_OPTION, "relative flex min-h-16 w-full flex-col items-center justify-center gap-1.5 px-1 py-2")}
        data-testid="accent-option"
        data-colourway={c.id}
        data-current={o.current ? "true" : undefined}
      >
        {o.current ? (
          <span className={CHECK_BADGE} aria-hidden="true">
            <Check className="size-3" strokeWidth={3} />
          </span>
        ) : null}
        <span
          aria-hidden="true"
          className="flex size-8 items-center justify-center rounded-full ring-1 ring-black/15"
          style={{ background: swatch.base }}
        >
          <span className="size-4 rounded-full" style={{ background: swatch.dot }} />
        </span>
        <span className="text-xs leading-tight font-semibold">{c.label}</span>
      </button>
    </li>
  );
}
