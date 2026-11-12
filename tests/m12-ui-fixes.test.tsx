// M12 T6 — small user-visible fixes: one "Add photo" on an empty split-strip cover (edit only),
// and the Layout picker memoising its options (planChangeLayout not re-run on unrelated renders).

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookPage } from "@/components/book/BookPage";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { LayoutPickerPanel } from "@/components/editor/tools/layout-picker";
import { devSampleDoc, devSamplePhotos } from "@/lib/book/dev-sample";
import type { BookDoc } from "@/lib/book/types";
import { devEditorData } from "@/lib/editor/dev-fixture";
import { initEditorState, type EditorState } from "@/lib/editor/store";

const plan = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/book/edit-ops", async (orig) => {
  const real = await orig<typeof import("@/lib/book/edit-ops")>();
  return {
    ...real,
    planChangeLayout: (...args: Parameters<typeof real.planChangeLayout>) => {
      plan.calls++;
      return real.planChangeLayout(...args);
    },
  };
});
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

// Minimal hook runner: calls a function component directly, keeping useState/useMemo slots
// across calls with React's semantics (deps compared with Object.is). No DOM needed.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, active: false }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  const useMemo = <T,>(fn: () => T, deps: readonly unknown[]): T => {
    if (!hooks.active) return real.useMemo(fn, deps);
    const i = hooks.i++;
    const prev = hooks.slots[i] as { v: T; deps: readonly unknown[] } | undefined;
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, k) => Object.is(d, deps[k]))) return prev.v;
    const v = fn();
    hooks.slots[i] = { v, deps };
    return v;
  };
  const useState = <T,>(init: T | (() => T)) => {
    if (!hooks.active) return real.useState(init);
    const i = hooks.i++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof init === "function" ? (init as () => T)() : init;
    return [hooks.slots[i] as T, (v: T) => (hooks.slots[i] = v)] as const;
  };
  return { ...real, default: { ...real, useMemo, useState }, useMemo, useState };
});

function renderHooks<P>(Component: (p: P) => unknown, props: P) {
  hooks.i = 0;
  hooks.active = true;
  try {
    return Component(props);
  } finally {
    hooks.active = false;
  }
}

afterEach(() => {
  hooks.slots = [];
  plan.calls = 0;
});

const photos = devSamplePhotos();
const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

describe("empty split-strip cover", () => {
  it.each(["modern-portrait", "modern-landscape"] as const)("%s: one centred Add photo in edit, none in view/print", (sample) => {
    const base = devSampleDoc(sample);
    const doc: BookDoc = { ...base, cover: { ...base.cover, photoId: null } };
    const edit = renderToStaticMarkup(<BookPage doc={doc} page="cover" mode="edit" photos={photos} />);
    expect(edit).toContain('data-slot-sliced="true"');
    expect(count(edit, /data-slice="/g)).toBe(3);
    expect(count(edit, /Add photo/g)).toBe(1);
    expect(count(edit, /data-testid="slot-placeholder-label"/g)).toBe(1);
    // The label sits on the slot box (not inside a slice window).
    expect(edit).toMatch(/data-slot-sliced="true">[\s\S]*<\/div><div class="pointer-events-none absolute inset-0 flex items-center justify-center[^"]*"[^>]*data-testid="slot-placeholder-label">Add photo<\/div>/);
    for (const mode of ["view", "print"] as const) {
      const html = renderToStaticMarkup(<BookPage doc={doc} page="cover" mode={mode} photos={photos} />);
      expect(html).not.toContain("Add photo");
      expect(html).not.toContain("slot-placeholder");
    }
  });

  it("a filled split-strip cover shows no label in edit", () => {
    const doc = devSampleDoc("modern-portrait");
    const edit = renderToStaticMarkup(<BookPage doc={doc} page="cover" mode="edit" photos={photos} />);
    expect(edit).not.toContain("Add photo");
  });
});

describe("LayoutPickerPanel memoises layout options", () => {
  function ctxFor(state: EditorState, maxPages = 20, extra: Partial<EditorContextValue> = {}) {
    return {
      book: { ...devEditorData("ok").book, maxPages },
      state,
      readOnly: false,
      actions: { edit: vi.fn(), undo: vi.fn(), goTo: vi.fn(), select: vi.fn() },
      photos: { web: {}, thumbs: {} },
      activeTool: null,
      openTool: vi.fn(),
      closeTool: vi.fn(),
      ...extra,
    } as unknown as EditorContextValue;
  }

  it("does not re-plan on an unrelated re-render; re-plans when its inputs change", () => {
    const state = initEditorState(devSampleDoc("modern-portrait"), { page: 8 });
    const close = () => {};
    renderHooks(LayoutPickerPanel, { ctx: ctxFor(state), close });
    const first = plan.calls;
    expect(first).toBeGreaterThan(1);

    // New ctx object, new close, other tool state — same doc / page / maxPages.
    renderHooks(LayoutPickerPanel, { ctx: ctxFor({ ...state }, 20, { activeTool: "layout" } as Partial<EditorContextValue>), close: () => {} });
    expect(plan.calls).toBe(first);

    renderHooks(LayoutPickerPanel, { ctx: ctxFor(state, 100), close });
    expect(plan.calls).toBe(first * 2);

    renderHooks(LayoutPickerPanel, { ctx: ctxFor({ ...state, page: 9 }, 100), close });
    expect(plan.calls).toBe(first * 3);
  });
});
