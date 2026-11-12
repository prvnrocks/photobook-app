// The book-making flow shown by <StepProgress> (M13 T7, D-070): three plain steps,
// Photos → Your book → Share (was six in M11: New → Photos → AI build → Review → Edit → Share).
// Pure: safe on client and server, tested in node.
//
// Screens still name themselves by route ("new", "build", "review", …: `FlowStepId`); each maps to
// one of the three shown steps (`FlowDisplayStepId`). Where a book "is" reuses the dashboard card
// rules (src/lib/dashboard/card-target.ts) so the step bar and the card link can never disagree; a
// live snapshot (published) on a built album is "share".

import { bookCardStep, RUNNING_AI_STATUSES, type BookCardState } from "@/lib/dashboard/card-target";

/** The steps the bar shows, in order. */
export const FLOW_STEPS = [
  { id: "photos", label: "Photos" },
  { id: "book", label: "Your book" },
  { id: "share", label: "Share" },
] as const;

export type FlowDisplayStepId = (typeof FLOW_STEPS)[number]["id"];

/** Route-level step a screen passes to <PageHeader step> / <StepProgress current>. */
export const FLOW_STEP_IDS = ["new", "photos", "build", "review", "edit", "share"] as const;

export type FlowStepId = (typeof FLOW_STEP_IDS)[number];

export const FLOW_STEP_COUNT = FLOW_STEPS.length;

/** Which of the three shown steps a screen belongs to. */
const DISPLAY_STEP: Record<FlowStepId, FlowDisplayStepId> = {
  new: "photos",
  photos: "photos",
  build: "book",
  review: "book",
  edit: "book",
  share: "share",
};

export function isFlowStepId(raw: unknown): raw is FlowStepId {
  return typeof raw === "string" && (FLOW_STEP_IDS as readonly string[]).includes(raw);
}

export function displayStep(id: FlowStepId): FlowDisplayStepId {
  return DISPLAY_STEP[id];
}

/** 0-based position of a step in the bar. */
export function flowStepIndex(id: FlowStepId): number {
  const shown = DISPLAY_STEP[id];
  return FLOW_STEPS.findIndex((s) => s.id === shown);
}

/** "Step 2 of 3: Your book" — the StepProgress label (1-based for people). */
export function flowStepLabel(id: FlowStepId): string {
  const i = flowStepIndex(id);
  return `Step ${i + 1} of ${FLOW_STEP_COUNT}: ${FLOW_STEPS[i].label}`;
}

/** The step a route under /books belongs to (`/books/new`, `/books/start`, `/books/[id]/<segment>`). */
const ROUTE_STEP: Record<string, FlowStepId> = {
  new: "new",
  start: "photos",
  upload: "photos",
  build: "build",
  review: "review",
  edit: "edit",
  publish: "share",
};

export function flowStepForRoute(segment: string): FlowStepId | null {
  return Object.prototype.hasOwnProperty.call(ROUTE_STEP, segment) ? ROUTE_STEP[segment] : null;
}

export type FlowBookState = Omit<BookCardState, "id"> & {
  /** A live snapshot exists (BookListItem.published). */
  published: boolean;
};

/** Where the book currently is in the flow (the route-level step its next screen belongs to). */
export function bookFlowStep(b: FlowBookState): FlowStepId {
  const card = bookCardStep(b);
  if (card === "upload") return "photos";
  if (card === "build") return "build";
  // A running AI build always wins (card "build" above); a live built album is at "share".
  const running = (RUNNING_AI_STATUSES as readonly string[]).includes(b.ai_status ?? "");
  if (b.published && !running) return "share";
  return card;
}

/** 0-based position in the three-step bar. */
export function bookFlowStepIndex(b: FlowBookState): number {
  return flowStepIndex(bookFlowStep(b));
}
