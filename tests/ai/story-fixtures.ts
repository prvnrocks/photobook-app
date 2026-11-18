// Shared fixture for the Task 6 story tests: one book with 24 photos in 6 stored moments, a memory
// context, an in-memory version store and a scripted "live" transport. No DB, no network.
import { vi } from "vitest";
import type { StoryAiConfig } from "@/lib/ai/story/config";
import { storyPlanReplaySynth, storyRewriteReplaySynth, storyWriteReplaySynth } from "@/lib/ai/story/replay";
import type { StoryBook, StoryDeps } from "@/lib/ai/story/service";
import type { AgentRequest, AgentResponse, AgentTransport } from "@/lib/ai/transport";
import type { OrganizePhotoRow, StoredMoment } from "@/lib/db/photo-organize";
import type { StoryCallRecord, StoryUsageCounts } from "@/lib/db/story-ai-calls";
import type { MemoryContext, Storybook } from "@/lib/storybook/types";

export const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const OTHER_BOOK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const CONFIG: StoryAiConfig = { model: "claude-opus-5-5", modelFallback: false, timeoutMs: 90_000, retries: 2 };
export const NOW = Date.parse("2026-11-18T10:00:00.000Z");

export const book = (over: Partial<StoryBook> = {}): StoryBook => ({ id: BOOK, title: null, occasion: "travel", caption_lang: "en", is_paid: false, format: "A5_PORTRAIT", design_style: "classic", ...over });

const SCENES = [
  { label: "Walking on a beach", description: "Two people walk along a beach near the water.", objects: ["beach", "sea"], activities: ["walking on a beach"], place: "Abu Dhabi" },
  { label: "People together", description: "A small group sits around a low table outdoors.", objects: ["table", "cushions"], activities: ["sitting together"], place: "Abu Dhabi" },
  { label: "Scenery", description: "Sand dunes stretch out under a clear sky.", objects: ["dunes", "sky"], activities: [], place: null },
  { label: "Food", description: "Plates of food are laid out on a long table.", objects: ["plates", "bread"], activities: ["sharing a meal"], place: null },
  { label: "Details", description: "A lantern hangs beside a carved wooden door.", objects: ["lantern", "door"], activities: [], place: null },
  { label: "Portraits", description: "A person stands on a rooftop looking at the view.", objects: ["rooftop", "railing"], activities: ["looking at a view"], place: null },
];

export function photoRows(count = 24, perMoment = 4): OrganizePhotoRow[] {
  return Array.from({ length: count }, (_, i) => {
    const scene = SCENES[Math.floor(i / perMoment) % SCENES.length]!;
    return {
      id: pid(i + 1),
      fingerprint: `s1:${String(i).padStart(16, "0")}`,
      phash: null,
      thumb_path: `${USER}/${BOOK}/IMG_${4000 + i}-thumb.jpg`,
      width: 4000,
      height: 3000,
      taken_at: new Date(Date.parse("2026-10-12T06:00:00Z") + Math.floor(i / perMoment) * 6 * 3600_000 + (i % perMoment) * 60_000).toISOString(),
      date_source: "exif",
      lat: null,
      lng: null,
      place: scene.place,
      blur_score: 120,
      ai: null,
      status: "kept",
    };
  });
}

export function visionRows(rows: OrganizePhotoRow[], perMoment = 4): Map<string, unknown> {
  return new Map(
    rows.map((r, i) => {
      const scene = SCENES[Math.floor(i / perMoment) % SCENES.length]!;
      return [
        r.id,
        { description: scene.description, scene: "landscape", objects: scene.objects, activities: scene.activities, peopleCount: 2, orientation: "landscape", storyRole: "establishing", atmosphere: { label: "calm", interpretation: true }, model: "claude-opus-5-5", promptVersion: "photo-insight-1" },
      ];
    }),
  );
}

export function storedMoments(rows: OrganizePhotoRow[], perMoment = 4): StoredMoment[] {
  const out: StoredMoment[] = [];
  for (let i = 0; i * perMoment < rows.length; i++) {
    const photos = rows.slice(i * perMoment, (i + 1) * perMoment);
    const scene = SCENES[i % SCENES.length]!;
    out.push({
      key: `m:${photos[0]!.id}`,
      position: i + 1,
      photoIds: photos.map((p) => p.id),
      label: scene.place ? `${scene.label} · ${scene.place}` : `${scene.label}${i >= SCENES.length ? ` again` : ""}`,
      labelSource: "auto",
      dateLabel: i < 4 ? "12 Oct 2026" : "13 Oct 2026",
      labelEvidence: [],
      heroPhotoId: photos[1]?.id ?? photos[0]!.id,
      heroSource: "auto",
      startsAt: photos[0]!.taken_at,
      endsAt: photos[photos.length - 1]!.taken_at,
      place: scene.place,
      confidence: 0.9,
      uncertain: false,
      uncertainReasons: [],
    });
  }
  return out;
}

export const memory = (over: Partial<MemoryContext> = {}): MemoryContext => ({
  v: 1,
  occasion: "travel",
  tone: "fun",
  lang: "en",
  storyTone: "heartfelt",
  answers: [{ questionId: "travel.companions", question: "Who did you travel with?", text: "My sister Sara and me", source: "user" }],
  skipped: false,
  note: null,
  people: [{ name: "Sara", relation: "my sister" }],
  places: ["Abu Dhabi"],
  facts: ["We drove along the coast road"],
  avoid: [],
  narrator: "first_plural",
  dateRange: null,
  rev: 3,
  updatedAt: "2026-11-17T09:00:00.000Z",
  ...over,
});

/** What the scripted transport answers for one call: a parsed value, a response patch, an Error, or a function of the request. */
export type Scripted = { parsed?: unknown; stopReason?: string | null; usage?: AgentResponse<unknown>["usage"]; model?: string } | Error | ((req: AgentRequest<unknown>, good: unknown) => unknown);

/** A grounded default answer, built like the replay synthesisers do (from scenarioMeta). */
export function goodAnswer(req: AgentRequest<unknown>): unknown {
  const ctx = { scenario: "ok" as const, request: req };
  const meta = req.scenarioMeta ?? {};
  if (req.agent === "storyteller") return storyPlanReplaySynth(meta, ctx);
  if (req.agent === "rewriter") return storyRewriteReplaySynth(meta, ctx);
  return storyWriteReplaySynth(meta, ctx);
}

export function world(over: Partial<StoryDeps> & { script?: Record<number, Scripted>; rows?: OrganizePhotoRow[]; perMoment?: number; context?: MemoryContext | null; theBook?: StoryBook; counts?: Partial<StoryUsageCounts>; moments?: StoredMoment[] } = {}) {
  const rows = over.rows ?? photoRows();
  const perMoment = over.perMoment ?? 4;
  const requests: AgentRequest<unknown>[] = [];
  const records: StoryCallRecord[] = [];
  const versions: Storybook[] = [];
  const script = over.script ?? {};
  const transport: AgentTransport = {
    kind: "live",
    async parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
      const index = requests.length;
      requests.push(req as AgentRequest<unknown>);
      const s = script[index];
      if (s instanceof Error) throw s;
      const good = goodAnswer(req as AgentRequest<unknown>);
      const patch = typeof s === "function" ? { parsed: s(req as AgentRequest<unknown>, good) } : (s ?? {});
      return {
        parsed: (patch.parsed === undefined ? good : patch.parsed) as T | null,
        stopReason: patch.stopReason === undefined ? "end_turn" : patch.stopReason,
        stopCategory: null,
        usage: patch.usage ?? { input: 1800, output: 600, cacheRead: 1500, cacheWrite: 0 },
        model: patch.model ?? req.model ?? "claude-opus-5-5",
        latencyMs: 2345,
      };
    },
  };
  const reads = { photos: vi.fn(async () => rows), vision: vi.fn(async () => visionRows(rows, perMoment)), moments: vi.fn(async () => over.moments ?? storedMoments(rows, perMoment)), dupes: vi.fn(async () => []), context: vi.fn(async () => (over.context === undefined ? memory() : over.context)) };
  let run = 0;
  const deps: StoryDeps = {
    ownerOf: async (id) => (id === BOOK ? { userId: USER, book: over.theBook ?? book() } : null),
    listPhotos: reads.photos,
    listVision: reads.vision,
    listMoments: reads.moments,
    listDuplicateGroups: reads.dupes,
    getContext: reads.context,
    getCurrent: vi.fn(async () => versions[versions.length - 1] ?? null),
    appendVersion: vi.fn(async (s: Storybook) => {
      if (s.version !== versions.length + 1) return "conflict" as const;
      versions.push(structuredClone(s));
      return "ok" as const;
    }),
    usageAvailable: async () => true,
    usageCounts: async () => ({ plans: 0, writes: 0, chapterRegens: 0, rewrites: 0, ...over.counts }),
    record: async (r) => void records.push(r),
    budgetExhausted: async () => false,
    mode: "live",
    transport,
    config: CONFIG,
    now: () => NOW,
    sleep: async () => {},
    newRunId: () => pid(900 + ++run),
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !["script", "rows", "perMoment", "context", "theBook", "counts", "moments"].includes(k))),
  };
  return { deps, requests, records, versions, reads, rows };
}

/** The user message of a request as one string. */
export const userText = (req: AgentRequest<unknown>) => req.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n"))).join("\n");
