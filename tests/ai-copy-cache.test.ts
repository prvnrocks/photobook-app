import { describe, expect, it } from "vitest";
import { newAiCopyCache } from "@/lib/photos/ai-copy-cache";

describe("tick-scoped AI copy memory", () => {
  it("returns what was kept; the first copy of a path wins; nothing past the byte bound is kept", () => {
    const c = newAiCopyCache(10);
    c.set("a", "12345");
    c.set("a", "zzzzz");
    c.set("b", "1234");
    c.set("c", "12"); // would pass 10 bytes
    expect(c.get("a")).toBe("12345");
    expect(c.get("b")).toBe("1234");
    expect(c.get("c")).toBeUndefined();
    expect(c.get("missing")).toBeUndefined();
  });
});
