"use client";

// Bottom sheet used by the viewer (Contents, Share). Rendered inside the viewer root (no portal)
// so it stays visible when the root element is in native fullscreen. Escape / backdrop closes.
// M23 T3: ivory card sheet (viewer-classes recipes). vw-sheet-rise sits on the panel only — the sheet
// is a fixed sibling of viewer-stage, never an ancestor of the flipbook (page-flip touch coords).

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "@/lib/cx";
import {
  VW_CLOSE_BTN,
  VW_SHEET,
  VW_SHEET_BACKDROP,
  VW_SHEET_HANDLE,
  VW_SHEET_HEADER,
  VW_SHEET_TITLE,
} from "./viewer-classes";

export function ViewerSheet({
  open,
  onClose,
  title,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" data-testid={testId}>
      <button type="button" aria-label="Close" tabIndex={-1} className={VW_SHEET_BACKDROP} onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cx(VW_SHEET, "vw-sheet-rise")}
      >
        {/* Grab handle (phones): this is a sheet. */}
        <div aria-hidden="true" className="flex justify-center pt-2 sm:hidden">
          <span className={VW_SHEET_HANDLE} />
        </div>
        <div className={VW_SHEET_HEADER}>
          <h2 className={VW_SHEET_TITLE}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={VW_CLOSE_BTN}
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  );
}
