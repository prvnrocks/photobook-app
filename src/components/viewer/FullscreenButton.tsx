"use client";

// Fullscreen for the viewer. Uses the Fullscreen API when the browser supports it on elements;
// otherwise (iPhone Safari, WhatsApp/Instagram in-app browsers) a pseudo-fullscreen: the viewer
// root becomes fixed inset-0 and the controls hide until the reader taps to show them.

import { useCallback, useEffect, useState, type RefObject } from "react";
import { Maximize, Minimize } from "lucide-react";

export type FullscreenMode = "off" | "native" | "pseudo";

type WebkitDoc = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type WebkitEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

function nativeElement(): Element | null {
  const d = document as WebkitDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

function canNative(el: HTMLElement): boolean {
  const d = document as WebkitDoc;
  return Boolean(
    (d.fullscreenEnabled && typeof el.requestFullscreen === "function") ||
      (d.webkitFullscreenEnabled && typeof (el as WebkitEl).webkitRequestFullscreen === "function"),
  );
}

export function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [mode, setMode] = useState<FullscreenMode>("off");

  useEffect(() => {
    const sync = () => setMode((m) => (nativeElement() ? "native" : m === "native" ? "off" : m));
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  // Escape leaves pseudo-fullscreen (native fullscreen handles Escape itself).
  useEffect(() => {
    if (mode !== "pseudo") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setMode("off");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const enter = useCallback(async () => {
    const el = target.current;
    if (!el) return;
    if (canNative(el)) {
      try {
        if (typeof el.requestFullscreen === "function") await el.requestFullscreen();
        else await (el as WebkitEl).webkitRequestFullscreen?.();
        setMode("native");
        return;
      } catch {
        // Refused (in-app browsers, iframes): fall through to pseudo-fullscreen.
      }
    }
    setMode("pseudo");
  }, [target]);

  const exit = useCallback(async () => {
    if (nativeElement()) {
      const d = document as WebkitDoc;
      try {
        if (typeof d.exitFullscreen === "function") await d.exitFullscreen();
        else await d.webkitExitFullscreen?.();
      } catch {
        // Already left.
      }
    }
    setMode("off");
  }, []);

  const toggle = useCallback(() => (mode === "off" ? enter() : exit()), [mode, enter, exit]);

  return { mode, enter, exit, toggle };
}

export function FullscreenButton({ active, onToggle, className }: { active: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={active ? "Exit fullscreen" : "Fullscreen"}
      aria-pressed={active}
      className={`flex size-10 shrink-0 items-center justify-center rounded-full text-neutral-700 hover:bg-neutral-100 ${className ?? ""}`}
      data-testid="fullscreen-button"
    >
      {active ? <Minimize className="size-5" aria-hidden /> : <Maximize className="size-5" aria-hidden />}
    </button>
  );
}
