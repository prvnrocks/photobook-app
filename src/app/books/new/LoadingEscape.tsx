"use client";

// M20c: browser Back across a soft-navigated /books/new entry can restore this loading screen from
// Next's router cache without ever fetching the page (seen on the step-4 entry the wizard rewrote with
// ?book= after creating the book). NewBookWizard never mounts, so its "generated here" check can't run.
// This island runs the same check while the skeleton shows, and as a last resort reloads the URL once
// (a real load goes through the server gate, which sends a generated book to the editor).
import { useEffect } from "react";
import { wasAlbumConfirmedHere } from "@/lib/books/wizard-confirmed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A real step load takes well under this; past it the skeleton is a stuck cache restore. */
export const LOADING_ESCAPE_MS = 8000;
const RELOADED_KEY = "photobook:wizard-loading-reloaded";

export function LoadingEscape() {
  useEffect(() => {
    const bookId = new URLSearchParams(window.location.search).get("book");
    if (bookId && UUID.test(bookId) && wasAlbumConfirmedHere(bookId)) {
      window.location.replace(`/books/${bookId}/edit`);
      return;
    }
    const url = window.location.pathname + window.location.search;
    const timer = window.setTimeout(() => {
      try {
        if (window.sessionStorage.getItem(RELOADED_KEY) === url) return; // once per URL, never a loop
        window.sessionStorage.setItem(RELOADED_KEY, url);
      } catch {
        return;
      }
      window.location.reload();
    }, LOADING_ESCAPE_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}
