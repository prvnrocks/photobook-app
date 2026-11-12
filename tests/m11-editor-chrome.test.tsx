// M11 T13/T14/T17: editor chrome (coach line, docked pickers, AI label), viewer state screens.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/b/x",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/b/[slug]/actions", () => ({ unlockBookAction: vi.fn() }));

import { coachApplies, CoachLineView } from "@/components/editor/EditorToolbar";
import { EditorShell } from "@/components/editor/EditorShell";
import { aiCaptionTool } from "@/components/editor/tools/ai-caption";
import { layoutPickerTool } from "@/components/editor/tools/layout-picker";
import { photoPickerTool } from "@/components/editor/tools/photo-picker";
import { cropTool } from "@/components/editor/tools/crop-mode";
import { UpgradeSheet } from "@/components/editor/UpgradeSheet";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { BookUnavailable } from "@/components/viewer/public/BookUnavailable";
import { ExpiredBook } from "@/components/viewer/public/ExpiredBook";
import { PasswordGate } from "@/components/viewer/public/PasswordGate";
import BookNotFound from "@/app/b/[slug]/not-found";
import {
  coachSeen,
  EDITOR_COACH_KEY,
  EDITOR_COACH_TEXT,
  markCoachSeen,
  resetCoachMemoryForTests,
  subscribeCoach,
  type CoachStorage,
} from "@/lib/editor/coach";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";

function memStore(): CoachStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

afterEach(() => resetCoachMemoryForTests());

describe("coach line storage", () => {
  it("is unseen until marked; marking writes the key and notifies", () => {
    const s = memStore();
    expect(coachSeen(s)).toBe(false);
    const l = vi.fn();
    const off = subscribeCoach(l);
    markCoachSeen(s);
    off();
    expect(s.map.get(EDITOR_COACH_KEY)).toBe("1");
    expect(coachSeen(s)).toBe(true);
    expect(l).toHaveBeenCalledTimes(1);
  });

  it("survives storage that throws (private mode): hidden for the session after dismiss", () => {
    const bad: CoachStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(coachSeen(bad)).toBe(false);
    expect(() => markCoachSeen(bad)).not.toThrow();
    expect(coachSeen(bad)).toBe(true);
    expect(coachSeen(null)).toBe(true);
  });

  it("applies only with nothing selected, no panel open, editable, and tools shown", () => {
    const base = { readOnly: false, activeTool: null, state: { selection: null } } as unknown as EditorContextValue;
    expect(coachApplies(base, 5)).toBe(true);
    expect(coachApplies({ ...base, readOnly: true }, 5)).toBe(false);
    expect(coachApplies({ ...base, activeTool: "pages" }, 5)).toBe(false);
    expect(coachApplies({ ...base, state: { selection: { kind: "slot", pageIdx: 0, slotIdx: 0 } } } as unknown as EditorContextValue, 5)).toBe(false);
    expect(coachApplies(base, 0)).toBe(false);
  });

  it("renders the exact copy with a 44 px dismiss button", () => {
    const html = renderToStaticMarkup(<CoachLineView onDismiss={() => {}} />);
    expect(EDITOR_COACH_TEXT).toBe("Tap a photo or caption to edit it");
    expect(html).toContain(EDITOR_COACH_TEXT);
    expect(html).toMatch(/aria-label="Dismiss tip"[^>]*size-11|size-11[^>]*aria-label="Dismiss tip"/);
  });

  it("is never in the server HTML (shown only after hydration reads storage)", () => {
    const html = renderToStaticMarkup(<EditorShell data={devEditorData("ok")} transport={devTransport("ok")} />);
    expect(html).not.toContain('data-testid="editor-coach"');
    // Serif editor title keeps dir="auto".
    expect(html).toMatch(/<h1 dir="auto" class="[^"]*font-display[^"]*" data-testid="editor-title"/);
  });
});

describe("editor tools (T14)", () => {
  it("Layout and Replace dock under the page on phones; Crop stays a sheet", () => {
    expect(layoutPickerTool.dockOnMobile).toBe(true);
    expect(photoPickerTool.dockOnMobile).toBe(true);
    expect(cropTool.dockOnMobile).toBeFalsy();
  });

  it("AI tool uses the Sparkles icon and a plain label (no emoji)", () => {
    expect(aiCaptionTool.label).toBe("AI help");
    expect(aiCaptionTool.panelTitle).toBe("AI caption help");
    expect(aiCaptionTool.label).not.toMatch(/✨/);
  });

  it("upgrade sheet uses tokens, keeps price and benefits", () => {
    const html = renderToStaticMarkup(
      <UpgradeSheet ctx={{ book: { id: "b1", isPaid: false } as EditorContextValue["book"], paymentsEnabled: false }} />,
    );
    expect(html).toContain("Upgrade this book");
    expect(html).toContain("AED 39");
    expect(html).toContain("No watermark");
    expect(html).toContain("Permanent link");
    expect(html).not.toMatch(/amber-|emerald-/);
  });
});

describe("public viewer state screens (T17)", () => {
  const screens: [string, string, string][] = [
    ["password", renderToStaticMarkup(<PasswordGate slug="s" />), "This photobook is private"],
    ["expired", renderToStaticMarkup(<ExpiredBook isOwner={false} />), "This photobook has expired"],
    ["unavailable", renderToStaticMarkup(<BookUnavailable />), "This photobook can&#x27;t be shown right now"],
    ["not-found", renderToStaticMarkup(<BookNotFound />), "We couldn&#x27;t find this photobook"],
  ];
  for (const [name, html, title] of screens) {
    it(`${name}: serif EmptyState title on paper, no raw neutral colours`, () => {
      expect(html).toContain(title);
      expect(html).toMatch(/<h1 dir="auto" class="type-h2/);
      expect(html).toContain("bg-background");
      expect(html).not.toMatch(/neutral-\d|red-\d|amber-\d/);
    });
  }

  it("expired (visitor) keeps the create-yours CTA; password gate keeps its form testids", () => {
    expect(screens[1][1]).toContain('data-testid="expired-create"');
    expect(screens[1][1]).toContain("no longer active");
    expect(screens[0][1]).toContain('data-testid="password-input"');
    expect(screens[0][1]).toContain('data-testid="password-submit"');
    expect(screens[0][1]).toContain("Enter the password you were given to open it.");
  });
});
