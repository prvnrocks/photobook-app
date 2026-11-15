// The photos of the wizard's "Sorting your photos" step (M19 T7, D-071; M20 T7, D-072), rendered by
// StepSorting on /books/new. Server-safe, no hooks. Photos are up to FAN_PHOTOS (6) of the draft
// album's signed 512 px thumbs, cover first (loadFanUrls); a missing top card is a soft placeholder, a
// missing back card plain paper. Decorative (aria-hidden): the headline + checklist carry the meaning.
//
// M20 T7: the cards move with the run — the nearest ancestor's data-sort-phase (set by
// <BuildProgress variant="wizard"> from the server-reported run state, wizardSortPhase) picks one of
// four transforms per card: fan (sifting) → sort (shuffle, then settle into three "moment" piles) →
// piles (each pile gets a caption tag) → ready (piles gather into one stack + check badge). The
// transforms are per-card CSS custom properties below; sorting-motion.css (imported by
// NewBookWizard) switches between them and animates transform/opacity only, with a static
// prefers-reduced-motion fallback. Without that stylesheet (unit tests) the Tailwind classes alone
// draw the static fan.
import { Check, ImageIcon } from "lucide-react";
import type { CSSProperties } from "react";

/**
 * Photo cards on top of the piles (the wizard passes up to FAN_PHOTOS = 6 thumbs; 3–5 back them).
 * Six cards are drawn in total (POSES): photo cards + backing cards (extra photos if given, else paper).
 */
export const FAN_CARD_PHOTOS = 3;

type CardPose = { fan: string; mid: string; pile: string; ready: string; z: number };

/**
 * Per-card poses (translate % of the card's own size, then rotate, then scale). Cards 0–2 are the
 * pile tops (centre card on top in the fan); 3–5 sit behind piles 0–2.
 */
const POSES: readonly CardPose[] = [
  { fan: "translate(-64%,6%) rotate(-9deg)", mid: "translate(34%,-10%) rotate(8deg)", pile: "translate(-112%,-8%) rotate(-4deg) scale(0.86)", ready: "translate(-4%,-2%) rotate(-5deg)", z: 3 },
  { fan: "translate(0%,-4%) rotate(0deg) scale(1.06)", mid: "translate(-38%,2%) rotate(-7deg)", pile: "translate(0%,-12%) rotate(2deg) scale(0.86)", ready: "translate(0%,-4%) rotate(0deg) scale(1.04)", z: 4 },
  { fan: "translate(64%,6%) rotate(9deg)", mid: "translate(-8%,-14%) rotate(-12deg)", pile: "translate(112%,-8%) rotate(5deg) scale(0.86)", ready: "translate(4%,-2%) rotate(5deg)", z: 3 },
  { fan: "translate(-20%,6%) rotate(-4deg) scale(0.92)", mid: "translate(22%,4%) rotate(10deg) scale(0.9)", pile: "translate(-106%,-4%) rotate(5deg) scale(0.84)", ready: "translate(-6%,0%) rotate(-9deg) scale(0.98)", z: 1 },
  { fan: "translate(0%,8%) rotate(3deg) scale(0.92)", mid: "translate(-24%,-6%) rotate(-9deg) scale(0.9)", pile: "translate(6%,-8%) rotate(-5deg) scale(0.84)", ready: "translate(2%,0%) rotate(8deg) scale(0.98)", z: 1 },
  { fan: "translate(20%,6%) rotate(4deg) scale(0.92)", mid: "translate(6%,8%) rotate(4deg) scale(0.9)", pile: "translate(118%,-4%) rotate(-3deg) scale(0.84)", ready: "translate(6%,0%) rotate(10deg) scale(0.98)", z: 1 },
];

function poseStyle(p: CardPose, i: number): CSSProperties {
  return {
    "--so-fan": p.fan,
    "--so-mid": p.mid,
    "--so-pile": p.pile,
    "--so-ready": p.ready,
    "--so-i": i,
    zIndex: p.z,
  } as CSSProperties;
}

export function PhotoFan({ urls }: { urls: readonly string[] }) {
  return (
    <div
      aria-hidden="true"
      className="so-stage relative mx-auto aspect-[16/10] w-full max-w-[34rem] select-none lg:max-w-none"
      data-testid="build-photo-fan"
      data-count={urls.length}
    >
      <span className="so-glow pointer-events-none absolute inset-[6%] rounded-full opacity-0" />
      {POSES.map((pose, i) => {
        const url = urls[i];
        const top = i < FAN_CARD_PHOTOS;
        const kind = url ? "photo" : top ? "placeholder" : "paper";
        return (
          <div
            key={i}
            className={`so-card absolute top-[10%] left-[35%] aspect-[4/5] w-[30%] [transform:var(--so-fan)] ${top ? "" : "so-card-back opacity-0"}`}
            style={poseStyle(pose, i)}
            data-testid={top ? "build-photo-fan-item" : "build-photo-fan-back"}
            data-kind={kind}
          >
            <div className="so-card-inner relative size-full overflow-hidden rounded-sm bg-card p-1.5 shadow-card ring-1 ring-foreground/10">
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed thumb URL
                <img src={url} alt="" decoding="async" className="size-full rounded-[1px] bg-muted object-cover" />
              ) : top ? (
                <span className="flex size-full items-center justify-center rounded-[1px] bg-secondary text-primary/40">
                  <ImageIcon className="size-8" strokeWidth={1.5} />
                </span>
              ) : (
                <span className="so-paper block size-full rounded-[1px] bg-secondary" />
              )}
            </div>
            {top ? (
              // A "moment" tag under each pile while the book is prepared (captions being written).
              <span className="so-tag absolute top-[106%] right-[10%] left-[10%] flex flex-col gap-[5px] rounded-md bg-card px-2 py-1.5 opacity-0 shadow-card ring-1 ring-foreground/10">
                <span className="so-tag-line block h-[5px] w-full rounded-full bg-muted" />
                <span className="so-tag-line block h-[5px] w-2/3 rounded-full bg-muted" />
              </span>
            ) : null}
          </div>
        );
      })}
      <span className="so-burst pointer-events-none absolute top-[2%] left-[63%] size-[20%] -translate-x-1/2 rounded-full opacity-0" />
      <span
        className="so-badge absolute top-[4%] left-[63%] z-10 flex size-12 -translate-x-1/2 items-center justify-center rounded-full opacity-0 sm:size-14"
        data-testid="build-photo-fan-ready"
      >
        <Check className="size-6 sm:size-7" strokeWidth={3} />
      </span>
    </div>
  );
}
