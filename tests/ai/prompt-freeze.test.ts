// M30 T10/T11 freeze: the cached system prompts and the output-format JSON schemas used by the
// four pre-M30 styles (classic, modern, geometric, scrapbook × A5 portrait / landscape) must stay
// BYTE-IDENTICAL while the magazine / editorial variants are added next to them (one prompt-cache
// prefix per text; a changed byte re-bills every cache write and can change model behaviour).
//
// Hashes were recorded at commit a723a4a (before any M30 AI change). If a hash changes on purpose,
// bump that agent's prompt version, say so in docs/AI-AGENTS.md and re-record with
//   PROMPT_FREEZE_PRINT=/absolute/path/hashes.txt npx vitest run tests/ai/prompt-freeze.test.ts
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import type { BookDesign } from "@/lib/book/book-design";
import { CAPTION_WRITER_SYSTEM_PROMPT, captionWriterSystem } from "@/lib/ai/prompts/caption-writer";
import { criticSystem, criticSystemText } from "@/lib/ai/prompts/critic";
import { REWRITER_SYSTEM_PROMPT, rewriterSystem } from "@/lib/ai/prompts/rewriter";
import { storytellerSystem, storytellerSystemText } from "@/lib/ai/prompts/storyteller";
import * as StoryPrompts from "@/lib/ai/story/prompts";
import {
  albumPlanAiSchemaFor,
  AlbumPlanAiSchema,
  AlbumPlanBackgroundsAiSchema,
  AlbumPlanScrapbookAiSchema,
  CaptionBatchAiSchema,
  CritiqueAiSchema,
  CuratorBatchAiSchema,
  RewriteOutputAiSchema,
} from "@/lib/ai/schemas";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** The JSON schema exactly as the live transport sends it (transport-live lenientOutputFormat). */
const schemaJson = (schema: Parameters<typeof zodOutputFormat>[0]) => JSON.stringify(zodOutputFormat(schema).schema);

const STYLES = ["classic", "modern", "geometric", "scrapbook"] as const;
const FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const;
const DESIGNS: BookDesign[] = STYLES.flatMap((designStyle) => FORMATS.map((format) => ({ format, designStyle })));
const nameOf = (d: BookDesign) => `${d.designStyle}/${d.format}`;

const STORYTELLER_SYSTEM: Record<string, string> = {
  "classic/A5_PORTRAIT": "2285d06a84f98af01be04669daa5ebd8e2d72d484e3129c134dac768e7d141f8",
  "classic/A5_LANDSCAPE": "afe158157e00304c8e8a6dc6a5fb2a205b6fa3abb03577a3069c9d1c9fdfba9d",
  "modern/A5_PORTRAIT": "6429f7681dc3653ed997df28487ddea8bb474f47b732b54ce3e92b0a7956ff7e",
  "modern/A5_LANDSCAPE": "0c3d3ffcc280c63070e66b5b16dddf14a396842789784fd050b851ff45fa62cf",
  "geometric/A5_PORTRAIT": "8f6bbd69eaac180e5710f0be1ecb096d2fb419ecbd521b41949fedb65ccf7e5b",
  "geometric/A5_LANDSCAPE": "9a5de067d4d9ce514a36d0b15cd8f769243cd1da9f489b0e1701cda839957b4e",
  "scrapbook/A5_PORTRAIT": "c5e11c222c1093460528c8ac820cfdbc32df2d13ab0074119672acbb6d537ca5",
  "scrapbook/A5_LANDSCAPE": "d92b6f36d08720bd78f2ced3f2ebcdf14f0ddd9b6ad896dc8cd19c8a80fe9853",
};

const BASE_SYSTEM: Record<string, string> = {
  caption_writer: "c2fa95d4b7a789ac21157eb638f797945fd025c4f10f5c0e98cebe1e1ea3a2f0",
  critic: "47759ee0101e1c921c2ca36e9a0abe70b46afa299127e27bedf9e18fc64e7b4c",
  rewriter: "b9fea9913d64a91fc51b8a8b477f6ad2c918062cf1feffb8e7cf5c4b18fb6e13",
};

const BASE_SCHEMAS: Record<string, string> = {
  curator_batch: "74092b0d56fc35492145a36299ffc9612842434b54d39ef58ee5473918918a8e",
  album_plan_classic: "c1755fc2d7d741efd625bcc26440c6249a3ebd1d1f52db83f6aab574de5169ae",
  album_plan_backgrounds: "1cfd78b9f08703bd268286a8802504a40cafc97feae5afffd0fc22131d87b88d",
  album_plan_scrapbook: "97e84bd9aa4de2e328599fce8fa64691b06eb54bbf82c145332f1d8c564a427b",
  caption_batch: "3cd442241b8a54aaf736d47dace18a72aadffc9e2ff30edd4bbe0f86a963d4e5",
  critique: "cda0d2500509fb40d2297b5c9b9fa8a817622cd78720d91a341a99fd5a4815d0",
  rewrite_output: "af5fd9efb956ddc93e283e6b1c90e9e2fb101523b51bab20fdcacab26ebb838c",
};

const baseSystemTexts = (): Record<string, string> => ({
  caption_writer: CAPTION_WRITER_SYSTEM_PROMPT,
  critic: criticSystemText(),
  rewriter: REWRITER_SYSTEM_PROMPT,
});

const baseSchemas = (): Record<string, string> => ({
  curator_batch: schemaJson(CuratorBatchAiSchema),
  album_plan_classic: schemaJson(AlbumPlanAiSchema),
  album_plan_backgrounds: schemaJson(AlbumPlanBackgroundsAiSchema),
  album_plan_scrapbook: schemaJson(AlbumPlanScrapbookAiSchema),
  caption_batch: schemaJson(CaptionBatchAiSchema),
  critique: schemaJson(CritiqueAiSchema),
  rewrite_output: schemaJson(RewriteOutputAiSchema),
});

describe("prompt + schema freeze (pre-M30 styles)", () => {
  if (process.env.PROMPT_FREEZE_PRINT) {
    it("prints the current hashes", () => {
      const lines = [
        ...DESIGNS.map((d) => `storyteller ${nameOf(d)} ${sha(storytellerSystemText(d))}`),
        ...Object.entries(baseSystemTexts()).map(([k, v]) => `system ${k} ${sha(v)}`),
        ...Object.entries(baseSchemas()).map(([k, v]) => `schema ${k} ${sha(v)}`),
      ];
      writeFileSync(process.env.PROMPT_FREEZE_PRINT as string, `${lines.join("\n")}\n`);
    });
    return;
  }

  it.each(DESIGNS.map((d) => [nameOf(d), d] as const))("Storyteller system text of %s is unchanged", (name, design) => {
    expect(sha(storytellerSystemText(design))).toBe(STORYTELLER_SYSTEM[name]);
    // What is sent = one cached block holding exactly that text.
    const blocks = storytellerSystem(design);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(storytellerSystemText(design));
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("covers every pre-M30 design exactly once", () => {
    expect(Object.keys(STORYTELLER_SYSTEM).sort()).toEqual(DESIGNS.map(nameOf).sort());
  });

  it.each(Object.keys(BASE_SYSTEM))("base %s system prompt is unchanged", (agent) => {
    expect(sha(baseSystemTexts()[agent])).toBe(BASE_SYSTEM[agent]);
  });

  it("the base system blocks carry exactly the frozen texts", () => {
    expect(captionWriterSystem().map((b) => b.text)).toEqual([CAPTION_WRITER_SYSTEM_PROMPT]);
    expect(criticSystem().map((b) => b.text)).toEqual([criticSystemText()]);
    expect(rewriterSystem().map((b) => b.text)).toEqual([REWRITER_SYSTEM_PROMPT]);
  });

  it.each(Object.keys(BASE_SCHEMAS))("base output schema %s is unchanged", (name) => {
    expect(sha(baseSchemas()[name])).toBe(BASE_SCHEMAS[name]);
  });

  it("the pre-M30 styles keep their plan schema objects", () => {
    expect(albumPlanAiSchemaFor("classic")).toBe(AlbumPlanAiSchema);
    expect(albumPlanAiSchemaFor("modern")).toBe(AlbumPlanBackgroundsAiSchema);
    expect(albumPlanAiSchemaFor("geometric")).toBe(AlbumPlanBackgroundsAiSchema);
    expect(albumPlanAiSchemaFor("scrapbook")).toBe(AlbumPlanScrapbookAiSchema);
  });
});

// Storybook prompts (Task 6 → v2, 2026-11-19): the planner / writer / rewriter system texts and
// their output schemas are frozen too. v1 → v2 was an intended change (narrative instead of
// inventories, no inferred gender, light framing) with the versions bumped to story-plan-2 /
// story-write-2 / story-rewrite-2 so stored versions, story_ai_calls rows and replays never mix.
// A new change: bump the version constant in src/lib/ai/story/prompts.ts and re-record these.
const STORY_PROMPTS: Record<string, { version: string; system: string; schema: string }> = {
  planner: { version: "story-plan-2", system: "af2ac47f220b750b3c66f3d00c590ff7021e0a6b44cb1e996e2872cac3c6525d", schema: "00efab4b3f1dd47f287454a46fd485f1814a471005014146f8ebd09364d4584a" },
  writer: { version: "story-write-2", system: "1c027a463593aa4451d4addb9852522547321a2f8b5c4debf1ea4ea2529af47f", schema: "c7233b3f34b51e8eda3a82fbe70a8bcdede446ba6bc817fd0ac7387636782eac" },
  rewriter: { version: "story-rewrite-2", system: "2a5540298905955d8c21b935265b29a0c10badeb74f0e88ec5731d530dd01c6a", schema: "d77f0265b840e30177fafcdd4a3ad0a714f00aa9b4c5766a9a9fcd920e6b5f33" },
};

describe("storybook prompt freeze (v2)", () => {
  const current = {
    planner: { version: StoryPrompts.STORY_PLANNER_PROMPT_VERSION, system: StoryPrompts.STORY_PLANNER_SYSTEM_PROMPT, schema: schemaJson(StoryPrompts.StoryPlanAiSchema) },
    writer: { version: StoryPrompts.STORY_WRITER_PROMPT_VERSION, system: StoryPrompts.STORY_WRITER_SYSTEM_PROMPT, schema: schemaJson(StoryPrompts.StoryBlocksAiSchema) },
    rewriter: { version: StoryPrompts.STORY_REWRITER_PROMPT_VERSION, system: StoryPrompts.STORY_REWRITER_SYSTEM_PROMPT, schema: schemaJson(StoryPrompts.StoryRewriteAiSchema) },
  } as const;
  it.each(Object.keys(STORY_PROMPTS) as (keyof typeof current)[])("%s: version, system text and schema are the recorded v2", (agent) => {
    expect(current[agent].version).toBe(STORY_PROMPTS[agent]!.version);
    expect(sha(current[agent].system)).toBe(STORY_PROMPTS[agent]!.system);
    expect(sha(current[agent].schema)).toBe(STORY_PROMPTS[agent]!.schema);
  });
  it("the v2 texts carry the narrative rules (one anchor, no inferred gender, light framing) and keep the hard source rules", () => {
    const w = current.writer.system;
    expect(w).toContain("ONE ANCHOR");
    expect(w).toContain("Never infer anyone's gender");
    expect(w).toContain("light narrative framing");
    expect(w).toContain("A person may be named only when the name appears in a FACT");
    expect(w).toContain("Never write dialogue or quotation marks");
    expect(w).not.toContain("Concrete over general");
  });
});
