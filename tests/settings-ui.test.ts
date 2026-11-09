import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPTION_LENGTHS } from "@/lib/ai/schemas";
import { TONES } from "@/lib/book/options";
import {
  CAPTION_LENGTH_LABELS,
  clearOutcome,
  effectiveTone,
  isMemoryViewEmpty,
  lastUpdatedLabel,
  memoryRows,
  newBookInitialState,
  SETTINGS_CAPTION_LENGTHS,
  SETTINGS_COPY,
  showFromMemoryHint,
} from "@/lib/settings/ui";

describe("settings ui helpers", () => {
  it("caption lengths mirror the AI schema", () => {
    expect([...SETTINGS_CAPTION_LENGTHS]).toEqual([...CAPTION_LENGTHS]);
    expect(CAPTION_LENGTH_LABELS).toEqual({ short: "Short", medium: "Medium", long: "Long" });
  });

  it("memoryRows maps enums to friendly labels in display order", () => {
    const rows = memoryRows({
      tone: "romantic",
      captionLength: "short",
      language: "ar",
      knownNames: ["Sara", "  ", "Omar"],
      avoid: ["work"],
      updatedAt: "2026-11-09T10:00:00Z",
    });
    expect(rows).toEqual([
      { key: "tone", label: "Preferred tone", value: "Romantic" },
      { key: "captionLength", label: "Caption length", value: "Short" },
      { key: "language", label: "Caption language", value: "العربية", lang: "ar" },
      { key: "knownNames", label: "Names you use", values: ["Sara", "Omar"] },
      { key: "avoid", label: "Things to avoid", values: ["work"] },
    ]);
  });

  it("English language row and every tone have labels", () => {
    expect(memoryRows({ language: "en" })).toEqual([
      { key: "language", label: "Caption language", value: "English", lang: "en" },
    ]);
    for (const t of TONES) expect(memoryRows({ tone: t })[0]).toMatchObject({ key: "tone" });
  });

  it("skips unknown values and empty lists instead of showing raw data", () => {
    expect(memoryRows({ tone: "spooky", captionLength: "huge", language: "fr", knownNames: [], avoid: [] })).toEqual([]);
    expect(memoryRows({ knownNames: [""], avoid: undefined })).toEqual([]);
  });

  it("isMemoryViewEmpty", () => {
    expect(isMemoryViewEmpty(null)).toBe(true);
    expect(isMemoryViewEmpty(undefined)).toBe(true);
    expect(isMemoryViewEmpty({ knownNames: [], avoid: [], updatedAt: "2026-11-09T10:00:00Z" })).toBe(true);
    expect(isMemoryViewEmpty({ captionLength: "medium", knownNames: [], avoid: [] })).toBe(false);
    expect(isMemoryViewEmpty({ avoid: ["x"] })).toBe(false);
  });

  it("lastUpdatedLabel formats in the UAE calendar day and rejects bad input", () => {
    expect(lastUpdatedLabel("2026-11-09T10:00:00Z")).toBe("Last updated 9 Nov 2026");
    // 21:30 UTC = 01:30 next day in Abu Dhabi
    expect(lastUpdatedLabel("2026-11-09T21:30:00Z")).toBe("Last updated 10 Nov 2026");
    expect(lastUpdatedLabel("not a date")).toBeNull();
    expect(lastUpdatedLabel("")).toBeNull();
    expect(lastUpdatedLabel(null)).toBeNull();
  });

  it("clearOutcome maps action results to friendly copy", () => {
    expect(clearOutcome({ ok: true, cleared: true })).toEqual({ kind: "done" });
    expect(clearOutcome({ ok: true, cleared: false })).toEqual({ kind: "done" });
    const signedOut = clearOutcome({ ok: false, error: "signed_out" });
    expect(signedOut.kind).toBe("error");
    expect(signedOut.kind === "error" && signedOut.message).toMatch(/sign in/i);
    const failed = clearOutcome({ ok: false, error: "failed" });
    expect(failed.kind === "error" && failed.message).toMatch(/try again/i);
    expect(clearOutcome(null).kind).toBe("error");
  });

  it("copy matches the spec", () => {
    expect(SETTINGS_COPY.empty).toBe(
      "Nothing yet — we learn from your choices when you finish reviewing a book.",
    );
    expect(SETTINGS_COPY.privacy).toBe(
      "We only remember choices you made (tone, language, how long your captions are). We never store face data or guess who is in your photos.",
    );
    expect(SETTINGS_COPY.confirmQuestion).toBe("Clear what the AI learned?");
    expect(SETTINGS_COPY.fromMemory).toBe("From your last book");
  });
});

describe("new-book prefill from memory (D-032)", () => {
  it("defaults without memory: follow the occasion, English", () => {
    const s = newBookInitialState({});
    expect(s).toEqual({ manualTone: null, captionLang: "en" });
    expect(effectiveTone(s.manualTone, null)).toBe("minimal");
    expect(effectiveTone(s.manualTone, "wedding")).toBe("romantic");
    expect(effectiveTone(s.manualTone, "travel")).toBe("fun");
  });

  it("remembered tone is a manual choice, so picking an occasion does not overwrite it", () => {
    const s = newBookInitialState({ initialTone: "nostalgic", initialLang: "ar" });
    expect(s).toEqual({ manualTone: "nostalgic", captionLang: "ar" });
    expect(effectiveTone(s.manualTone, "wedding")).toBe("nostalgic");
    expect(effectiveTone(s.manualTone, null)).toBe("nostalgic");
    // The user can still change it.
    expect(effectiveTone("fun", "wedding")).toBe("fun");
  });

  it("ignores invalid prefill values", () => {
    expect(newBookInitialState({ initialTone: "spooky", initialLang: "fr" })).toEqual({
      manualTone: null,
      captionLang: "en",
    });
  });
});

describe("showFromMemoryHint", () => {
  const base = {
    fromMemory: true,
    rememberedTone: null,
    rememberedLang: null,
    occasion: null,
    tone: "minimal",
    captionLang: "en",
  } as const;

  it("never without memory", () => {
    expect(showFromMemoryHint({ ...base, fromMemory: false, rememberedTone: "fun", tone: "fun" })).toBe(false);
    expect(showFromMemoryHint({ ...base, fromMemory: false, rememberedLang: "ar", captionLang: "ar" })).toBe(false);
  });

  it("remembered tone that differs from the occasion default and is still selected", () => {
    expect(showFromMemoryHint({ ...base, rememberedTone: "fun", tone: "fun" })).toBe(true); // other → minimal
    expect(showFromMemoryHint({ ...base, rememberedTone: "fun", tone: "fun", occasion: "wedding" })).toBe(true);
    // user picked another tone → remembered value no longer selected
    expect(showFromMemoryHint({ ...base, rememberedTone: "fun", tone: "romantic", occasion: "wedding" })).toBe(false);
  });

  it("remembered tone equal to the default → no hint", () => {
    expect(showFromMemoryHint({ ...base, rememberedTone: "minimal", tone: "minimal" })).toBe(false); // no occasion
    expect(showFromMemoryHint({ ...base, rememberedTone: "fun", tone: "fun", occasion: "travel" })).toBe(false);
    expect(showFromMemoryHint({ ...base, rememberedTone: "romantic", tone: "romantic", occasion: "wedding" })).toBe(false);
    // the same remembered tone shows again when the occasion's default differs
    expect(showFromMemoryHint({ ...base, rememberedTone: "romantic", tone: "romantic", occasion: "family" })).toBe(true);
  });

  it("language: only a remembered non-English choice that is still selected", () => {
    expect(showFromMemoryHint({ ...base, rememberedLang: "en", captionLang: "en" })).toBe(false);
    expect(showFromMemoryHint({ ...base, rememberedLang: "ar", captionLang: "ar" })).toBe(true);
    expect(showFromMemoryHint({ ...base, rememberedLang: "ar", captionLang: "en" })).toBe(false);
    // default tone + Arabic → still a hint (language differs)
    expect(
      showFromMemoryHint({ ...base, rememberedTone: "minimal", tone: "minimal", rememberedLang: "ar", captionLang: "ar" }),
    ).toBe(true);
  });
});

describe("settings source guards", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("ui helpers stay client-safe (no lib/ai or lib/db imports)", () => {
    const src = read("src/lib/settings/ui.ts");
    expect(src).not.toMatch(/from\s+["']@\/lib\/(ai|db)(\/|["'])/);
  });

  it("NewBookForm uses its memory props (no unused-props escape hatch)", () => {
    const src = read("src/components/books/NewBookForm.tsx");
    expect(src).not.toContain("_props");
    expect(src).not.toContain("eslint-disable");
    expect(src).toContain('data-testid="new-book-from-memory"');
  });
});
