"use client";

// Background (M10a A8): page / book background picker. Tabs Colour / Paper / Photo, scope
// "This page" (page.background, source "user") or "Whole book" (style.background; replaces page
// overrides, one undo step). Every tap is an edit op, so the page previews it live, autosave and
// undo follow. The cover only has the book background. Fade / veil colour changes of the
// existing book photo keep page overrides (keepsPageOverrides); other "Whole book" changes
// replace them with a warning + Undo toast. Radio groups: one tab stop, arrow keys (N5); the
// "Whole book" photo grid is manual activation (arrows move focus, Enter / Space applies — one
// edit, not one per keypress; M10b A4). The fade slider shows the stored fade. Caption ink follows the background in
// <BookPage> (render.ts resolveBackground) — nothing to do here.
// Pure helpers + copy: src/lib/editor/background-picker.ts.
// M22 T6a (D-074): emerald segmented scope, emerald underline type tabs, paper cards and photo
// tiles with an emerald ring + check badge, swatches with an emerald ring, panel small-caps labels,
// quiet Reset. Swatch grids drop to 5 columns in the 20 rem side panel (≥ 44 px targets).

import { Check, ImageIcon, PaintBucket, RotateCcw, Sparkles } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  pageBackgroundOverrideCount,
  resetPageBackground,
  setBookBackground,
  setCoverBackground,
  setPageBackground,
} from "@/lib/book/edit-ops";
import type { Background } from "@/lib/book/types";
import { BACKGROUND_SWATCHES, TEXTURE_IDS, textureById, type BackgroundSwatch, type Texture, type TextureId } from "@/lib/design/backgrounds";
import {
  availableScopes,
  backgroundPageIdx,
  backgroundPhotoCandidates,
  currentBackground,
  FADE_MAX,
  FADE_STEP,
  fadeSlider,
  scopeChoices,
  scopeTab,
  scopeTabs,
  isSuggested,
  nextFade,
  pageOverride,
  photoBackground,
  planBookBackground,
  sameHex,
  TINT_SWATCHES,
  VEIL_SWATCHES,
  withVeilColor,
  type BackgroundScope,
  type BackgroundTab,
} from "@/lib/editor/background-picker";
import { rovingTabStop } from "@/lib/editor/roving";
import type { EditorShellPhoto } from "@/lib/editor/types";
import { cx } from "@/lib/cx";
import { ED_CTA_QUIET, ED_PANEL_EYEBROW } from "../editor-classes";
import { showEditorToast } from "../EditorToast";
import { onRadioGroupKeyDown, onRadioGroupKeyDownFocusOnly } from "../radio-group-keys";
import { CHECK_BADGE, SEG, SEG_ACTIVE, SEG_GROUP, TOOL_PHOTO_TILE, TOOL_PHOTO_TILE_ACTIVE, TOOL_TILE, TOOL_TILE_ACTIVE } from "./tool-classes";
import type { EditorPanelProps, EditorTool } from "./types";

/** Background type tab (underline), idle / selected — alternatives, never both. */
const BG_TAB =
  "-mb-px min-h-11 border-b-2 border-transparent text-sm font-semibold text-[#56625a] transition-colors outline-none hover:text-[#0e3b2e] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0e3b2e] motion-reduce:transition-none";
const BG_TAB_ACTIVE =
  "-mb-px min-h-11 border-b-2 border-[#0e3b2e] text-sm font-semibold text-[#0e3b2e] transition-colors outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0e3b2e] motion-reduce:transition-none";

/** Round swatch, idle / selected (emerald ring) — alternatives. Focus is an outline. */
const SWATCH =
  "relative flex aspect-square w-full min-w-0 items-center justify-center rounded-full border border-black/15 transition-shadow outline-none hover:shadow-[0_0_0_3px_rgb(14_59_46/0.18)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none motion-reduce:transition-none";
const SWATCH_ACTIVE =
  "relative flex aspect-square w-full min-w-0 items-center justify-center rounded-full border border-black/15 ring-2 ring-[#0e3b2e] ring-offset-2 ring-offset-white transition-shadow outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none";

let sessionSeq = 0;

export function BackgroundPickerPanel({ ctx }: EditorPanelProps) {
  const { doc } = ctx.state;
  const pageIdx = backgroundPageIdx(doc, ctx.state.page);
  const scopes = availableScopes(pageIdx);
  const [scopePref, setScope] = useState<BackgroundScope>(scopes[0]);
  const scope: BackgroundScope = scopes.includes(scopePref) ? scopePref : scopes[0];
  const current = currentBackground(doc, scope, pageIdx);
  const [tab, setTab] = useState<BackgroundTab>(() => scopeTab(doc, scope, pageIdx));
  const [session] = useState(() => ++sessionSeq);
  const photos = useMemo(() => backgroundPhotoCandidates(ctx.photos.photos), [ctx.photos.photos]);

  const apply = (bg: Background, coalesceKey?: string) => {
    if (ctx.readOnly) return;
    if (scope === "page" && pageIdx !== null) {
      ctx.actions.edit((d) => setPageBackground(d, pageIdx, bg), { goTo: pageIdx, coalesceKey });
      return;
    }
    if (scope === "cover") {
      ctx.actions.edit((d) => setCoverBackground(d, bg), { goTo: "cover", coalesceKey });
      return;
    }
    // Fade / veil colour of the same book photo is an adjustment: page overrides stay, no toast.
    const { keepPageOverrides, replaced } = planBookBackground(doc, bg);
    ctx.actions.edit((d) => setBookBackground(d, bg, { keepPageOverrides }), { coalesceKey });
    if (replaced > 0) {
      showEditorToast({
        message: `Whole book updated (${replaced === 1 ? "1 page" : `${replaced} pages`} lost their own background)`,
        action: { label: "Undo", run: ctx.actions.undo },
        dismissOnEdit: true,
      });
    }
  };

  const reset = () => {
    if (ctx.readOnly) return;
    if (scope === "cover") ctx.actions.edit((d) => setCoverBackground(d, null), { goTo: "cover" });
    else if (pageIdx !== null) ctx.actions.edit((d) => resetPageBackground(d, pageIdx), { goTo: pageIdx });
  };

  return (
    <BackgroundPickerView
      scopes={scopes}
      scope={scope}
      onScope={(next) => {
        setScope(next);
        // Open the tab of what the new scope shows (a page photo vs a paper book background).
        if (next !== scope) setTab(scopeTab(doc, next, pageIdx));
      }}
      tab={scope === "cover" ? "color" : tab}
      onTab={setTab}
      current={current}
      suggested={isSuggested(doc, pageIdx, scope)}
      hasOverride={scope === "cover" ? doc.cover.background != null : scope === "page" && pageOverride(doc, pageIdx) !== null}
      overrideCount={pageBackgroundOverrideCount(doc)}
      adjustKeepsOverrides={scope === "book" && doc.style.background.kind === "photo"}
      photos={photos}
      disabled={ctx.readOnly}
      onApply={(bg) => apply(bg)}
      onFade={(bg) => apply(bg, `bg-fade:${scope}:${pageIdx ?? "cover"}:${session}`)}
      onReset={reset}
    />
  );
}

export interface BackgroundPickerViewProps {
  scopes: readonly BackgroundScope[];
  scope: BackgroundScope;
  onScope(scope: BackgroundScope): void;
  tab: BackgroundTab;
  onTab(tab: BackgroundTab): void;
  /** What the chosen scope shows now. */
  current: Background;
  /** The page shows an AI suggestion (source "ai"). */
  suggested: boolean;
  /** "This page" has its own background → offer "Reset to book background". */
  hasOverride: boolean;
  /** Pages with their own background ("Whole book" replaces them). */
  overrideCount: number;
  /** "Whole book" shows a photo: fade / veil colour changes keep the pages' own backgrounds. */
  adjustKeepsOverrides?: boolean;
  photos: readonly EditorShellPhoto[];
  disabled?: boolean;
  onApply(bg: Background): void;
  /** Fade slider moves (coalesced into one undo step per panel session). */
  onFade(bg: Background): void;
  onReset(): void;
}

/** Router-free view (static-render tests). */
export function BackgroundPickerView(props: BackgroundPickerViewProps) {
  const { scopes, scope, onScope, tab, onTab, suggested, hasOverride, overrideCount, adjustKeepsOverrides, disabled, onReset } = props;
  const choices = scopeChoices(scopes);
  const tabs = scopeTabs(scope);
  const scopeStop = rovingTabStop(choices.map((s) => ({ checked: scope === s.id, disabled: !scopes.includes(s.id) })));
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="background-picker" data-scope={scope}>
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label="Apply to" onKeyDown={onRadioGroupKeyDown} className={cx(SEG_GROUP, "flex-1 grid-cols-2")} data-testid="bg-scope">
          {choices.map((s, i) => {
            const available = scopes.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={scope === s.id}
                disabled={!available}
                tabIndex={i === scopeStop ? 0 : -1}
                onClick={() => onScope(s.id)}
                className={cx(scope === s.id ? SEG_ACTIVE : SEG, "px-1 text-sm")}
                data-testid={`bg-scope-${s.id}`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        {suggested ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full border border-[#e3c766]/70 bg-[#fbf3dc] px-2.5 py-1 text-xs font-semibold text-accent-text"
            title="Picked by AI. Tap another background to choose your own."
            data-testid="bg-suggested"
          >
            <Sparkles className="size-3" aria-hidden="true" /> Suggested
          </span>
        ) : null}
      </div>
      {scope === "cover" ? (
        <p className="text-xs text-muted-foreground" data-testid="bg-cover-note">
          {hasOverride ? "The cover has its own colour." : "Pick a colour for the cover only. The pages keep theirs."}
        </p>
      ) : scope === "book" && overrideCount > 0 ? (
        <p className="rounded-xl border border-warning-border bg-warning-soft px-3 py-2 text-xs text-foreground" data-testid="bg-replace-note">
          {adjustKeepsOverrides ? "A new background also replaces" : "Also replaces"} the background of{" "}
          {overrideCount === 1 ? "1 page that has" : `${overrideCount} pages that have`} its own.
          {adjustKeepsOverrides ? " Changing the fade keeps them." : null}
        </p>
      ) : null}

      <div role="tablist" aria-label="Background type" className={cx("grid gap-1 border-b border-[#e9dfca]", tabs.length === 1 ? "grid-cols-1" : "grid-cols-3")}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${id}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${id}-panel`}
            onClick={() => onTab(t.id)}
            className={tab === t.id ? BG_TAB_ACTIVE : BG_TAB}
            data-testid={`bg-tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="min-w-0" data-testid={`bg-panel-${tab}`}>
        {tab === "color" ? <ColourTab {...props} /> : tab === "texture" ? <PaperTab {...props} /> : <PhotoTab {...props} />}
      </div>

      {hasOverride ? (
        <button
          type="button"
          onClick={onReset}
          disabled={disabled}
          className={cx(ED_CTA_QUIET, "border border-[#e9dfca]")}
          data-testid="bg-reset"
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          Reset to book background
        </button>
      ) : null}
    </div>
  );
}

function SwatchButton({
  swatch,
  selected,
  disabled,
  onPick,
  testId,
  label,
  tabStop,
}: {
  swatch: BackgroundSwatch;
  selected: boolean;
  /** Roving tab stop of its radio group. */
  tabStop: boolean;
  disabled?: boolean;
  onPick(): void;
  testId: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label ?? swatch.label}
      tabIndex={tabStop ? 0 : -1}
      disabled={disabled}
      onClick={onPick}
      className={selected ? SWATCH_ACTIVE : SWATCH}
      style={{ backgroundColor: swatch.hex }}
      data-testid={testId}
      data-hex={swatch.hex}
    >
      {selected ? (
        <Check className={cx("size-4", swatch.ink === "light" ? "text-white" : "text-neutral-800")} aria-hidden="true" />
      ) : null}
    </button>
  );
}

function ColourTab({ current, disabled, onApply }: BackgroundPickerViewProps) {
  const isSel = (s: BackgroundSwatch) => current.kind === "color" && sameHex(current.hex, s.hex);
  const stop = rovingTabStop(BACKGROUND_SWATCHES.map((s) => ({ checked: isSel(s) })));
  return (
    <div role="radiogroup" aria-label="Colour" onKeyDown={onRadioGroupKeyDown} className="grid grid-cols-6 gap-3 p-1 sm:grid-cols-8 lg:grid-cols-5 xl:grid-cols-6" data-testid="bg-colours">
      {BACKGROUND_SWATCHES.map((s, i) => (
        <SwatchButton
          key={s.id}
          swatch={s}
          tabStop={i === stop}
          selected={isSel(s)}
          disabled={disabled}
          onPick={() => onApply({ kind: "color", hex: s.hex })}
          testId={`bg-colour-${s.id}`}
        />
      ))}
    </div>
  );
}

function textureThumbStyle(t: Texture) {
  return {
    backgroundColor: t.baseHex,
    backgroundImage: `url("${t.screenSrc.portrait}")`,
    backgroundSize: t.kind === "tile" ? "50% auto" : "cover",
    backgroundPosition: "center",
  };
}

const PAPERS: readonly { id: TextureId; t: Texture }[] = TEXTURE_IDS.flatMap((id) => {
  const t = textureById(id);
  return t ? [{ id, t }] : [];
});

function PaperTab({ current, disabled, onApply }: BackgroundPickerViewProps) {
  const texture = current.kind === "texture" ? current : null;
  const tint = texture?.tint ?? null;
  const paperStop = rovingTabStop(PAPERS.map(({ t }) => ({ checked: texture?.textureId === t.id })));
  const tintStop = rovingTabStop([
    { checked: texture !== null && tint === null },
    ...TINT_SWATCHES.map((s) => ({ checked: sameHex(tint, s.hex) })),
  ]);
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Paper" onKeyDown={onRadioGroupKeyDown} className="grid grid-cols-3 gap-2 p-1" data-testid="bg-textures">
        {PAPERS.map(({ id: textureId, t }, i) => {
          const selected = texture?.textureId === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={t.label}
              tabIndex={i === paperStop ? 0 : -1}
              disabled={disabled}
              // Picking another paper keeps the tint the user chose.
              onClick={() => onApply({ kind: "texture", textureId, ...(tint ? { tint } : {}) })}
              className={selected ? TOOL_TILE_ACTIVE : TOOL_TILE}
              data-testid={`bg-texture-${t.id}`}
            >
              {selected ? (
                <span className={CHECK_BADGE} aria-hidden="true">
                  <Check className="size-3" strokeWidth={3} />
                </span>
              ) : null}
              <span className="block aspect-square w-full rounded-lg border border-black/10" style={textureThumbStyle(t)} aria-hidden="true" />
              <span className="truncate text-xs font-semibold text-[#0e3b2e]">{t.label}</span>
            </button>
          );
        })}
      </div>
      <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled || !texture}>
        <legend className={cx(ED_PANEL_EYEBROW, "mb-2")}>Tint</legend>
        {!texture ? <p className="text-xs text-muted-foreground">Pick a paper first.</p> : null}
        <div role="radiogroup" aria-label="Tint" onKeyDown={onRadioGroupKeyDown} className="grid grid-cols-5 gap-3 p-1 sm:grid-cols-9 lg:grid-cols-5" data-testid="bg-tints">
          <button
            type="button"
            role="radio"
            aria-checked={texture !== null && tint === null}
            aria-label="No tint"
            tabIndex={tintStop === 0 ? 0 : -1}
            onClick={() => texture && onApply({ kind: "texture", textureId: texture.textureId })}
            className={cx(texture !== null && tint === null ? SWATCH_ACTIVE : SWATCH, "bg-white text-[10px] leading-none font-semibold text-[#56625a]")}
            data-testid="bg-tint-none"
          >
            None
          </button>
          {TINT_SWATCHES.map((s, i) => (
            <SwatchButton
              key={s.id}
              swatch={s}
              tabStop={tintStop === i + 1}
              label={`${s.label} tint`}
              selected={sameHex(tint, s.hex)}
              disabled={disabled || !texture}
              onPick={() => texture && onApply({ kind: "texture", textureId: texture.textureId, tint: s.hex })}
              testId={`bg-tint-${s.id}`}
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function PhotoTab({ scope, current, photos, disabled, onApply, onFade }: BackgroundPickerViewProps) {
  const id = useId();
  const photo = current.kind === "photo" ? current : null;
  const photoStop = rovingTabStop(photos.map((p) => ({ checked: photo?.photoId === p.id })));
  const veilStop = rovingTabStop(VEIL_SWATCHES.map((s) => ({ checked: photo !== null && sameHex(photo.veilColor, s.hex) })));
  // Light veils (dark text) start at 60 % for new changes (N4); a stored lower fade still shows as is.
  const slider = fadeSlider(photo);
  // Whole book: every pick rewrites the book (and may replace page backgrounds) — arrows only
  // move focus, Enter / Space applies.
  const photoKeys = scope === "book" ? onRadioGroupKeyDownFocusOnly : onRadioGroupKeyDown;
  return (
    <div className="flex flex-col gap-3">
      {photos.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground" data-testid="bg-photos-empty">
          No photos yet.
        </p>
      ) : (
        <div role="radiogroup" aria-label="Background photo" onKeyDown={photoKeys} className="grid max-h-56 grid-cols-4 gap-2 overflow-y-auto p-1 sm:grid-cols-5 lg:grid-cols-4" data-testid="bg-photos" data-keys={scope === "book" ? "focus" : "select"}>
          {photos.map((p, i) => {
            const selected = photo?.photoId === p.id;
            const src = p.thumbUrl ?? p.webUrl;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={selected ? "Current background photo" : "Use this photo as the background"}
                tabIndex={i === photoStop ? 0 : -1}
                disabled={disabled}
                onClick={() => onApply(photoBackground(p.id, current))}
                className={cx(selected ? TOOL_PHOTO_TILE_ACTIVE : TOOL_PHOTO_TILE, "disabled:opacity-40")}
                data-testid="bg-photo"
                data-photo-id={p.id}
              >
                {src ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs
                  <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full object-cover" />
                ) : (
                  <ImageIcon className="absolute inset-0 m-auto size-6 text-neutral-400" aria-hidden="true" />
                )}
                {selected ? (
                  <span className={CHECK_BADGE} aria-hidden="true">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      <fieldset className="flex min-w-0 flex-col gap-3" disabled={disabled || !photo}>
        {!photo && photos.length > 0 ? <p className="text-xs text-muted-foreground">Pick a photo, then fade it so text stays readable.</p> : null}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={`${id}-fade`} className={ED_PANEL_EYEBROW}>
              Fade
            </label>
            <span className="text-muted-foreground tabular-nums" data-testid="bg-fade-value">
              {slider.valueText ?? "—"}
            </span>
          </div>
          <input
            id={`${id}-fade`}
            type="range"
            min={slider.min}
            max={FADE_MAX}
            step={FADE_STEP}
            value={slider.value}
            aria-valuetext={slider.valueText ?? undefined}
            onChange={(e) => photo && onFade({ ...photo, veil: nextFade(Number(e.target.value), photo.veilColor) })}
            className="h-11 w-full accent-[#0e3b2e] disabled:opacity-40"
            data-testid="bg-fade"
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className={ED_PANEL_EYEBROW} id={`${id}-veil`}>
            Fade colour
          </span>
          <div role="radiogroup" aria-labelledby={`${id}-veil`} onKeyDown={onRadioGroupKeyDown} className="grid grid-cols-6 gap-3 p-1 lg:grid-cols-5 xl:grid-cols-6" data-testid="bg-veil-colours">
            {VEIL_SWATCHES.map((s, i) => (
              <SwatchButton
                key={s.id}
                swatch={s}
                tabStop={i === veilStop}
                label={`${s.label} fade`}
                selected={photo !== null && sameHex(photo.veilColor, s.hex)}
                disabled={disabled || !photo}
                onPick={() => photo && onApply(withVeilColor(photo, s.hex))}
                testId={`bg-veil-${s.id}`}
              />
            ))}
          </div>
        </div>
      </fieldset>
    </div>
  );
}

export const backgroundTool: EditorTool = {
  id: "background",
  label: "Background",
  icon: PaintBucket,
  // "cover": stays available while the cover photo / title is selected (the cover has its own colour).
  scopes: ["none", "cover"],
  order: 22,
  tier: "primary",
  panelTitle: "Background",
  // Live preview: keep the page visible above the panel on phones.
  dockOnMobile: true,
  Panel: BackgroundPickerPanel,
};
