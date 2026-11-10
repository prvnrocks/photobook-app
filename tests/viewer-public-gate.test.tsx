import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/b/[slug]/actions", () => ({ unlockBookAction: vi.fn() }));

import BookNotFound from "@/app/b/[slug]/not-found";
import { PasswordGate } from "@/components/viewer/public/PasswordGate";
import type { UnlockErrorCode } from "@/lib/publish/unlock-types";
import { claimImageRefresh, IMAGE_REFRESH_COOLDOWN_MS, isBookPhotoSrc } from "@/lib/viewer/image-refresh";
import { UNLOCK_ERROR_COPY, unlockErrorCopy } from "@/lib/viewer/unlock-copy";
import nextConfig, { PUBLIC_BOOK_HEADERS } from "../next.config";

describe("PasswordGate", () => {
  it("renders a password form without any book title", () => {
    const html = renderToStaticMarkup(<PasswordGate slug="our-trip-AbCdEfGhJk" />);
    expect(html).toContain('type="password"');
    expect(html).toContain('name="password"');
    expect(html).toContain("This photobook is private");
    expect(html).not.toContain("our-trip");
  });

  it("maps every unlock error code to copy", () => {
    const codes: UnlockErrorCode[] = ["wrong_password", "rate_limited", "unavailable", "invalid_input", "not_found"];
    for (const c of codes) expect(unlockErrorCopy(c)).toBe(UNLOCK_ERROR_COPY[c]);
    expect(unlockErrorCopy("rate_limited")).toContain("Too many tries — wait 15 minutes");
    expect(unlockErrorCopy("wrong_password")).toMatch(/password isn't right/);
    expect(unlockErrorCopy("unavailable")).toMatch(/try again later/);
    expect(unlockErrorCopy("invalid_input")).toMatch(/Enter the password/);
    expect(unlockErrorCopy("bogus" as UnlockErrorCode)).toBe(UNLOCK_ERROR_COPY.unavailable);
  });
});

describe("not-found page", () => {
  it("has a create-yours CTA", () => {
    const html = renderToStaticMarkup(<BookNotFound />);
    expect(html).toContain("couldn&#x27;t find this photobook");
    expect(html).toContain('data-testid="not-found-create"');
  });
});

describe("image refresh guard", () => {
  it("allows one refresh per cooldown per slug, via storage or memory", () => {
    const map = new Map<string, string>();
    const store = { get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) };
    const mem = { last: null as number | null };
    expect(claimImageRefresh("a", 1_000_000, store, mem)).toBe(true);
    expect(claimImageRefresh("a", 1_000_500, store, { last: null })).toBe(false); // from storage
    expect(claimImageRefresh("b", 1_000_500, store, { last: null })).toBe(true);
    expect(claimImageRefresh("a", 1_000_000 + IMAGE_REFRESH_COOLDOWN_MS, store, mem)).toBe(true);
  });

  it("works when storage throws", () => {
    const store = {
      get: () => {
        throw new Error("blocked");
      },
      set: () => {
        throw new Error("blocked");
      },
    };
    const mem = { last: null as number | null };
    expect(claimImageRefresh("a", 10, store, mem)).toBe(true);
    expect(claimImageRefresh("a", 20, store, mem)).toBe(false);
  });

  it("only reacts to book photo URLs", () => {
    const urls = new Set(["https://x.supabase.co/storage/v1/object/sign/photos/a.jpg?token=1"]);
    expect(isBookPhotoSrc("https://x.supabase.co/storage/v1/object/sign/photos/a.jpg?token=1", urls)).toBe(true);
    expect(isBookPhotoSrc("https://other.example/logo.png", urls)).toBe(false);
    expect(isBookPhotoSrc("", urls)).toBe(false);
  });
});

describe("next.config headers", () => {
  it("noindex + no-referrer on /b/:path*", async () => {
    const rules = await nextConfig.headers!();
    const rule = rules.find((r) => r.source === "/b/:path*");
    expect(rule?.headers).toEqual(PUBLIC_BOOK_HEADERS);
    const map = Object.fromEntries(PUBLIC_BOOK_HEADERS.map((x) => [x.key, x.value]));
    expect(map["X-Robots-Tag"]).toBe("noindex, nofollow");
    expect(map["Referrer-Policy"]).toBe("no-referrer");
  });

  it("robots.txt does not disallow /b/", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    for (const f of ["public/robots.txt", "src/app/robots.ts", "src/app/robots.txt"]) {
      if (existsSync(f)) expect(readFileSync(f, "utf8")).not.toMatch(/Disallow:\s*\/b\b|disallow:[^\n]*["']\/b/);
    }
  });
});
