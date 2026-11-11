// The book-making flow shown by <StepProgress> (M11, D-067): New → Photos → AI build → Review →
// Edit → Share. Pure: safe on client and server, tested in node.
//
// Where a book "is" reuses the dashboard card rules (src/lib/dashboard/card-target.ts) so the step
// bar and the card link can never disagree; a live snapshot (published) on a built album is "share".

import { bookCardStep, RUNNING_AI_STATUSES, type BookCardState } from "@/lib/dashboard/card-target";

export const FLOW_STEPS = [
  { id: "new", label: "New book" },
  { id: "photos", label: "Photos" },
  { id: "build", label: "AI build" },
  { id: "review", label: "Review" },
  { id: "edit", label: "Edit" },
  { id: "share", label: "Share" },
] as const;

export type FlowStepId = (typeof FLOW_STEPS)[number]["id"];

export const FLOW_STEP_COUNT = FLOW_STEPS.length;

export function isFlowStepId(raw: unknown): raw is FlowStepId {
  return FLOW_STEPS.some((s) => s.id === raw);
}

/** 0-based position of a step. */
export function flowStepIndex(id: FlowStepId): number {
  return FLOW_STEPS.findIndex((s) => s.id === id);
}

/** "Step 3 of 6: AI build" — the StepProgress label (1-based for people). */
export function flowStepLabel(id: FlowStepId): string {
  const i = flowStepIndex(id);
  return `Step ${i + 1} of ${FLOW_STEP_COUNT}: ${FLOW_STEPS[i].label}`;
}

/** The step a route under /books belongs to (`/books/new`, `/books/[id]/<segment>`). */
const ROUTE_STEP: Record<string, FlowStepId> = {
  new: "new",
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

/** Where the book currently is in the flow (the step its next screen belongs to). */
export function bookFlowStep(b: FlowBookState): FlowStepId {
  const card = bookCardStep(b);
  if (card === "upload") return "photos";
  if (card === "build") return "build";
  // A running AI build always wins (card "build" above); a live built album is at "share".
  const running = (RUNNING_AI_STATUSES as readonly string[]).includes(b.ai_status ?? "");
  if (b.published && !running) return "share";
  return card;
}

export function bookFlowStepIndex(b: FlowBookState): number {
  return flowStepIndex(bookFlowStep(b));
}
