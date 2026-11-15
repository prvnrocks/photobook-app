"use client";
// Wizard step 7 "Review your book" (M20 T8, D-072), shown in place inside /books/new.
//   - Hero: the album cover as a book, a count-up "AI kept 42 of 50 photos", the chapters (moments)
//     with dates, and three caption previews (dir="auto", Arabic font for Arabic / ar books).
//   - In your book / Left out: the classic ReviewGrid (togglePhotoAction, reasons, user dot) with
//     the wizard's motion hooks — a tapped tile flies to its new tab, counts bump, Undo toast.
//     Fresh data (re-signed thumbs) comes from GET /api/books/<id>/wizard?step=7 — never
//     router.refresh inside /books/new (G1).
//   - The gold "Generate album": applies changed photo choices first (updateAlbumAction; user_edited /
//     busy go on), then confirmAlbumAction (Memory Keeper + redirect to the editor — the wizard's one
//     real navigation). Calm error + retry; the grid is inert while it works.
// AI drafts, the user decides: every AI pick is shown and can be changed here; nothing is rebuilt.
// Only transform / opacity animate (review-motion.css); reduced motion = the same final states.

import { BookOpen, ImageOff, Sparkles } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
} from "react";
import { confirmAlbumAction, togglePhotoAction, updateAlbumAction } from "@/app/books/[id]/review/actions";
import { Notice, type NoticeTone } from "@/components/app/Notice";
import { ReviewGrid } from "@/components/review/ReviewGrid";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { WIZARD_BACK_CLASS } from "@/components/wizard/WizardNav";
import { fetchWizardStep, type WizardStep7Data } from "@/lib/books/wizard-client";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import { cx } from "@/lib/cx";
import {
  BANNER_COPY,
  EDITED_ALBUM_COPY,
  captionSourceLabel,
  countKept,
  type ReviewBanner,
  type ReviewTilePhoto,
  type UpdateAlbumResult,
} from "@/lib/review/ui";
import {
  OPEN_FAILED_MESSAGE,
  choicesKey,
  coverThumb,
  heroCountCopy,
  heroSubline,
  needsAlbumUpdate,
  pagesCopy,
  reviewCaptionPicks,
  reviewChapters,
  updateStepOutcome,
} from "./review-step-model";

export type StepReviewProps = {
  data: WizardStep7Data;
  /** id of the step headline (focused after a step change). */
  headlineId: string;
  /**
   * Called only if confirmAlbumAction returns without redirecting (it normally redirects to the
   * editor itself); the wizard then navigates to the editor. Kept for the flow's confirm intent.
   */
  onConfirm: () => void;
  /** The wizard is leaving for the editor. */
  confirming?: boolean;
};

type Phase = "idle" | "applying" | "opening";

const BANNER_TONE: Record<Exclude<ReviewBanner, null>, NoticeTone> = {
  building: "info",
  ai_off: "info",
  partial: "warn",
  captions_missing: "info",
  failed: "warn",
};

const CHAPTERS_SHOWN = 5;
const COUNT_MS = 900;

/** Reduced motion, or no matchMedia (tests / old browsers) → static. */
function motionOff(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Counts from the last shown value (0 on mount) up / down to `target`; static under reduced motion. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  const from = useRef(0);
  useIsoLayoutEffect(() => {
    if (motionOff() || typeof requestAnimationFrame !== "function") {
      from.current = target;
      setShown(target);
      return;
    }
    const start = from.current;
    if (start === target) {
      setShown(target);
      return;
    }
    setShown(start); // in a layout effect: the first paint already shows the start value
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / COUNT_MS);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = Math.round(start + (target - start) * eased);
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

/** A tapped tile's ghost flies to the tab it moved to (Web Animations; transform + opacity only). */
function flyTile(root: HTMLElement | null, photo: ReviewTilePhoto, keep: boolean): void {
  if (!root || motionOff()) return;
  const tile = root.querySelector<HTMLElement>(`[data-testid="review-tile"][data-photo-id="${photo.id}"]`);
  const target = root.querySelector<HTMLElement>(`[data-testid="review-tab-${keep ? "kept" : "dropped"}"]`);
  if (!tile || !target || typeof tile.animate !== "function") return;
  const a = tile.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "rv-fly";
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  if (photo.thumbUrl) ghost.style.backgroundImage = `url(${JSON.stringify(photo.thumbUrl)})`;
  document.body.appendChild(ghost);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const remove = () => ghost.remove();
  ghost
    .animate(
      [
        { transform: "translate(0px, 0px) scale(1) rotate(0deg)", opacity: 1 },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 48}px) scale(0.6) rotate(${keep ? 6 : -6}deg)`, opacity: 0.95, offset: 0.45 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.12) rotate(0deg)`, opacity: 0 },
      ],
      { duration: 680, easing: "cubic-bezier(0.45, 0, 0.25, 1)" },
    )
    .finished.then(remove, remove);
}

export function StepReview({ data: initial, headlineId, onConfirm, confirming = false }: StepReviewProps) {
  // Local copy of the step data, replaced by refetches (toggles, re-signed thumbs, "Check again").
  const [src, setSrc] = useState(initial);
  const [data, setData] = useState(initial);
  if (src !== initial) {
    setSrc(initial);
    setData(initial);
  }
  const bookId = data.bookId;
  const [current, setCurrent] = useState<ReviewTilePhoto[]>(initial.photos);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [, startTransition] = useTransition();
  const syncedKey = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fetching = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const toggle = useMemo(() => togglePhotoAction.bind(null, bookId), [bookId]);

  /** Re-load step 7 (G1: instead of router.refresh) — fresh photos, album ids and thumb URLs. */
  const refresh = useCallback(() => {
    if (fetching.current) return;
    fetching.current = true;
    setChecking(true);
    void fetchWizardStep(bookId, 7).then((res) => {
      fetching.current = false;
      if (!mounted.current) return;
      setChecking(false);
      if (res.ok) setData(res.data);
    });
  }, [bookId]);

  const kept = countKept(current);
  const total = current.length;
  const shownKept = useCountUp(kept);
  const chapters = useMemo(() => reviewChapters(data.captionsPreview), [data.captionsPreview]);
  const picks = useMemo(() => reviewCaptionPicks(data.captionsPreview, data.captionLang), [data.captionsPreview, data.captionLang]);
  const pages = data.captionsPreview?.pages.length ?? 0;
  const cover = coverThumb(data.photos, data.coverPhotoId);
  const portrait = data.format !== "A5_LANDSCAPE";

  const working = phase !== "idle" || confirming;
  const canGenerate = !data.building && total > 0 && kept > 0;
  const ctaLabel = data.userEdited ? EDITED_ALBUM_COPY.button : "Generate album";
  const workingLabel = phase === "applying" ? "Adding your changes…" : "Opening your book…";

  const generate = () => {
    if (working || !canGenerate) return;
    setError(null);
    const key = choicesKey(current);
    const mustUpdate =
      needsAlbumUpdate(current, data.albumPhotoIds, { userEdited: data.userEdited, building: data.building }) &&
      syncedKey.current !== key;
    setPhase(mustUpdate ? "applying" : "opening");
    startTransition(async () => {
      if (mustUpdate) {
        let result: UpdateAlbumResult | null = null;
        try {
          result = await updateAlbumAction(bookId);
        } catch {
          result = null;
        }
        const outcome = updateStepOutcome(result);
        if (!outcome.go) {
          setError(outcome.message);
          setPhase("idle");
          return;
        }
        if (result?.ok) syncedKey.current = key;
        setPhase("opening");
      }
      try {
        await confirmAlbumAction(bookId);
      } catch (err) {
        // The redirect to the editor (or to sign in) is thrown on purpose: let Next follow it.
        unstable_rethrow(err);
        setError(OPEN_FAILED_MESSAGE);
        setPhase("idle");
        return;
      }
      onConfirm();
    });
  };

  return (
    <div ref={rootRef} className="rv-root flex w-full min-w-0 flex-col gap-6 sm:gap-8" data-testid="wizard-step-review">
      <div className="flex flex-col gap-2">
        <WizardHeadline id={headlineId} focusable>
          {wizardHeadline(7)}
        </WizardHeadline>
        <p className="mx-auto max-w-[34rem] text-center type-small text-muted-foreground">
          Check what goes in, then generate your album. You can change everything later in the editor.
        </p>
      </div>

      {data.banner ? (
        <Notice
          tone={BANNER_TONE[data.banner]}
          data-testid={`review-banner-${data.banner}`}
          title={BANNER_COPY[data.banner]}
          action={
            data.banner === "building" ? (
              <button type="button" onClick={refresh} disabled={checking} className={WIZARD_BACK_CLASS} data-testid="review-check-again">
                {checking ? "Checking…" : "Check again"}
              </button>
            ) : null
          }
        >
          {data.captionsNote ? <span data-testid="review-banner-captions-note">{data.captionsNote}</span> : null}
        </Notice>
      ) : null}

      {data.userEdited && !data.building ? (
        <Notice tone="info" title={EDITED_ALBUM_COPY.title} data-testid="review-edited">
          {EDITED_ALBUM_COPY.body}
        </Notice>
      ) : null}

      {/* Hero: the cover as a book + the summary. */}
      <section
        className="rv-hero relative overflow-hidden rounded-[1.75rem] border border-border/70 bg-[radial-gradient(120%_85%_at_30%_10%,#fdfaf3_0%,#f3ecdd_60%,#e9dfca_100%)] p-5 shadow-card sm:p-7"
        aria-labelledby="review-summary-heading"
        data-testid="review-summary"
      >
        <div className="grid min-w-0 grid-cols-1 items-center gap-6 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-8 xl:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
          <ReviewCover thumb={cover} title={data.title} portrait={portrait} captionLang={data.captionLang} />

          <div className="flex min-w-0 flex-col gap-4">
            <div className="min-w-0">
              <p className="text-[0.7rem] font-semibold tracking-[0.24em] text-accent-text uppercase">
                {data.aiUsed ? "Your AI draft" : "Your draft"}
              </p>
              <h2 id="review-summary-heading" className="mt-2 font-display text-[1.75rem] leading-tight text-heading sm:text-[2.1rem]">
                <span aria-hidden="true" className="rv-counter" data-testid="review-kept-visual">
                  {data.aiUsed ? "AI kept " : ""}
                  <span className="rv-num tabular-nums text-success">{shownKept}</span>
                  {` of ${total} photos`}
                  {data.aiUsed ? "" : " in your book"}
                </span>
                <span className="sr-only" data-testid="review-kept">
                  {heroCountCopy(data.aiUsed, kept, total)}
                </span>
              </h2>
              <p className="mt-2 type-small text-muted-foreground" data-testid="review-subline">
                {heroSubline(data.aiUsed)}
              </p>
            </div>

            {pages > 0 || chapters.length > 0 ? (
              <ul className="flex flex-wrap gap-2" aria-label="Album at a glance" data-testid="review-stats">
                {pages > 0 ? <Stat>{pagesCopy(pages)}</Stat> : null}
                {chapters.length > 0 ? <Stat>{chapters.length === 1 ? "1 moment" : `${chapters.length} moments`}</Stat> : null}
                {picks.length > 0 ? <Stat>Captions written</Stat> : null}
              </ul>
            ) : null}

            {chapters.length > 0 ? (
              <ol className="rv-stagger flex min-w-0 flex-col gap-1.5" aria-label="Moments in your book" data-testid="review-chapters">
                {chapters.slice(0, CHAPTERS_SHOWN).map((c, i) => (
                  <li
                    key={i}
                    style={{ "--rv-d": i } as CSSProperties}
                    className="flex min-w-0 items-baseline gap-3 rounded-xl bg-card/70 px-3 py-2"
                    data-testid="review-chapter"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      {c.title ? (
                        <span dir="auto" className={cx("block break-words font-medium text-foreground", data.captionLang === "ar" && "font-arabic")}>
                          {c.title}
                        </span>
                      ) : null}
                      <span className="block text-xs text-muted-foreground">
                        {c.dateLabel ? <span dir="auto">{c.dateLabel}</span> : null}
                        {c.dateLabel && c.pages > 0 ? " · " : null}
                        {c.pages > 0 ? pagesCopy(c.pages) : null}
                      </span>
                    </span>
                  </li>
                ))}
                {chapters.length > CHAPTERS_SHOWN ? (
                  <li style={{ "--rv-d": CHAPTERS_SHOWN } as CSSProperties} className="px-3 text-xs text-muted-foreground">
                    and {chapters.length - CHAPTERS_SHOWN} more
                  </li>
                ) : null}
              </ol>
            ) : null}
          </div>
        </div>
      </section>

      {picks.length > 0 ? (
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="review-captions-heading" data-testid="review-captions">
          <h2 id="review-captions-heading" className="type-h2 text-heading">
            A taste of the captions
          </h2>
          <ul className="rv-stagger grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            {picks.map((p, i) => (
              <li
                key={i}
                style={{ "--rv-d": i + 2 } as CSSProperties}
                className="relative flex min-w-0 flex-col gap-2 rounded-2xl border border-border/70 bg-card p-4 shadow-card"
                data-testid="review-caption"
              >
                <span aria-hidden="true" className="font-display text-3xl leading-none text-accent-strong">
                  “
                </span>
                <p
                  dir="auto"
                  lang={p.lang}
                  className={cx("break-words text-base text-foreground", p.arabicFont ? "font-arabic" : "font-display italic")}
                  data-testid="review-caption-text"
                >
                  {p.text}
                </p>
                <p className="mt-auto flex min-w-0 flex-col text-xs text-muted-foreground">
                  {p.chapter ? (
                    <span dir="auto" className={cx("truncate font-medium text-foreground/80", p.arabicFont && "font-arabic")}>
                      {p.chapter}
                    </span>
                  ) : null}
                  <span>{captionSourceLabel(p.source)}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div inert={working} className={cx("min-w-0 rounded-[1.75rem] border border-border/70 bg-card p-4 shadow-card sm:p-6", working && "opacity-70")}>
        {data.photos.length === 0 ? (
          <p className="type-small p-6 text-center text-muted-foreground" data-testid="review-no-photos">
            No photos yet.
          </p>
        ) : (
          <ReviewGrid
            photos={data.photos}
            aiUsed={data.aiUsed}
            toggle={toggle}
            onPhotosChange={setCurrent}
            refresh={refresh}
            motion
            undo
            onToggle={(photo, keep) => flyTile(rootRef.current, photo, keep)}
            title="Your photos"
            gridClassName="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6"
            toastClassName="bottom-[calc(7rem+env(safe-area-inset-bottom))] sm:bottom-32"
          />
        )}
      </div>

      <GenerateBar
        label={ctaLabel}
        workingLabel={workingLabel}
        phase={confirming && phase === "idle" ? "opening" : phase}
        disabled={!canGenerate}
        hint={
          data.building
            ? "Your book is still being made…"
            : kept === 0 && total > 0
              ? "Keep at least one photo to make your album."
              : "Takes you to the editor — nothing is final yet."
        }
        error={error}
        onGenerate={generate}
      />
    </div>
  );
}

function Stat({ children }: { children: ReactNode }) {
  return (
    <li className="inline-flex min-h-8 items-center rounded-full border border-success/30 bg-success-soft px-3 text-xs font-medium text-primary">
      {children}
    </li>
  );
}

function ReviewCover({
  thumb,
  title,
  portrait,
  captionLang,
}: {
  thumb: string | null;
  title: string;
  portrait: boolean;
  captionLang: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = !!thumb && failed !== thumb;
  return (
    <div className="rv-cover-stage mx-auto w-[8rem] sm:w-full" data-testid="review-cover" aria-hidden="true">
      <div className={cx("rv-cover relative w-full", portrait ? "aspect-[148/210]" : "aspect-[210/148]")}>
        <div className="rv-cover-face absolute inset-0 flex flex-col overflow-hidden rounded-[6%/4.5%] p-[9%]">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-[3px] bg-[#0b3025] ring-1 ring-[#c9a227]/50">
            {show ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed thumb URL
              <img
                src={thumb}
                alt=""
                className="size-full object-cover"
                draggable={false}
                onError={() => setFailed(thumb)}
                data-testid="review-cover-img"
              />
            ) : (
              <span className="flex size-full items-center justify-center text-[#c9a227]/80">
                {thumb ? <ImageOff className="size-6" /> : <BookOpen className="size-7" />}
              </span>
            )}
          </div>
          <p
            className={cx(
              "mt-[8%] line-clamp-2 text-center text-[0.8rem] leading-tight font-semibold text-[#f3e3b0] sm:text-sm",
              captionLang === "ar" ? "font-arabic" : "font-display",
            )}
          >
            <span dir="auto">{title}</span>
          </p>
        </div>
        <span className="rv-cover-spine absolute inset-y-0 start-0 w-[7%] rounded-s-[6%]" />
      </div>
      <div className="rv-cover-shadow mx-auto mt-2 h-3 w-4/5 rounded-[50%]" />
    </div>
  );
}

function GenerateBar({
  label,
  workingLabel,
  phase,
  disabled,
  hint,
  error,
  onGenerate,
}: {
  label: string;
  workingLabel: string;
  phase: Phase;
  disabled: boolean;
  hint: string;
  error: string | null;
  onGenerate: () => void;
}) {
  const busy = phase !== "idle";
  return (
    <div
      className={cx(
        "sticky bottom-0 z-20 -mx-gutter border-t border-border/80 bg-background/95 px-gutter pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/85",
        "sm:bottom-4 sm:mx-0 sm:rounded-[1.5rem] sm:border sm:px-5 sm:py-4 sm:shadow-lift",
      )}
      data-testid="review-generate-bar"
    >
      {error ? (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground" data-testid="review-generate-error">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={onGenerate}
            className="min-h-11 rounded-full px-3 font-semibold text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="review-generate-retry"
          >
            Try again
          </button>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-5">
        <p className="order-2 min-w-0 text-center text-xs text-muted-foreground sm:order-1 sm:flex-1 sm:text-start sm:text-sm" data-testid="review-generate-hint">
          {hint}
        </p>
        <button
          type="button"
          onClick={onGenerate}
          disabled={disabled || busy}
          aria-busy={busy || undefined}
          data-phase={phase}
          className={cx(
            "rv-cta relative order-1 inline-flex min-h-14 w-full min-w-0 items-center justify-center gap-2.5 overflow-hidden rounded-full border border-transparent bg-accent-strong px-8 text-lg font-semibold text-accent-strong-foreground shadow-lift outline-none sm:order-2 sm:w-auto sm:min-w-[16rem]",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:cursor-not-allowed disabled:not-aria-busy:border-input disabled:not-aria-busy:bg-muted disabled:not-aria-busy:text-muted-foreground disabled:not-aria-busy:shadow-none",
            "aria-busy:cursor-progress",
          )}
          data-testid="wizard-generate"
        >
          {busy ? (
            <>
              <span className="rv-flip relative inline-block size-5" aria-hidden="true">
                <span className="rv-flip-page absolute inset-y-0 start-1/2 w-1/2 rounded-e-sm bg-accent-strong-foreground/80" />
                <span className="absolute inset-0 rounded-sm border-2 border-accent-strong-foreground/80" />
              </span>
              <span>{workingLabel}</span>
            </>
          ) : (
            <>
              <Sparkles className="rv-cta-icon size-5" aria-hidden="true" />
              <span>{label}</span>
            </>
          )}
        </button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {busy ? workingLabel : ""}
      </span>
    </div>
  );
}
