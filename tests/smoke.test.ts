import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("joins plain class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("resolves Tailwind conflicts (last wins)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm text-red-500", "text-blue-500")).toBe("text-sm text-blue-500");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, null, undefined, "", 0 as unknown as string, "b")).toBe("a b");
  });

  it("supports conditional object syntax", () => {
    expect(cn("base", { active: true, hidden: false })).toBe("base active");
  });
});
