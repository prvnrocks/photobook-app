// The storybook generation screen body (Task 8): four stage rows with what the server really
// reports, plus the Stop / Try again actions and the stopped / failed / connection states.
// Presentational only (no hooks): the wizard's Create step and the editor's "Regenerate story" sheet
// feed it from useStoryRun; the dev fixture renders it statically for screenshots.
// No percentage and no timer-driven bar anywhere: a row is waiting / in progress / done / stopped,
// with a real count when the backend has one ("12 of 40 photos", "Chapter 2 of 3"). State is never
// shown by colour alone (icon + sr text), targets are ≥ 44 px, stage changes go to a polite live region.

import { Check, Circle, LoaderCircle, MinusCircle, OctagonX } from "lucide-react";
import type { ReactNode } from "react";
import { WIZARD_BACK_CLASS, WIZARD_CONTINUE_CLASS } from "@/components/wizard/WizardNav";
import { emptyStoryProgress, outcomeCopy, stageAnnouncement, stageRows, storyErrorCopy, type StageStatus, type StoryRunProgress } from "@/lib/storybook/run/progress";
import type { StoryPhase } from "./useStoryRun";

const join = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

function StageIcon({ status }: { status: StageStatus }) {
  if (status === "done") return <Check className="size-4" strokeWidth={3} />;
  if (status === "running") return <LoaderCircle className="size-6 animate-spin motion-reduce:animate-none" />;
  if (status === "failed") return <OctagonX className="size-5" />;
  if (status === "skipped") return <MinusCircle className="size-5" />;
  return <Circle className="size-6" />;
}

export function StageList({ progress, starting = false }: { progress: StoryRunProgress; starting?: boolean }) {
  const rows = stageRows(progress);
  return (
    <ol className="flex flex-col gap-2" aria-label="Story steps" data-testid="story-stages" aria-busy={starting || undefined}>
      {rows.map((r) => (
        <li
          key={r.stage}
          className={join(
            "flex min-h-14 min-w-0 items-center gap-3 rounded-xl border px-4 py-2.5",
            r.status === "running" ? "border-accent-strong/40 bg-secondary" : r.status === "failed" ? "border-destructive/40 bg-card" : "border-border bg-card",
          )}
          data-testid={`story-stage-${r.stage}`}
          data-status={r.status}
          aria-current={r.status === "running" ? "step" : undefined}
        >
          <span
            aria-hidden="true"
            key={r.status}
            className={join(
              "flex size-7 shrink-0 items-center justify-center rounded-full",
              r.status === "done" && "bg-primary text-primary-foreground",
              r.status === "running" && "text-accent-text",
              r.status === "failed" && "text-destructive",
              (r.status === "pending" || r.status === "skipped") && "text-muted-foreground",
            )}
          >
            <StageIcon status={r.status} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={join("type-small break-words", r.status === "pending" ? "text-muted-foreground" : "font-medium text-foreground")}>
              {r.label}
              <span className="sr-only"> ({r.statusText})</span>
            </span>
            {r.detail ? (
              <span className="text-xs text-muted-foreground tabular-nums" data-testid={`story-stage-${r.stage}-detail`}>
                {r.detail}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export type StoryProgressProps = {
  phase: StoryPhase;
  busy: boolean;
  onStop: () => void;
  onTryAgain: () => void;
  /** The book already has pages (e.g. a regeneration that stopped): offer to go back to them. */
  bookLink?: ReactNode;
  /** Shown while running, under the rows. */
  keepOpenNote?: string;
};

export const KEEP_OPEN_NOTE = "You can keep this page open or come back later — your story keeps its progress.";

export function StoryProgress({ phase, busy, onStop, onTryAgain, bookLink, keepOpenNote = KEEP_OPEN_NOTE }: StoryProgressProps) {
  const view = phase.kind === "starting" || phase.kind === "error" ? null : phase.view;
  const progress = view?.progress ?? emptyStoryProgress("discovering");
  const starting = phase.kind === "starting";
  const announce =
    phase.kind === "running" || phase.kind === "starting"
      ? stageAnnouncement(progress)
      : phase.kind === "done"
        ? "Your story is ready."
        : phase.kind === "stopped"
          ? storyErrorCopy(phase.view.errorCode)
          : phase.kind === "error"
            ? phase.message
            : "";
  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="story-progress" data-phase={phase.kind} data-state={view?.state ?? "starting"}>
      <StageList progress={starting ? { ...progress, stages: { ...progress.stages, discovering: { status: "running" } } } : progress} starting={starting} />

      {phase.kind === "running" && phase.retrying ? (
        <p className="type-small text-center text-warning lg:text-left" data-testid="story-reconnecting">
          Reconnecting… your story keeps its progress.
        </p>
      ) : null}

      {phase.kind === "running" || phase.kind === "starting" || phase.kind === "stopping" ? (
        <div className="flex min-w-0 flex-col items-center gap-3 lg:items-start">
          <p className="type-small text-center text-muted-foreground lg:text-left" data-testid="story-keep-open">
            {keepOpenNote}
          </p>
          <button
            type="button"
            className={WIZARD_BACK_CLASS}
            onClick={onStop}
            disabled={busy || phase.kind !== "running"}
            aria-disabled={busy || phase.kind !== "running"}
            data-testid="story-stop"
          >
            {phase.kind === "stopping" ? "Stopping…" : "Stop"}
          </button>
        </div>
      ) : null}

      {phase.kind === "stopped" ? (
        <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4" data-testid="story-stopped" data-code={phase.view.errorCode ?? ""}>
          <p className="type-small text-foreground" data-testid="story-stopped-reason">
            {storyErrorCopy(phase.view.errorCode)}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={WIZARD_CONTINUE_CLASS} onClick={onTryAgain} disabled={busy} data-testid="story-try-again">
              {busy ? "Starting…" : phase.view.errorCode === "cancelled" ? "Continue my story" : "Try again"}
            </button>
            {bookLink}
          </div>
        </div>
      ) : null}

      {phase.kind === "error" ? (
        <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-destructive/40 bg-card p-4" role="alert" data-testid="story-error">
          <p className="type-small text-foreground" data-testid="story-error-reason">
            {phase.message}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={WIZARD_CONTINUE_CLASS} onClick={onTryAgain} disabled={busy} data-testid="story-try-again">
              {busy ? "Trying…" : "Try again"}
            </button>
            {bookLink}
          </div>
        </div>
      ) : null}

      {phase.kind === "done" ? (
        <div className="flex min-w-0 flex-col gap-1" data-testid="story-done">
          <p className="type-h3 text-center font-semibold text-foreground lg:text-left">Your story is ready — opening it now…</p>
          {outcomeCopy(phase.view.progress.outcome) ? (
            <p className="type-small text-center text-muted-foreground lg:text-left" data-testid="story-outcome">
              {outcomeCopy(phase.view.progress.outcome)}
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite" data-testid="story-live">
        {announce}
      </p>
    </section>
  );
}
