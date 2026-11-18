// Opt-in integration test against the REAL model. Skipped unless STORY_AI_LIVE=1 (it costs a few
// cents: ONE plan call + ONE chapter write, plus at most one repair). The input is synthetic —
// six invented, neutral photo descriptions and two invented facts; no user data leaves the machine.
//
//   STORY_AI_LIVE=1 node --env-file=.env.local node_modules/.bin/vitest run tests/ai/story.live.test.ts
//
// Prints counts, cost and issue codes only — never the key or the generated text. (Written with
// process.stdout.write: this vitest setup hides console output of passing tests.)
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/books", () => ({}));
vi.mock("@/lib/auth/current-user", () => ({}));
vi.mock("@/lib/db/photo-analyses", () => ({}));
vi.mock("@/lib/db/photo-organize", () => ({}));
vi.mock("@/lib/db/story-ai-calls", () => ({}));
vi.mock("@/lib/db/storybooks", () => ({}));
vi.mock("@/lib/ai/budget", () => ({}));

import { readStoryAiConfig } from "@/lib/ai/story/config";
import { StoryPlanSchema } from "@/lib/ai/story/plan";
import { planStory, writeStory, type StoryDeps } from "@/lib/ai/story/service";
import { getTransport } from "@/lib/ai/transport-factory";
import type { OrganizePhotoRow } from "@/lib/db/photo-organize";
import type { StoryCallRecord } from "@/lib/db/story-ai-calls";
import { StorybookSchema } from "@/lib/storybook/schemas";
import type { Storybook } from "@/lib/storybook/types";

const LIVE = process.env.STORY_AI_LIVE === "1" && (process.env.ANTHROPIC_API_KEY ?? "").trim() !== "";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const say = (line: string) => void process.stdout.write(`${line}\n`);
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const DESCRIPTIONS = [
  ["A wooden rowing boat rests on a pebble shore beside calm water.", ["boat", "pebbles", "water"], []],
  ["Two people carry a picnic basket along a path through tall grass.", ["basket", "path", "grass"], ["carrying a basket"]],
  ["A checked blanket is spread on the grass with bread, fruit and cups.", ["blanket", "bread", "fruit", "cups"], []],
  ["Two people sit on a blanket and pour a drink from a flask.", ["blanket", "flask", "cups"], ["pouring a drink"]],
  ["A kite flies above a grassy hill under scattered clouds.", ["kite", "hill", "clouds"], ["flying a kite"]],
  ["The sun sits low over the water behind an empty rowing boat.", ["boat", "water", "sun"], []],
] as const;

describe.skipIf(!LIVE)("story planner + narrative writer — live model (opt-in)", () => {
  it("plans a 6-photo book and writes its chapter: grounded blocks only, usage and cost recorded", async () => {
    const rows: OrganizePhotoRow[] = DESCRIPTIONS.map((_, i) => ({
      id: pid(i + 1),
      fingerprint: `s1:${i}`,
      phash: null,
      thumb_path: null,
      width: 4000,
      height: 3000,
      taken_at: new Date(Date.parse("2026-05-02T08:00:00Z") + i * 20 * 60_000).toISOString(),
      date_source: "exif",
      lat: null,
      lng: null,
      place: null,
      blur_score: 100,
      ai: null,
      status: "kept",
    }));
    const vision = new Map<string, unknown>(
      DESCRIPTIONS.map(([description, objects, activities], i) => [
        pid(i + 1),
        { description, scene: "landscape", objects: [...objects], activities: [...activities], peopleCount: activities.length ? 2 : 0, orientation: "landscape", storyRole: i === 0 ? "establishing" : i === 5 ? "closing" : "action", atmosphere: { label: "calm", interpretation: true }, model: "claude-opus-5-5", promptVersion: "photo-insight-1" },
      ]),
    );
    const records: StoryCallRecord[] = [];
    const versions: Storybook[] = [];
    const deps: StoryDeps = {
      ownerOf: async () => ({ userId: USER, book: { id: BOOK, title: null, occasion: "other", caption_lang: "en", is_paid: false, format: "A5_PORTRAIT", design_style: "classic" } }),
      listPhotos: async () => rows,
      listVision: async () => vision,
      listMoments: async () => [],
      listDuplicateGroups: async () => [],
      getContext: async () => ({
        v: 1,
        occasion: "other",
        tone: "minimal",
        lang: "en",
        storyTone: "elegant",
        answers: [],
        skipped: false,
        note: null,
        people: [],
        places: [],
        facts: ["We rowed across the lake for a picnic", "It was the first warm weekend"],
        avoid: [],
        narrator: "first_plural",
        dateRange: null,
        rev: 1,
        updatedAt: "2026-11-18T09:00:00.000Z",
      }),
      getCurrent: async () => versions[versions.length - 1] ?? null,
      appendVersion: async (s) => (versions.push(s), "ok"),
      usageAvailable: async () => true,
      usageCounts: async () => ({ plans: 0, writes: 0, chapterRegens: 0, rewrites: 0 }),
      record: async (r) => void records.push(r),
      budgetExhausted: async () => false,
      mode: "live",
      transport: getTransport("live"),
      config: { ...readStoryAiConfig(), retries: 0 },
    };

    const plan = await planStory(BOOK, deps);
    const planCost = records.reduce((s, r) => s + r.costUsd, 0);
    say(`[live] plan source=${plan.source} reason=${plan.fallbackReason} chapters=${plan.chapters.length} pages=${plan.skeleton.pages.length} calls=${records.length} usd=${planCost.toFixed(4)} statuses=${records.map((r) => r.status + (r.status === "error" ? `:${r.error}` : "")).join(",")}`);
    expect(StoryPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.source).toBe("ai");
    expect(plan.chapters).toHaveLength(1); // fewer than 10 photos → one chapter
    expect(plan.closing).toBe(false);

    const before = records.length;
    const result = await writeStory(BOOK, plan, {}, deps);
    const writeRecords = records.slice(before);
    const total = records.reduce((s, r) => s + r.costUsd, 0);
    const blocks = result.storybook.pages.flatMap((p) => p.blocks);
    say(
      `[live] write calls=${writeRecords.length} kinds=${writeRecords.map((r) => r.kind).join(",")} planned=${plan.skeleton.pages.flatMap((p) => p.blocks).length} stored=${blocks.length} factRefs=${blocks.reduce((s, b) => s + (b.factRefs?.length ?? 0), 0)} issues=${result.issues.map((i) => `${i.blockId}:${i.code}${i.detail ? `/${i.detail}` : ""}`).join(",") || "none"} narrative=${result.balance.narrativeShare} in=${records.reduce((s, r) => s + r.usage.input, 0)} out=${records.reduce((s, r) => s + r.usage.output, 0)} cacheRead=${records.reduce((s, r) => s + r.usage.cacheRead, 0)} usd=${total.toFixed(4)}`,
    );
    expect(StorybookSchema.safeParse(result.storybook).success).toBe(true);
    expect(writeRecords.length).toBeGreaterThanOrEqual(1);
    expect(writeRecords.length).toBeLessThanOrEqual(2);
    expect(writeRecords[0]).toMatchObject({ kind: "write", scope: "book", chapterId: "c1", status: "ok" });
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b.groundedIn.length).toBeGreaterThan(0);
    for (const r of records) expect(r.usage.output).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(0.3);
  }, 300_000);
});
