"use client";
// Sets window.__PRINT_READY__ once every image on the page has decoded (or failed) and the
// fonts are ready, capped at 20 s (src/lib/pdf/print-ready.ts). Renders nothing.

import { useEffect } from "react";
import { backgroundImageSources, publishPrintReady, waitForPrintReady, type PrintReadyGlobals } from "@/lib/pdf/print-ready";

export function PrintReady() {
  useEffect(() => {
    const w = window as unknown as PrintReadyGlobals & { __PRINT_READY_STARTED__?: boolean };
    // StrictMode runs effects twice in dev; one wait is enough and nothing needs cancelling.
    if (w.__PRINT_READY_STARTED__) return;
    w.__PRINT_READY_STARTED__ = true;
    // Texture layers are CSS backgrounds: load each URL as an Image too (same cache entry).
    const cssImages = backgroundImageSources(document).map((src) => {
      const img = new Image();
      img.src = src;
      return img;
    });
    void waitForPrintReady({
      images: [...Array.from(document.images), ...cssImages],
      fontsReady: document.fonts ? document.fonts.ready : Promise.resolve(),
    }).then((r) => publishPrintReady(w, r));
  }, []);
  return null;
}
