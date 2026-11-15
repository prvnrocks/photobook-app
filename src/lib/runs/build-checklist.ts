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
 * M20b: the same three rows for a RULE build (AI off, mode 'rule'), worded for what the rule build
 * really does (src/lib/ai/fallback.ts ruleCurate + src/lib/autolayout.ts): it drops duplicates
 * (upload-time dHash groups), screenshots and extremely blurry photos (upload-time blur score),
 * starts a new chapter when the day / place changes (or after a 6 h gap), then fills the pages.
 * No AI claims ("places and moments" = the AI Storyteller).
 */
export const WIZARD_RULE_LABELS: Readonly<Record<WizardChecklistStepId, string>> = {
  sift: "Leaving out duplicates and very blurry photos",
  moments: "Grouping your photos by date and place",
  book: "Laying out your pages",
};

function labelOf(id: WizardChecklistStepId, fallback: string, rules: boolean): string {
  return rules ? WIZARD_RULE_LABELS[id] : fallback;
}

/**
 * The wizard checklist for a run state. `finished` = the client saw the run finish (leaving for the
 * editor): every row done. queued → all pending; failed → all pending (shown as an error elsewhere).
 * `rules` = a rule build (M20b): rule wording, same states.
 */
export function wizardChecklist(state: RunState, finished = false, rules = false): WizardChecklistStep[] {
  const r = finished ? rank("done") : state === "failed" ? -1 : rank(state);
  return WIZARD_STEPS.map((s) => {
    const last = Math.max(...s.states.map(rank));
    const st: ChecklistStepState = r > last ? "done" : s.states.includes(state) && !finished ? "current" : "todo";
    return { id: s.id, label: labelOf(s.id, s.label, rules), state: st };
  });
}

/**
 * M20b: a rule build finishes inside one request (the server reports only "done"), so step 6 plays
 * the three rows through after the fact: rows before `rowsDone` done, the next one current, the rest
 * to do. Only used once the server confirmed the run is done — it shows finished work, not a guess.
 */
export function wizardReplayChecklist(rowsDone: number, rules = true): WizardChecklistStep[] {
  return WIZARD_STEPS.map((s, i) => ({
    id: s.id,
    label: labelOf(s.id, s.label, rules),
    state: i < rowsDone ? "done" : i === rowsDone ? "current" : "todo",
  }));
}

// --- M20 T7 (D-072): the sorting step's photo animation phase ----------------------------------
// Same truth rule: the photos only move on to the next phase when the server reported the run
// state that the matching checklist row covers. fan = sifting (queued / curating, or failed),
// sort = shuffling into moments (storytelling), piles = moments laid out while the book is
// prepared (captioning … validating), ready = the client saw the run finish.

export type WizardSortPhase = "fan" | "sort" | "piles" | "ready";

export function wizardSortPhase(state: RunState, finished = false): WizardSortPhase {
  if (finished || state === "done") return "ready";
  return wizardPhaseOfRows(wizardChecklist(state));
}

/** The photo phase for checklist rows (M20b: also the rule replay's rows): follows the current row. */
export function wizardPhaseOfRows(rows: readonly WizardChecklistStep[]): WizardSortPhase {
  if (rows.length > 0 && rows.every((r) => r.state === "done")) return "ready";
  const current = rows.find((r) => r.state === "current")?.id;
  if (current === "book") return "piles";
  if (current === "moments") return "sort";
  return "fan";
}

/** Rows done (0–3) for the segmented bar — counts rows, never time. */
export function wizardRowsDone(rows: readonly WizardChecklistStep[]): number {
  return rows.filter((r) => r.state === "done").length;
}
