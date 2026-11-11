"use client";

// Account menu for the signed-in header (M11 T5, D-067): one 44 px round button (initial of the
// user's name/email) opens a small panel with the full email, Settings and Sign out. The panel
// content is passed in from the server header so the sign-out server action stays out of this
// client module. Closes on Escape (focus back to the button), outside tap and on a link tap.

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** First visible letter of the name/email, upper-cased; "?" when unknown. */
export function accountInitial(displayName: string | null | undefined): string {
  const ch = Array.from((displayName ?? "").trim())[0];
  return ch ? ch.toLocaleUpperCase() : "?";
}

export function AccountMenu({
  displayName,
  children,
  defaultOpen = false,
}: {
  displayName?: string | null;
  children: ReactNode;
  /** Tests / style board only. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Account menu"
        data-testid="account-menu-button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 items-center gap-1 rounded-full ps-1 pe-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-expanded:bg-muted"
      >
        <span
          aria-hidden="true"
          className="flex size-9 items-center justify-center rounded-full bg-primary font-display text-base font-semibold text-primary-foreground"
        >
          {accountInitial(displayName)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180")}
        />
      </button>
      <div
        id={panelId}
        hidden={!open}
        data-testid="account-menu"
        // A link inside closes the menu (client navigation keeps the header mounted). Sign out is a
        // form submit that leaves the page, so it is left alone.
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) setOpen(false);
        }}
        className="absolute end-0 top-full z-40 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-lift"
      >
        {children}
      </div>
    </div>
  );
}
