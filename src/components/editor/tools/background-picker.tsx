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

import { Check, ImageIcon, PaintBucket, RotateCcw, Sparkles } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  pageBackgroundOverrideCount,
  resetPageBackground,
  setBookBackground,
  setPageBackground,
} from "@/lib/book/edit-ops";
import type { Background } from "@/lib/book/types";
import { BACKGROUND_SWATCHES, TEXTURE_IDS, textureById, type BackgroundSwatch, type Texture, type TextureId } from "@/lib/design/backgrounds";
import {
  availableScopes,
  BACKGROUND_SCOPES,
  BACKGROUND_TABS,
  backgroundPageIdx,
  backgroundPhotoCandidates,
  currentBackground,
  FADE_MAX,
  FADE_STEP,
  fadeSlider,
  initialTab,
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
import { cn } from "@/lib/utils";
import { showEditorToast } from "../EditorToast";
import { onRadioGroupKeyDown, onRadioGroupKeyDownFocusOnly } from "../radio-group-keys";
import type { EditorPanelProps, EditorTool } from "./types";

let sessionSeq = 0;

export function BackgroundPickerPanel({ ctx }: EditorPanelProps) {
  const { doc } = ctx.state;
  const pageIdx = backgroundPageIdx(doc, ctx.state.page);
  const scopes = availableScopes(pageIdx);
  const [scopePref, setScope] = useState<BackgroundScope>(scopes[0]);
  const scope: BackgroundScope = scopes.includes(scopePref) ? scopePref : scopes[0];
  const current = currentBackground(doc, scope, pageIdx);
  const [tab, setTab] = useState<BackgroundTab>(() => initialTab(current));
  const [session] = useState(() => ++sessionSeq);
  const photos = useMemo(() => backgroundPhotoCandidates(ctx.photos.photos), [ctx.photos.photos]);

  const apply = (bg: Background, coalesceKey?: string) => {
    if (ctx.readOnly) return;
    if (scope === "page" && pageIdx !== null) {
      ctx.actions.edit((d) => setPageBackground(d, pageIdx, bg), { goTo: pageIdx, coalesceKey });
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
    if (ctx.readOnly || pageIdx === null) return;
    ctx.actions.edit((d) => resetPageBackground(d, pageIdx), { goTo: pageIdx });
  };

  return (
    <BackgroundPickerView
      scopes={scopes}
      scope={scope}
      onScope={setScope}
      tab={tab}
      onTab={setTab}
      current={current}
      suggested={isSuggested(doc, pageIdx, scope)}
      hasOverride={scope === "page" && pageOverride(doc, pageIdx) !== null}
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
  const scopeStop = rovingTabStop(BACKGROUND_SCOPES.map((s) => ({ checked: scope === s.id, disabled: !scopes.includes(s.id) })));
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="background-picker" data-scope={scope}>
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label="Apply to" onKeyDown={onRadioGroupKeyDown} className="grid flex-1 grid-cols-2 gap-1 rounded-lg bg-muted p-1" data-testid="bg-scope">
          {BACKGROUND_SCOPES.map((s, i) => {
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
                className={cn(
                  "min-h-11 min-w-0 rounded-md px-1 text-sm font-medium disabled:opacity-40",
                  scope === s.id ? "bg-background shadow-sm" : "text-muted-foreground",
                )}
                data-testid={`bg-scope-${s.id}`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        {suggested ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900"
            title="Picked by AI. Tap another background to choose your own."
            data-testid="bg-suggested"
          >
            <Sparkles className="size-3" aria-hidden="true" /> Suggested
          </span>
        ) : null}
      </div>
      {scopes.length === 1 ? (
        <p className="text-xs text-muted-foreground" data-testid="bg-cover-note">
          The cover uses the book background.
        </p>
      ) : scope === "book" && overrideCount > 0 ? (
        <p className="text-xs text-amber-800" data-testid="bg-replace-note">
          {adjustKeepsOverrides ? "A new background also replaces" : "Also replaces"} the background of{" "}
          {overrideCount === 1 ? "1 page that has" : `${overrideCount} pages that have`} its own.
          {adjustKeepsOverrides ? " Changing the fade keeps them." : null}
        </p>
      ) : null}

      <div role="tablist" aria-label="Background type" className="grid grid-cols-3 gap-1 border-b">
        {BACKGROUND_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${id}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${id}-panel`}
            onClick={() => onTab(t.id)}
            className={cn(
              "-mb-px min-h-11 border-b-2 text-sm font-medium",
              tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground",
            )}
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
          className="flex min-h-11 items-center justify-center gap-2 rounded-lg border text-sm font-medium hover:bg-muted disabled:opacity-40"
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
      className={cn(
        "relative flex aspect-square w-full min-w-0 items-center justify-center rounded-full border border-black/15 outline-none disabled:opacity-40",
        "focus-visible:ring-4 focus-visible:ring-primary/60",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
      style={{ backgroundColor: swatch.hex }}
      data-testid={testId}
      data-hex={swatch.hex}
    >
      {selected ? (
        <Check className={cn("size-4", swatch.ink === "light" ? "text-white" : "text-neutral-800")} aria-hidden="true" />
      ) : null}
    </button>
  );
}

function ColourTab({ current, disabled, onApply }: BackgroundPickerViewProps) {
  const isSel = (s: BackgroundSwatch) => current.kind === "color" && sameHex(current.hex, s.hex);
  const stop = rovingTabStop(BACKGROUND_SWATCHES.map((s) => ({ checked: isSel(s) })));
  return (
    <div role="radiogroup" aria-label="Colour" onKeyDown={onRadioGroupKeyDown} className="grid grid-cols-6 gap-3 p-1 sm:grid-cols-8" data-testid="bg-colours">
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
              className={cn(
                "flex min-w-0 flex-col items-stretch gap-1 rounded-lg p-1 text-left outline-none disabled:opacity-40",
                "focus-visible:ring-4 focus-visible:ring-primary/60",
                selected ? "bg-primary/10 ring-2 ring-primary" : "hover:bg-muted",
              )}
              data-testid={`bg-texture-${t.id}`}
            >
              <span className="block aspect-square w-full rounded-md border border-black/10" style={textureThumbStyle(t)} aria-hidden="true" />
              <span className="truncate text-xs font-medium">{t.label}</span>
            </button>
          );
        })}
      </div>
      <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled || !texture}>
        <legend className="mb-2 text-sm font-semibold">Tint</legend>
        {!texture ? <p className="text-xs text-muted-foreground">Pick a paper first.</p> : null}
        <div role="radiogroup" aria-label="Tint" onKeyDown={onRadioGroupKeyDown} className="grid grid-cols-5 gap-3 p-1 sm:grid-cols-9" data-testid="bg-tints">
          <button
            type="button"
            role="radio"
            aria-checked={texture !== null && tint === null}
            aria-label="No tint"
            tabIndex={tintStop === 0 ? 0 : -1}
            onClick={() => texture && onApply({ kind: "texture", textureId: texture.textureId })}
            className={cn(
              "flex aspect-square w-full min-w-0 items-center justify-center rounded-full border border-black/15 bg-white text-[10px] leading-none font-medium text-neutral-600 disabled:opacity-40",
              texture !== null && tint === null && "ring-2 ring-primary ring-offset-2 ring-offset-background",
            )}
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
        <div role="radiogroup" aria-label="Background photo" onKeyDown={photoKeys} className="grid max-h-56 grid-cols-4 gap-2 overflow-y-auto p-1 sm:grid-cols-5" data-testid="bg-photos" data-keys={scope === "book" ? "focus" : "select"}>
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
                className={cn(
                  "relative block aspect-square w-full min-w-0 overflow-hidden rounded-md bg-neutral-100 outline-none disabled:opacity-40",
                  "focus-visible:ring-4 focus-visible:ring-primary/60",
                  selected && "ring-4 ring-primary",
                )}
                data-testid="bg-photo"
                data-photo-id={p.id}
              >
                {src ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs
                  <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full object-cover" />
                ) : (
                  <ImageIcon className="absolute inset-0 m-auto size-6 text-neutral-400" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}

      <fieldset className="flex min-w-0 flex-col gap-3" disabled={disabled || !photo}>
        {!photo && photos.length > 0 ? <p className="text-xs text-muted-foreground">Pick a photo, then fade it so text stays readable.</p> : null}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={`${id}-fade`} className="font-semibold">
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
            className="h-11 w-full accent-primary disabled:opacity-40"
            data-testid="bg-fade"
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold" id={`${id}-veil`}>
            Fade colour
          </span>
          <div role="radiogroup" aria-labelledby={`${id}-veil`} onKeyDown={onRadioGroupKeyDown} className="grid grid-cols-6 gap-3 p-1" data-testid="bg-veil-colours">
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
  scopes: ["none"],
  order: 22,
  panelTitle: "Background",
  // Live preview: keep the page visible above the panel on phones.
  dockOnMobile: true,
  Panel: BackgroundPickerPanel,
};
