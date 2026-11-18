"use client";

// Filter (D-089): give the selected photo a look — richer colour, warm gold, soft matte, black &
// white, sepia… Each option is the photo's own thumbnail wearing that filter (CSS filter from the
// shared recipe, src/lib/design/photo-filters.ts), so the user sees what they get; "Original" is
// the photo as shot. The look belongs to the photo (doc.filters), so it follows it through swaps
// and layout changes. One tap = one setPhotoFilter edit = one undo step; the panel stays open and
// is docked under the page on phones, so the big page updates while comparing.
// New albums start with a look on about a third of their photos (default-filters.ts) — change or
// remove any of them here.

import { Check, ImageIcon, Wand2 } from "lucide-react";
import { setPhotoFilter } from "@/lib/book/edit-ops";
import { filterCss, PHOTO_FILTERS, type PhotoFilterId } from "@/lib/design/photo-filters";
import type { EditorContextValue } from "../editor-context";
import { CHECK_BADGE, TOOL_PHOTO_TILE, TOOL_PHOTO_TILE_ACTIVE } from "./tool-classes";
import type { EditorPanelProps, EditorTool } from "./types";

type FilterTarget = { photoId: string; current: PhotoFilterId | null; thumb: string | null };

/** The photo the Filter tool edits for the current selection (a filled slot or the cover photo), or null. */
export function filterTarget(ctx: Pick<EditorContextValue, "state" | "photos">): FilterTarget | null {
  const sel = ctx.state.selection;
  const doc = ctx.state.doc;
  let photoId: string | null = null;
  if (sel?.kind === "slot") photoId = doc.pages[sel.pageIdx]?.slots[sel.slotIdx]?.photoId ?? null;
  else if (sel?.kind === "cover" && sel.part === "photo") photoId = doc.cover.photoId;
  if (photoId === null) return null;
  const f = doc.filters && Object.prototype.hasOwnProperty.call(doc.filters, photoId) ? doc.filters[photoId] : null;
  const thumb = ctx.photos.thumbs[photoId]?.url ?? ctx.photos.web[photoId]?.url ?? null;
  return { photoId, current: f ?? null, thumb };
}

export function PhotoFilterPanel({ ctx }: EditorPanelProps) {
  const t = filterTarget(ctx);
  if (!t) return null;
  const sel = ctx.state.selection;
  const pick = (filter: PhotoFilterId | null) => {
    if (ctx.readOnly) return;
    ctx.actions.edit((d) => setPhotoFilter(d, t.photoId, filter), { select: sel });
  };
  return (
    <div className="flex flex-col gap-3" data-testid="photo-filter-picker">
      <p className="text-sm text-muted-foreground">Tap a look to try it on this photo.</p>
      <ul className="grid grid-cols-4 gap-2 lg:grid-cols-3" aria-label="Photo filters">
        <li>
          <FilterTile label="Original" hint="The photo as shot" css={undefined} thumb={t.thumb} current={t.current === null} disabled={ctx.readOnly} onPick={() => pick(null)} id="none" />
        </li>
        {PHOTO_FILTERS.map((f) => (
          <li key={f.id}>
            <FilterTile label={f.label} hint={f.hint} css={filterCss(f.id)} thumb={t.thumb} current={t.current === f.id} disabled={ctx.readOnly} onPick={() => pick(f.id)} id={f.id} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilterTile({
  id,
  label,
  hint,
  css,
  thumb,
  current,
  disabled,
  onPick,
}: {
  id: string;
  label: string;
  hint: string;
  css: string | undefined;
  thumb: string | null;
  current: boolean;
  disabled: boolean;
  onPick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={current}
      aria-label={`${label}: ${hint}${current ? " (current)" : ""}`}
      title={hint}
      className="group flex w-full flex-col items-stretch gap-1 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      data-testid="photo-filter-option"
      data-filter-id={id}
      data-current={current ? "true" : undefined}
    >
      {/* The tile recipe as a span: the button also holds the label under it. */}
      <span className={current ? TOOL_PHOTO_TILE_ACTIVE : TOOL_PHOTO_TILE} aria-hidden="true">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs
          <img src={thumb} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full object-cover" style={css ? { filter: css } : undefined} />
        ) : (
          <ImageIcon className="absolute inset-0 m-auto size-6 text-muted-foreground" />
        )}
        {current ? (
          <span className={CHECK_BADGE}>
            <Check className="size-3" strokeWidth={3} />
          </span>
        ) : null}
      </span>
      <span className={current ? "truncate text-center text-xs font-bold text-[#0e3b2e]" : "truncate text-center text-xs font-medium text-[#56625a]"}>{label}</span>
    </button>
  );
}

export const photoFilterTool: EditorTool = {
  id: "filter",
  label: "Filter",
  icon: Wand2,
  scopes: ["slot", "cover"],
  order: 14,
  tier: "primary",
  panelTitle: "Photo filter",
  // Live preview: keep the page visible above the panel on phones.
  dockOnMobile: true,
  // Tapping another photo keeps this panel open on the new photo.
  keepOnSelect: true,
  isAvailable: (ctx) => filterTarget(ctx) !== null,
  Panel: PhotoFilterPanel,
};
