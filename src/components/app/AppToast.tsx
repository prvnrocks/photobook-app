"use client";

// App toast (M11, D-067): one short confirmation ("Link copied", "Album updated"). The live region is
// always mounted (polite, atomic) so screen readers hear the message when it appears; the parent
// owns the message and clears it via onDismiss (auto after durationMs, or the close button).
// `inline` renders in flow instead of fixed above the bottom edge (style board, tests).

import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

export type AppToastTone = "neutral" | "success" | "error";

export function AppToast({
  message,
  tone = "neutral",
  onDismiss,
  durationMs = 4000,
  inline = false,
  className,
}: {
  message: string | null;
  tone?: AppToastTone;
  onDismiss?: () => void;
  /** 0 = stays until dismissed. */
  durationMs?: number;
  inline?: boolean;
  className?: string;
}) {
  useEffect(() => {
    if (!message || !onDismiss || durationMs <= 0) return;
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [message, onDismiss, durationMs]);

  const Icon = tone === "error" ? CircleAlert : tone === "success" ? CircleCheck : null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="app-toast"
      className={cn(
        "pointer-events-none flex justify-center",
        !inline && "fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-50 px-gutter sm:bottom-8",
        className,
      )}
    >
      {message ? (
        <div className="pointer-events-auto flex max-w-sm min-w-0 items-center gap-3 rounded-xl bg-primary py-2 ps-4 pe-2 text-primary-foreground shadow-lift">
          {Icon ? (
            <Icon className={cn("size-5 shrink-0", tone === "error" ? "text-[#f4b4a8]" : "text-[#a7d7b8]")} aria-hidden="true" />
          ) : null}
          <p dir="auto" className="type-small min-w-0 flex-1 py-1.5">
            {message}
          </p>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-primary-foreground/80 outline-none hover:text-primary-foreground focus-visible:ring-2 focus-visible:ring-primary-foreground"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : (
            <span className="w-2" aria-hidden="true" />
          )}
        </div>
      ) : null}
    </div>
  );
}
