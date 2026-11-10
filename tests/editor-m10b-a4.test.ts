// M10b A4: background picker polish — focus-only radio keys (Whole-book photo grid) and the
// toast's panel tracker. No DOM environment: fakes stand in for elements and observers.
import type { KeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onRadioGroupKeyDown, onRadioGroupKeyDownFocusOnly } from "@/components/editor/radio-group-keys";
import { trackEditorPanel, type EventTargetLike, type PanelTrackerEnv } from "@/lib/editor/panel-tracker";

// ---- radio keys ---------------------------------------------------------------------------------

type FakeRadio = { checked: boolean; disabled: boolean; clicks: number; focus(): void; click(): void; getAttribute(n: string): string | null; closest(): unknown };

function fakeGroup(n: number, checkedIdx: number) {
  const group: { radios: FakeRadio[]; querySelectorAll(): FakeRadio[] } = { radios: [], querySelectorAll: () => group.radios };
  for (let i = 0; i < n; i++) {
    const r: FakeRadio = {
      checked: i === checkedIdx,
      disabled: false,
      clicks: 0,
      focus() {
        (globalThis as { document?: unknown }).document = { activeElement: r };
      },
      click() {
        r.clicks++;
      },
      getAttribute: (name) => (name === "aria-checked" ? String(r.checked) : null),
      closest: () => group,
    };
    group.radios.push(r);
  }
  return group;
}

function keyEvent(group: unknown, key: string) {
  const e = { key, altKey: false, ctrlKey: false, metaKey: false, currentTarget: group, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  return e as unknown as KeyboardEvent<HTMLElement> & { preventDefault: ReturnType<typeof vi.fn> };
}

describe("radio group keys", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it("select-on-arrow (default): ArrowRight focuses AND clicks the next radio", () => {
    const g = fakeGroup(4, 0);
    g.radios[0].focus();
    onRadioGroupKeyDown(keyEvent(g, "ArrowRight"));
    expect((globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement).toBe(g.radios[1]);
    expect(g.radios[1].clicks).toBe(1);
  });

  it("focus-only (Whole-book photo grid): arrows / Home / End move focus, never apply", () => {
    const g = fakeGroup(4, 0);
    g.radios[0].focus();
    const doc = () => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement;
    for (const key of ["ArrowRight", "ArrowRight", "ArrowDown"]) {
      const e = keyEvent(g, key);
      onRadioGroupKeyDownFocusOnly(e);
      expect(e.preventDefault).toHaveBeenCalled();
    }
    expect(doc()).toBe(g.radios[3]);
    onRadioGroupKeyDownFocusOnly(keyEvent(g, "Home"));
    expect(doc()).toBe(g.radios[0]);
    onRadioGroupKeyDownFocusOnly(keyEvent(g, "End"));
    expect(doc()).toBe(g.radios[3]);
    expect(g.radios.reduce((n, r) => n + r.clicks, 0)).toBe(0);
    // Enter / Space are left to the button (native click = one apply).
    const enter = keyEvent(g, "Enter");
    onRadioGroupKeyDownFocusOnly(enter);
    expect(enter.preventDefault).not.toHaveBeenCalled();
  });
});

// ---- panel tracker ------------------------------------------------------------------------------

class FakeTarget implements EventTargetLike {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, l: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: () => void) {
    this.listeners.get(type)?.delete(l);
  }
  fire(type: string) {
    for (const l of this.listeners.get(type) ?? []) l();
  }
}

function setup() {
  const root = { id: "body" } as unknown as Element;
  let panel: Element | null = { id: "panel-a" } as unknown as Element;
  const observed = new Set<Element>();
  let roCb: (() => void) | null = null;
  let moCb: (() => void) | null = null;
  const disconnects = { ro: 0, mo: 0 };
  const win = new FakeTarget();
  const vv = new FakeTarget();
  const env: PanelTrackerEnv = {
    findPanel: () => panel,
    root,
    createResizeObserver: (cb) => {
      roCb = cb;
      return { observe: (el) => observed.add(el), unobserve: (el) => observed.delete(el), disconnect: () => disconnects.ro++ };
    },
    createMutationObserver: (cb) => {
      moCb = cb;
      return { observe: () => {}, disconnect: () => disconnects.mo++ };
    },
    viewports: [win, vv],
  };
  const seen: (Element | null)[] = [];
  const stop = trackEditorPanel(env, (p) => seen.push(p));
  return {
    seen,
    stop,
    observed,
    disconnects,
    win,
    vv,
    root,
    setPanel: (p: Element | null) => (panel = p),
    resize: () => roCb?.(),
    mutate: () => moCb?.(),
  };
}

describe("toast follows the open panel (M10b A4)", () => {
  it("measures now and on every panel / page resize, not once", () => {
    const t = setup();
    expect(t.seen).toHaveLength(1);
    expect(t.observed.has(t.root)).toBe(true);
    expect([...t.observed].some((e) => (e as unknown as { id: string }).id === "panel-a")).toBe(true);
    t.resize();
    t.resize();
    expect(t.seen).toHaveLength(3);
    t.win.fire("resize");
    t.vv.fire("resize");
    expect(t.seen).toHaveLength(5);
  });

  it("re-targets when the panel is swapped, closed or opened after the toast appeared", () => {
    const t = setup();
    const b = { id: "panel-b" } as unknown as Element;
    t.setPanel(b);
    t.mutate();
    expect(t.seen.at(-1)).toBe(b);
    expect(t.observed.has(b)).toBe(true);
    expect([...t.observed].some((e) => (e as unknown as { id: string }).id === "panel-a")).toBe(false);
    t.setPanel(null);
    t.mutate();
    expect(t.seen.at(-1)).toBeNull();
    expect(t.observed.has(b)).toBe(false);
    t.setPanel(b);
    t.mutate();
    expect(t.seen.at(-1)).toBe(b);
  });

  it("disposes observers and listeners; late callbacks are ignored", () => {
    const t = setup();
    t.stop();
    expect(t.disconnects).toEqual({ ro: 1, mo: 1 });
    expect(t.win.listeners.get("resize")?.size ?? 0).toBe(0);
    expect(t.vv.listeners.get("resize")?.size ?? 0).toBe(0);
    const n = t.seen.length;
    t.resize();
    t.mutate();
    expect(t.seen).toHaveLength(n);
  });

  it("works without ResizeObserver / MutationObserver (viewport resize only)", () => {
    const win = new FakeTarget();
    const seen: unknown[] = [];
    const stop = trackEditorPanel({ findPanel: () => null, root: {} as Element, viewports: [win] }, (p) => seen.push(p));
    win.fire("resize");
    expect(seen).toEqual([null, null]);
    stop();
  });
});
