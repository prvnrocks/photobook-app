// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOADING_ESCAPE_MS, LoadingEscape } from "@/app/books/new/LoadingEscape";
import { rememberAlbumConfirmed } from "@/lib/books/wizard-confirmed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK = "11111111-2222-4333-8444-555555555555";

let root: Root | null = null;
function render(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  act(() => r.render(el));
  return { unmount: () => act(() => r.unmount()) };
}
function cleanup() {
  if (root) {
    const r = root;
    root = null;
    act(() => r.unmount());
  }
}

describe("LoadingEscape (M20c stuck Back restore)", () => {
  const replace = vi.fn();
  const reload = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    replace.mockReset();
    reload.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, pathname: "/books/new", search: "", replace, reload },
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function at(search: string) {
    (window.location as unknown as { search: string }).search = search;
  }

  it("leaves for the editor at once when this tab generated the book", () => {
    rememberAlbumConfirmed(BOOK);
    at(`?book=${BOOK}&step=4`);
    render(<LoadingEscape />);
    expect(replace).toHaveBeenCalledWith(`/books/${BOOK}/edit`);
    act(() => vi.advanceTimersByTime(LOADING_ESCAPE_MS + 1));
    expect(reload).not.toHaveBeenCalled();
  });

  it("does nothing while a normal load finishes in time", () => {
    at(`?book=${BOOK}&step=5`);
    render(<LoadingEscape />);
    act(() => vi.advanceTimersByTime(LOADING_ESCAPE_MS - 1));
    cleanup();
    act(() => vi.advanceTimersByTime(10_000));
    expect(replace).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads a stuck skeleton once per URL, never in a loop", () => {
    at(`?book=${BOOK}&step=4`);
    render(<LoadingEscape />);
    act(() => vi.advanceTimersByTime(LOADING_ESCAPE_MS + 1));
    expect(reload).toHaveBeenCalledTimes(1);
    cleanup();
    render(<LoadingEscape />);
    act(() => vi.advanceTimersByTime(LOADING_ESCAPE_MS + 1));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed book id", () => {
    rememberAlbumConfirmed("not-a-uuid");
    at("?book=not-a-uuid&step=4");
    render(<LoadingEscape />);
    expect(replace).not.toHaveBeenCalled();
  });
});
