// dnd-kit sensors shared by editor drags (Pages sheet reorder, photo drag-swap on the big page).
// Touch needs a 250 ms press so the page / grid still scrolls and swipes; mouse/pen after 6 px so a
// click is still a click.

import { PointerSensor, type PointerActivationConstraint } from "@dnd-kit/core";
import type { PointerEvent as ReactPointerEvent } from "react";

/** Pointer sensor for mouse / pen only — touch goes through TouchSensor (press-and-hold). */
export class DesktopPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent: e }: ReactPointerEvent) => e.isPrimary && e.button === 0 && e.pointerType !== "touch",
    },
  ];
}

export const MOUSE_CONSTRAINT: PointerActivationConstraint = { distance: 6 };
export const TOUCH_CONSTRAINT: PointerActivationConstraint = { delay: 250, tolerance: 8 };
