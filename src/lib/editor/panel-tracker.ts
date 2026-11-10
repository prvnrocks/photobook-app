// Follows the open editor tool panel (data-editor-panel) for the toast (M10b A4): re-measures
// whenever the panel's size changes (ResizeObserver), the page around it changes size (a docked
// panel moves when the page above it does), the panel mounts / unmounts / is replaced (tool or
// selection change — MutationObserver), or the viewport resizes (rotation, on-screen keyboard).
// DOM-free: the environment is injected, so it is unit-tested with fakes (no jsdom here).

export interface ResizeObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export interface MutationObserverLike {
  observe(target: Node, options: { childList: boolean; subtree: boolean }): void;
  disconnect(): void;
}

export interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface PanelTrackerEnv {
  /** The open panel, or null. */
  findPanel(): Element | null;
  /** Element whose size changes may move the panel (document.body); also watched for (un)mounts. */
  root: Element;
  createResizeObserver?: (cb: () => void) => ResizeObserverLike;
  createMutationObserver?: (cb: () => void) => MutationObserverLike;
  /** Fire "resize" when the viewport changes (window, visualViewport). */
  viewports: readonly EventTargetLike[];
}

/**
 * Calls `onMeasure(panel)` now and after every change that can move the panel; returns the
 * disposer. `panel` is null when no panel is open.
 */
export function trackEditorPanel(env: PanelTrackerEnv, onMeasure: (panel: Element | null) => void): () => void {
  let observed: Element | null = null;
  let disposed = false;
  const ro = env.createResizeObserver?.(() => sync()) ?? null;

  function sync() {
    if (disposed) return;
    const panel = env.findPanel();
    if (panel !== observed) {
      if (observed) ro?.unobserve(observed);
      if (panel) ro?.observe(panel);
      observed = panel;
    }
    onMeasure(panel);
  }

  ro?.observe(env.root);
  const mo = env.createMutationObserver?.(() => sync()) ?? null;
  mo?.observe(env.root, { childList: true, subtree: true });
  for (const v of env.viewports) v.addEventListener("resize", sync);
  sync();

  return () => {
    disposed = true;
    ro?.disconnect();
    mo?.disconnect();
    for (const v of env.viewports) v.removeEventListener("resize", sync);
  };
}

/** The browser environment (call only in effects). */
export function browserPanelTrackerEnv(): PanelTrackerEnv {
  return {
    findPanel: () => document.querySelector("[data-editor-panel]"),
    root: document.body,
    createResizeObserver: typeof ResizeObserver === "undefined" ? undefined : (cb) => new ResizeObserver(cb),
    createMutationObserver: typeof MutationObserver === "undefined" ? undefined : (cb) => new MutationObserver(cb),
    viewports: [window, ...(window.visualViewport ? [window.visualViewport] : [])],
  };
}
