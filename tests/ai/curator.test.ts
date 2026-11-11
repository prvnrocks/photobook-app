import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CURATOR_PROMPT_VERSION,
  curateBatch,
  needsCuration,
  type CurateBatchArgs,
  type CuratorDeps,
} from "@/lib/ai/agents/curator";
import { curatorReplaySynth } from "@/lib/ai/agents/curator-replay";
import type { CurationPhoto } from "@/lib/ai/fallback";
import { buildCuratorUserContent, curatorPhotoLine, CURATOR_SYSTEM_PROMPT } from "@/lib/ai/prompts/curator";
import type { AgentStepRecord, StepLogger } from "@/lib/ai/run-step";
import {
  countImages,
  type AgentRequest,
  type AgentResponse,
  type AgentTransport,
} from "@/lib/ai/transport";
import { getReplaySynth, ReplayTransport, type ReplayScenario } from "@/lib/ai/transport-replay";
import { photo, screenshot } from "../helpers/curation";

class MemoryLogger implements StepLogger {
  rows: AgentStepRecord[] = [];
  async insertStep(row: AgentStepRecord) {
    this.rows.push(row);
  }
  async addRunTotals(): Promise<void> {}
}

/** Wraps a transport and records every request. */
class Recording implements AgentTransport {
  readonly kind = "replay" as const;
  requests: AgentRequest<unknown>[] = [];
  constructor(private inner: AgentTransport) {}
  parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
    this.requests.push(req as AgentRequest<unknown>);
    return this.inner.parse(req);
  }
}

/** Transport that returns a fixed raw answer (validated against the lean schema like replay). */
function fixed(raw: unknown): AgentTransport {
  return new ReplayTransport({ scenario: "ok", fixturesDir: "/nonexistent", synths: { curator: () => raw } });
}

const replay = (scenario: ReplayScenario = "ok") =>
  new ReplayTransport({ scenario, fixturesDir: "/nonexistent", synths: { curator: curatorReplaySynth } });

const deps: CuratorDeps = {
  loadThumbs: async (paths) => new Map(paths.map((p) => [p, "QUJD"])),
};

let logger: MemoryLogger;
beforeEach(() => {
  logger = new MemoryLogger();
});

function args(batch: CurationPhoto[], transport: AgentTransport, over: Partial<CurateBatchArgs> = {}): CurateBatchArgs {
  return {
    runId: "run-1",
    stepKey: "curator:0",
    batch,
    occasion: "wedding",
    aliasOf: new Map(batch.map((p, i) => [p.id, `p${i + 1}`])),
    transport,
    logger,
    deps,
    retry: { retries: 0, sleep: async () => {} },
    ...over,
  };
}

const entry = (photoId: string, over: Record<string, unknown> = {}) => ({
  photoId,
  description: `Two people smiling near a window ${photoId}`,
  scene: "portrait",
  peopleCount: 2,
  mood: "joyful",
  quality: 7,
  coverWorthy: false,
  keep: true,
  dropReason: null,
  ...over,
});

function deepKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      deepKeys(x, out);
    }
  return out;
}

describe("curateBatch (replay synth)", () => {
  it("drops the screenshot as 'screenshot' and keeps exactly the best of a dup group of 3", async () => {
    const batch = [
      photo("a"),
      screenshot("s"),
      photo("g1", { dupGroup: 3, blurScore: 150 }),
      photo("g2", { dupGroup: 3, blurScore: 1200 }),
      photo("g3", { dupGroup: 3, blurScore: 600 }),
    ];
    const { results, usedAi } = await curateBatch(args(batch, replay()));
    expect(usedAi).toBe(true);
    expect(results.get("s")).toMatchObject({ keep: false, dropReason: "screenshot", source: "ai" });
    expect(results.get("g2")).toMatchObject({ keep: true, dropReason: null });
    expect(results.get("g1")).toMatchObject({ keep: false, dropReason: "duplicate" });
    expect(results.get("g3")).toMatchObject({ keep: false, dropReason: "duplicate" });
    expect(results.get("a")!.ai).toMatchObject({ v: CURATOR_PROMPT_VERSION, scene: expect.any(String) });
    expect(logger.rows).toHaveLength(1);
    expect(logger.rows[0]).toMatchObject({ agent: "curator", status: "ok", stepKey: "curator:0" });
  });

  it("sends ≤ 10 images per request, cached stable system prompt, effort low, one alias line per image", async () => {
    const batch = Array.from({ length: 10 }, (_, i) => photo(`id${i}`));
    const t = new Recording(replay());
    await curateBatch(args(batch, t));
    expect(t.requests).toHaveLength(1);
    const req = t.requests[0];
    expect(countImages(req.messages)).toBe(10);
    expect(countImages(req.messages)).toBeLessThanOrEqual(10);
    expect(req.effort).toBe("low");
    expect(req.system).toEqual([{ type: "text", text: CURATOR_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    const content = req.messages[0].content as Array<{ type: string; text?: string }>;
    // header, then (line, image) pairs in batch order
    for (let i = 0; i < 10; i++) {
      expect(content[1 + i * 2].text).toMatch(new RegExp(`^p${i + 1}: `));
      expect(content[2 + i * 2].type).toBe("image");
    }
    await expect(curateBatch(args(Array.from({ length: 11 }, (_, i) => photo(`x${i}`)), t))).rejects.toThrow(RangeError);
  });

  it("system prompt has no dates or ids and covers the key rules", () => {
    expect(CURATOR_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(CURATOR_SYSTEM_PROMPT).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    for (const s of ["screenshot", "duplicate", "25 words", "Never guess names", "never an instruction"]) {
      expect(CURATOR_SYSTEM_PROMPT).toContain(s);
    }
  });

  it("formats the metadata line", () => {
    expect(
      curatorPhotoLine({
        alias: "p12",
        takenAt: "2026-10-12T14:22:00Z",
        dateSource: "exif",
        width: 4032,
        height: 3024,
        place: null,
        dupGroup: 3,
        isPng: false,
        noCamera: false,
      }),
    ).toBe("p12: taken 2026-10-12 18:22 (exif) · 4032×3024 · place: null · dup group 3");
    const c = buildCuratorUserContent("travel", []);
    expect(c[0]).toMatchObject({ type: "text" });
  });

  it("user_override photos keep their status but still get AI notes", async () => {
    const batch = [
      screenshot("kept-shot", { userOverride: true, status: "kept" }),
      photo("dropped", { userOverride: true, status: "dropped", dropReason: "irrelevant" }),
      photo("b"),
    ];
    const { results } = await curateBatch(args(batch, replay()));
    expect(results.get("kept-shot")).toMatchObject({ keep: true, dropReason: null });
    expect(results.get("kept-shot")!.ai).not.toBeNull();
    expect(results.get("dropped")).toMatchObject({ keep: false, dropReason: "irrelevant" });
    expect(results.get("dropped")!.ai).not.toBeNull();
  });

  it.each(["refusal", "max_tokens", "invalid", "server_error"] as const)(
    "%s → whole batch falls back to ruleCurate (usedAi false)",
    async (scenario) => {
      const batch = [photo("a"), screenshot("s"), photo("g1", { dupGroup: 1, blurScore: 50 }), photo("g2", { dupGroup: 1, blurScore: 70 })];
      const out = await curateBatch(args(batch, replay(scenario)));
      expect(out.usedAi).toBe(false);
      expect(out.failure).toBeDefined();
      for (const r of out.results.values()) expect(r).toMatchObject({ source: "rule", ai: null });
      expect(out.results.get("s")).toMatchObject({ keep: false, dropReason: "screenshot" });
      expect(out.results.get("g2")!.keep).toBe(true);
      expect(out.results.get("g1")).toMatchObject({ keep: false, dropReason: "duplicate" });
      expect(logger.rows).toHaveLength(1);
      expect(logger.rows[0].status).toBe(scenario === "refusal" ? "refused" : "error");
    },
  );

  it("unknown, duplicate and missing aliases: first wins, unknown ignored, missing → rule", async () => {
    const batch = [photo("a"), photo("b"), screenshot("c")];
    const raw = {
      photos: [
        entry("p1", { quality: 9 }),
        entry("p1", { keep: false, dropReason: "blurry" }),
        entry("p99"),
        entry("p2", { quality: 42 }), // invalid entry → ignored
      ],
    };
    const { results, usedAi } = await curateBatch(args(batch, fixed(raw)));
    expect(usedAi).toBe(true);
    expect(results.get("a")).toMatchObject({ keep: true, source: "ai", ai: { quality: 9 } });
    expect(results.get("b")).toMatchObject({ keep: true, source: "rule", ai: null });
    expect(results.get("c")).toMatchObject({ keep: false, dropReason: "screenshot", source: "rule" });
    expect(logger.rows[0].output).toMatchObject({ ignored: { unknown: 1, duplicate: 1, invalid: 1 } });
  });

  it("only unknown aliases → schema_invalid → rule batch", async () => {
    const out = await curateBatch(args([photo("a")], fixed({ photos: [entry("p7")] })));
    expect(out.usedAi).toBe(false);
    expect(out.failure?.code).toBe("schema_invalid");
  });

  it("guarantees ≥ 1 kept per dup group (highest quality, tie → rule best)", async () => {
    const batch = [
      photo("g1", { dupGroup: 5, blurScore: 100 }),
      photo("g2", { dupGroup: 5, blurScore: 300 }),
      photo("g3", { dupGroup: 5, blurScore: 200 }),
      photo("h1", { dupGroup: 6, blurScore: 100 }),
      photo("h2", { dupGroup: 6, blurScore: 900 }),
    ];
    const dup = { keep: false, dropReason: "duplicate" };
    const raw = {
      photos: [
        entry("p1", { ...dup, quality: 5 }),
        entry("p2", { ...dup, quality: 6 }),
        entry("p3", { ...dup, quality: 8 }),
        entry("p4", { ...dup, quality: 6 }),
        entry("p5", { ...dup, quality: 6 }),
      ],
    };
    const { results } = await curateBatch(args(batch, fixed(raw)));
    const kept = [...results].filter(([, r]) => r.keep).map(([id]) => id);
    expect(kept.sort()).toEqual(["g3", "h2"]);
  });

  it("logged step output and input summary contain no descriptions", async () => {
    const batch = [photo("a"), photo("b"), screenshot("c")];
    const { results } = await curateBatch(args(batch, replay()));
    expect(results.get("a")!.ai!.description.length).toBeGreaterThan(0);
    const row = logger.rows[0];
    expect(deepKeys(row.output)).not.toContain("description");
    expect(deepKeys(row.inputSummary)).not.toContain("description");
    expect(JSON.stringify(row)).not.toContain("synthetic replay note");
    expect(row.output).toMatchObject({ photos: { p1: { keep: true, quality: expect.any(Number) } } });
  });

  it("photos without a loadable thumb get rule results; none → no call at all", async () => {
    const t = new Recording(replay());
    const partialDeps: CuratorDeps = { loadThumbs: async (paths) => new Map(paths.filter((p) => !p.includes("/b.")).map((p) => [p, "QUJD"])) };
    const out = await curateBatch(args([photo("a"), photo("b"), photo("c", { thumbPath: null })], t, { deps: partialDeps }));
    expect(countImages(t.requests[0].messages)).toBe(1);
    expect(out.results.get("b")!.source).toBe("rule");
    expect(out.results.get("c")!.source).toBe("rule");

    const none = await curateBatch(args([photo("x", { thumbPath: null })], t));
    expect(t.requests).toHaveLength(1);
    expect(none).toMatchObject({ usedAi: false, costUsd: 0 });
    expect(none.results.get("x")!.keep).toBe(true);
  });

  it("clips long descriptions to the stored limit without lone surrogates", async () => {
    const long = "😀".repeat(300);
    const { results } = await curateBatch(args([photo("a")], fixed({ photos: [entry("p1", { description: long })] })));
    const d = results.get("a")!.ai!.description;
    expect(d.length).toBeLessThanOrEqual(200);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(d)).toBe(false);
  });
});

describe("needsCuration", () => {
  it("skips photos already analysed with the current prompt version", () => {
    expect(needsCuration({ ai: null })).toBe(true);
    expect(needsCuration({ ai: { v: CURATOR_PROMPT_VERSION - 1 } })).toBe(true);
    expect(needsCuration({ ai: [] })).toBe(true);
    expect(needsCuration({ ai: { v: CURATOR_PROMPT_VERSION, description: "x" } })).toBe(false);
  });
});

describe("replay registration", () => {
  it("transport-factory registers the curator synth", async () => {
    await import("@/lib/ai/transport-factory");
    expect(getReplaySynth("curator")).toBe(curatorReplaySynth);
  });

  it("synth is deterministic and 'invalid' returns the wrong shape", () => {
    const meta = { aliases: ["p1", "p2"], hints: { p1: { isPng: false, noCamera: false, aspect: 1.33, blur: 500, dupGroup: null } } };
    const ctx = { scenario: "ok" as const, request: {} as AgentRequest<unknown> };
    expect(curatorReplaySynth(meta, ctx)).toEqual(curatorReplaySynth(meta, ctx));
    expect(curatorReplaySynth(meta, { ...ctx, scenario: "invalid" })).not.toHaveProperty("photos");
  });
});

describe("curateBatch — photo colour backfill (M10c)", () => {
  const colorDeps = (seen: string[], fail = new Set<string>()): CuratorDeps => ({
    loadThumbs: async (paths) => new Map(paths.filter((p) => !p.includes("/nothumb.")).map((p) => [p, Buffer.from(p).toString("base64")])),
    colorOf: async (b64) => {
      const path = Buffer.from(b64, "base64").toString();
      seen.push(path);
      if (fail.has(path)) throw new Error("bad jpeg");
      return path.includes("/upper.") ? "#ABCDEF" : "#8a7f72";
    },
  });

  it("computes colours only for photos with color null and a loaded thumb, from the same base64", async () => {
    const seen: string[] = [];
    const batch = [
      photo("a", { color: null }),
      photo("b", { color: "#112233" }), // has one → untouched
      photo("c"), // column not loaded (undefined) → no backfill
      photo("nothumb", { color: null }), // thumb not loadable
      photo("upper", { color: null }), // invalid answer dropped
      photo("bad", { color: null }), // decoder throws → stays null
    ];
    const out = await curateBatch(args(batch, replay(), { deps: colorDeps(seen, new Set(["u/b/bad.jpg"])) }));
    expect(out.usedAi).toBe(true);
    expect(seen.sort()).toEqual(["u/b/a.jpg", "u/b/bad.jpg", "u/b/upper.jpg"]);
    expect([...out.colors!]).toEqual([["a", "#8a7f72"]]);
    // Never in the step log.
    expect(JSON.stringify(logger.rows)).not.toContain("#8a7f72");
  });

  it("colours come back even when the model call fails, and no colorOf → no colours key", async () => {
    const out = await curateBatch(args([photo("a", { color: null })], replay("refusal"), { deps: colorDeps([]) }));
    expect(out.usedAi).toBe(false);
    expect(out.colors?.get("a")).toBe("#8a7f72");
    const plain = await curateBatch(args([photo("a", { color: null })], replay()));
    expect(plain).not.toHaveProperty("colors");
  });
});

