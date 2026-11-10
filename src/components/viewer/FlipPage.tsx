"use client";

// One flipbook page element. react-pageflip clones each child with a callback ref and hands the
// DOM node to page-flip, so every child must forward its ref to a plain <div>.
// page-flip rewrites this div's inline style (cssText) on every animation frame: style it with
// classes only. react-pageflip pushes every non-null ref call into its page list, so a repeated
// call for the same node (StrictMode ref re-invocation) would register a page twice. Defensive:
// not observed with React 19.1 + Next 15.5 dev StrictMode, but we forward each (ref, el) pair once.

import { forwardRef, useCallback, useRef, type ForwardedRef, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Flip index (0 = cover), exposed as data-flip-index for tests and viewer chrome. */
  index: number;
  /** "hard" for covers (page-flip reads data-density). */
  density?: "hard" | "soft";
};

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export const FlipPage = forwardRef<HTMLDivElement, Props>(function FlipPage({ children, index, density }, ref) {
  const last = useRef<{ ref: ForwardedRef<HTMLDivElement>; el: HTMLDivElement } | null>(null);
  const setEl = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return; // react-pageflip ignores null; page lists are rebuilt on remount.
      if (last.current && last.current.ref === ref && last.current.el === el) return;
      last.current = { ref, el };
      assignRef(ref, el);
    },
    [ref],
  );
  return (
    <div ref={setEl} className="overflow-hidden bg-white" data-flip-index={index} data-density={density}>
      {children}
    </div>
  );
});
