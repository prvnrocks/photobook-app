// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/app/settings/actions", () => ({ setEmailRemindersAction: vi.fn(), deleteAccountAction: vi.fn() }));

import { EmailRemindersToggleView } from "@/components/settings/EmailRemindersToggle";
import type { SetEmailRemindersResult } from "@/lib/settings/account";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(el: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  act(() => r.render(el));
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

const sw = () => host!.querySelector<HTMLButtonElement>('[role="switch"]')!;

describe("EmailRemindersToggle (M24: never stuck busy after a save)", () => {
  it("can be toggled twice in a row without a reload", async () => {
    const save = vi.fn(async (on: boolean): Promise<SetEmailRemindersResult> => ({ ok: true, on }));
    render(<EmailRemindersToggleView initialOn={true} save={save} />);
    expect(sw().getAttribute("aria-checked")).toBe("true");

    await act(async () => sw().click());
    expect(save).toHaveBeenLastCalledWith(false);
    expect(sw().disabled).toBe(false);
    expect(sw().getAttribute("aria-busy")).not.toBe("true");
    expect(sw().getAttribute("aria-checked")).toBe("false");

    await act(async () => sw().click());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(true);
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(sw().disabled).toBe(false);
  });

  it("is busy only while the save is in flight, and flips back on failure", async () => {
    let resolve!: (r: SetEmailRemindersResult) => void;
    const save = vi.fn(() => new Promise<SetEmailRemindersResult>((r) => (resolve = r)));
    render(<EmailRemindersToggleView initialOn={true} save={save} />);

    await act(async () => sw().click());
    expect(sw().disabled).toBe(true);
    await act(async () => resolve({ ok: false, error: "failed" } as SetEmailRemindersResult));
    expect(sw().disabled).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("true");
  });
});
