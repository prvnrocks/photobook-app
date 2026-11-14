// Stage checklist for the AI build screen (M11 T11). Pure — safe in client components.
//
// Derived ONLY from the run state the server reported (ProgressSnapshot): a step is "done" once
// the run has moved past every state it covers, "current" while the run is in one of its states,
// "todo" otherwise. No timers, no guessed progress. Counts come straight from RunProgress.
import type { RunProgress, RunState } from "./client";

export type ChecklistStepId = "photos" | "moments" | "captions" | "check";
export type ChecklistStepState = "done" | "current" | "todo";

export type ChecklistStep = {
  id: ChecklistStepId;
  label: string;
  state: ChecklistStepState;
  /** "12 / 40" while counting, from the snapshot; null otherwise. */
  count: string | null;
};

/** Order of the run states (matches STAGE_RANK in stage-copy.ts). failed is handled separately. */
const ORDER: readonly RunState[] = [
  "queued",
  "curating",
  "storytelling",
  "captioning",
  "critiquing",
  "repairing",
  "validating",
  "done",
];

const STEPS: readonly { id: ChecklistStepId; label: string; states: readonly RunState[] }[] = [
  { id: "photos", label: "Look at your photos", states: ["curating"] },
  { id: "moments", label: "Find your moments", states: ["storytelling"] },
  { id: "captions", label: "Write captions", states: ["captioning"] },
  { id: "check", label: "Check and save your book", states: ["critiquing", "repairing", "validating"] },
];

function rank(state: RunState): number {
  return ORDER.indexOf(state);
}

function countOf(id: ChecklistStepId, progress: RunProgress | null): string | null {
  if (!progress) return null;
  if (id === "photos" && progress.photosTotal > 0) {
    return `${Math.min(progress.photosDone, progress.photosTotal)} / ${progress.photosTotal}`;
  }
  if (id === "captions" && progress.captionsTotal > 0) {
    return `${Math.min(progress.captionsDone, progress.captionsTotal)} / ${progress.captionsTotal}`;
  }
  return null;
}

/**
 * The checklist for a snapshot. `finished` = the client saw the run finish (leaving for review):
 * every step done. A failed run is shown as an error elsewhere, so it returns all steps todo.
 */
export function buildChecklist(state: RunState, progress: RunProgress | null, finished = false): ChecklistStep[] {
  const r = finished ? rank("done") : state === "failed" ? -1 : rank(state);
  return STEPS.map((s) => {
    const last = Math.max(...s.states.map(rank));
    const st: ChecklistStepState = r > last ? "done" : s.states.includes(state) && !finished ? "current" : "todo";
    return { id: s.id, label: s.label, state: st, count: st === "current" ? countOf(s.id, progress) : null };
  });
}

// --- M19 T7 (D-071): the wizard's "Sorting your photos" checklist ------------------------------
// Three rows (layout after wizard.png). Same rule as buildChecklist: a row is "done" only once the
// server reported a state past every state it covers, "current" while the run is in one of them —
// so each line only says what the server confirmed (no timers, no guessed progress).

export type WizardChecklistStepId = "sift" | "moments" | "book";

export type WizardChecklistStep = {
  id: WizardChecklistStepId;
  label: string;
  state: ChecklistStepState;
};

const WIZARD_STEPS: readonly { id: WizardChecklistStepId; label: string; states: readonly RunState[] }[] = [
  { id: "sift", label: "Checking for duplicates and blurry photos", states: ["curating"] },
  { id: "moments", label: "Finding places and moments", states: ["storytelling"] },
  { id: "book", label: "Preparing your book", states: ["captioning", "critiquing", "repairing", "validating"] },
];

/**
 * The wizard checklist for a run state. `finished` = the client saw the run finish (leaving for the
 * editor): every row done. queued → all pending; failed → all pending (shown as an error elsewhere).
 */
export function wizardChecklist(state: RunState, finished = false): WizardChecklistStep[] {
  const r = finished ? rank("done") : state === "failed" ? -1 : rank(state);
  return WIZARD_STEPS.map((s) => {
    const last = Math.max(...s.states.map(rank));
    const st: ChecklistStepState = r > last ? "done" : s.states.includes(state) && !finished ? "current" : "todo";
    return { id: s.id, label: s.label, state: st };
  });
}
