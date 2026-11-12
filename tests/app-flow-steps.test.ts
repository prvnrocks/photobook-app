// M11 task 2 / M13 T7: book state → flow step (src/lib/app/flow-steps.ts). Three shown steps.
import { describe, expect, it } from "vitest";
import {
  bookFlowStep,
  bookFlowStepIndex,
  displayStep,
  FLOW_STEP_IDS,
  FLOW_STEPS,
  flowStepForRoute,
  flowStepIndex,
  flowStepLabel,
  isFlowStepId,
  type FlowBookState,
} from "@/lib/app/flow-steps";
import { bookCardStep } from "@/lib/dashboard/card-target";

const base: FlowBookState = { page_count: 0, photo_count: 0, ai_status: "idle", user_edited: false, published: false };

describe("flow steps", () => {
  it("has the three steps in order", () => {
    expect(FLOW_STEPS.map((s) => s.label)).toEqual(["Photos", "Your book", "Share"]);
    expect(flowStepIndex("new")).toBe(0);
    expect(flowStepIndex("photos")).toBe(0);
    expect(flowStepIndex("build")).toBe(1);
    expect(flowStepIndex("review")).toBe(1);
    expect(flowStepIndex("edit")).toBe(1);
    expect(flowStepIndex("share")).toBe(2);
  });

  it("maps every route-level step to a shown step", () => {
    const shown = FLOW_STEP_IDS.map((id) => [id, displayStep(id)]);
    expect(Object.fromEntries(shown)).toEqual({
      new: "photos",
      photos: "photos",
      build: "book",
      review: "book",
      edit: "book",
      share: "share",
    });
  });

  it("labels steps 1-based", () => {
    expect(flowStepLabel("build")).toBe("Step 2 of 3: Your book");
    expect(flowStepLabel("new")).toBe("Step 1 of 3: Photos");
    expect(flowStepLabel("share")).toBe("Step 3 of 3: Share");
  });

  it("maps routes to steps", () => {
    expect(flowStepForRoute("new")).toBe("new");
    expect(flowStepForRoute("upload")).toBe("photos");
    expect(flowStepForRoute("start")).toBe("photos");
    expect(flowStepForRoute("build")).toBe("build");
    expect(flowStepForRoute("review")).toBe("review");
    expect(flowStepForRoute("edit")).toBe("edit");
    expect(flowStepForRoute("publish")).toBe("share");
    expect(flowStepForRoute("upgrade")).toBeNull();
    expect(flowStepForRoute("constructor")).toBeNull();
    expect(isFlowStepId("photos")).toBe(true);
    expect(isFlowStepId("upload")).toBe(false);
  });

  it("derives the step from book state", () => {
    expect(bookFlowStep(base)).toBe("photos");
    expect(bookFlowStep({ ...base, photo_count: 12 })).toBe("build");
    expect(bookFlowStep({ ...base, photo_count: 12, ai_status: "planning" })).toBe("build");
    expect(bookFlowStep({ ...base, photo_count: 12, page_count: 10, ai_status: "done" })).toBe("edit");
    expect(bookFlowStep({ ...base, photo_count: 12, page_count: 10, ai_status: "done", user_edited: true })).toBe("edit");
    expect(bookFlowStep({ ...base, photo_count: 12, page_count: 10, ai_status: "done", user_edited: true, published: true })).toBe("share");
    expect(bookFlowStep({ ...base, photo_count: 12, page_count: 10, published: true })).toBe("share");
    expect(bookFlowStepIndex({ ...base, photo_count: 12 })).toBe(1);
    expect(bookFlowStepIndex(base)).toBe(0);
  });

  it("a running rebuild beats published", () => {
    expect(bookFlowStep({ ...base, photo_count: 12, page_count: 10, published: true, ai_status: "captioning" })).toBe("build");
  });

  it("never disagrees with the dashboard card target", () => {
    const states: FlowBookState[] = [];
    for (const page_count of [0, 8])
      for (const photo_count of [0, 5])
        for (const ai_status of [null, "idle", "analyzing", "done", "failed"])
          for (const user_edited of [false, true]) states.push({ page_count, photo_count, ai_status, user_edited, published: false });
    const cardToFlow = { upload: "photos", build: "build", edit: "edit" } as const;
    for (const s of states) expect(bookFlowStep(s)).toBe(cardToFlow[bookCardStep(s)]);
  });
});
