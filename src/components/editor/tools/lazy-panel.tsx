"use client";

// Lazily loaded tool panels (M30 review, D-091 bundle budget). A tool's descriptor (id, label, icon,
// scopes, isAvailable…) stays in the editor's first-load chunk so the toolbar renders at once; the
// Panel component arrives in its own chunk:
//
//   Panel: lazyPanel(() => import("./accent-colour-panel").then((m) => m.AccentColourPanel), "min-h-[11.75rem]"),
//
// - While the chunk loads the panel shows a quiet placeholder of about the panel's height at 375 px
//   (the `placeholder` min-height class), so a docked panel doesn't resize the page twice.
// - In the browser the chunks are fetched when the main thread is idle after the editor loads, so
//   the placeholder is normally never seen. A failed fetch is retried once (flaky phone networks).
// - A panel mounts either directly (chunk already there) or under Suspense, decided once per
//   mount: it never remounts — and loses its state — when the chunk arrives.

import { lazy, Suspense, useState, type ComponentType } from "react";
import { cx } from "@/lib/cx";
import type { EditorPanelProps } from "./types";

type PanelComponent = ComponentType<EditorPanelProps>;

const loaders: (() => Promise<unknown>)[] = [];
let idleScheduled = false;

/** Load every lazy panel chunk now (idle preload in the browser; `beforeAll` in jsdom tests). */
export function preloadLazyPanels(): Promise<void> {
  return Promise.all(loaders.map((l) => l())).then(() => undefined);
}

function scheduleIdlePreload(): void {
  // Not in unit tests: a late import after jsdom teardown would fail the run.
  if (idleScheduled || typeof window === "undefined" || process.env.NODE_ENV === "test") return;
  idleScheduled = true;
  const go = () => void preloadLazyPanels().catch(() => {});
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(go, { timeout: 4000 });
  else window.setTimeout(go, 1500);
}

/**
 * A Panel whose code lives in its own chunk. `placeholder` = Tailwind min-height class matching
 * the loaded panel at 375 px.
 */
export function lazyPanel(load: () => Promise<PanelComponent>, placeholder: string): PanelComponent {
  let Loaded: PanelComponent | null = null;
  let pending: Promise<{ default: PanelComponent }> | null = null;
  const loadOnce = () =>
    (pending ??= load()
      .catch(() => load())
      .then(
        (C) => {
          Loaded = C;
          return { default: C };
        },
        (err: unknown) => {
          pending = null;
          throw err;
        },
      ));
  const Lazy = lazy(loadOnce);
  loaders.push(loadOnce);
  scheduleIdlePreload();

  function LazyPanel(props: EditorPanelProps) {
    const [Direct] = useState(() => Loaded);
    if (Direct) return <Direct {...props} />;
    return (
      <Suspense
        fallback={
          <div role="status" aria-busy="true" className={cx("rounded-2xl bg-[#f3eee2] motion-safe:animate-pulse", placeholder)} data-testid="editor-panel-loading">
            <span className="sr-only">Loading…</span>
          </div>
        }
      >
        <Lazy {...props} />
      </Suspense>
    );
  }
  return LazyPanel;
}
