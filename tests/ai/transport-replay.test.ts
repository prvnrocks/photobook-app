import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CuratorBatchAiSchema, type CuratorBatchAi } from "@/lib/ai/schemas";
import { cachedSystem, type AgentRequest } from "@/lib/ai/transport";
import {
  clearReplaySynths,
  parseScenarioEnv,
  registerReplaySynth,
  ReplayTransport,
} from "@/lib/ai/transport-replay";

const SYSTEM = "Stable curator prompt. ".repeat(120); // ~690 tokens → cacheable

const req = (meta: Record<string, unknown> = { aliases: ["p1", "p2"] }): AgentRequest<CuratorBatchAi> => ({
  agent: "curator",
  system: cachedSystem(SYSTEM),
  messages: [{ role: "user", content: [{ type: "text", text: "Analyse p1, p2" }] }],
  schema: CuratorBatchAiSchema,
  effort: "low",
  maxTokens: 3000,
  scenarioMeta: meta,
});

const synth = (meta: Record<string, unknown>) => ({
  photos: (meta.aliases as string[]).map((photoId) => ({
    photoId,
    description: "replay",
    scene: "other",
    peopleCount: 0,
    mood: "neutral",
    quality: 6,
    coverWorthy: false,
    keep: true,
    dropReason: null,
  })),
});

const emptyDir = () => mkdtempSync(join(tmpdir(), "replay-fixtures-"));

afterEach(() => {
  clearReplaySynths();
  vi.unstubAllEnvs();
});

describe("ReplayTransport", () => {
  it("synthesises from scenarioMeta via the registry", async () => {
    registerReplaySynth("curator", synth);
    const t = new ReplayTransport({ scenario: "ok", fixturesDir: emptyDir() });
    const r = await t.parse(req({ aliases: ["p7", "p8", "p9"] }));
    expect(r.stopReason).toBe("end_turn");
    expect(r.parsed?.photos.map((p) => p.photoId)).toEqual(["p7", "p8", "p9"]);
    expect(r.model).toBe("claude-opus-5-5");
  });

  it("is deterministic and reports cache write then cache read for an identical system prompt", async () => {
    const t = new ReplayTransport({ scenario: "ok", fixturesDir: emptyDir(), synths: { curator: synth } });
    const a = await t.parse(req());
    const b = await t.parse(req());
    expect(a.parsed).toEqual(b.parsed);
    expect(a.usage.cacheWrite).toBeGreaterThan(511);
    expect(a.usage.cacheRead).toBe(0);
    expect(b.usage.cacheRead).toBe(a.usage.cacheWrite);
    expect(b.usage.cacheWrite).toBe(0);
    expect(a.usage.output).toBeGreaterThan(0);
  });

  it("does not cache prefixes under 512 tokens", async () => {
    const t = new ReplayTransport({ scenario: "ok", fixturesDir: emptyDir(), synths: { curator: synth } });
    const small = { ...req(), system: cachedSystem("short") };
    await t.parse(small);
    const r = await t.parse(small);
    expect(r.usage.cacheRead + r.usage.cacheWrite).toBe(0);
  });

  it("prefers a named fixture, then a generic fixture, over the synthesiser", async () => {
    const dir = emptyDir();
    const fx = (id: string) => ({ parsed: synth({ aliases: [id] }), usage: { output: 77 } });
    writeFileSync(join(dir, "curator.ok.json"), JSON.stringify(fx("p50")));
    writeFileSync(join(dir, "curator.batch2.ok.json"), JSON.stringify(fx("p60")));
    const t = new ReplayTransport({ scenario: "ok", fixturesDir: dir, synths: { curator: synth } });
    expect((await t.parse(req({ aliases: ["p1"], fixtureName: "batch2" }))).parsed?.photos[0].photoId).toBe("p60");
    const generic = await t.parse(req({ aliases: ["p1"] }));
    expect(generic.parsed?.photos[0].photoId).toBe("p50");
    expect(generic.usage.output).toBe(77);
  });

  it("refusal and max_tokens return parsed null with the stop reason", async () => {
    const t = new ReplayTransport({ scenario: ["refusal", "max_tokens"], fixturesDir: emptyDir() });
    expect(await t.parse(req())).toMatchObject({ parsed: null, stopReason: "refusal", stopCategory: "general_harms" });
    const m = await t.parse(req());
    expect(m).toMatchObject({ parsed: null, stopReason: "max_tokens" });
    expect(m.usage.output).toBe(3000);
  });

  it("rate_limit / server_error throw retryable TransportErrors; sequence's last entry repeats", async () => {
    const t = new ReplayTransport({ scenario: ["rate_limit", "server_error", "ok"], fixturesDir: emptyDir(), synths: { curator: synth } });
    await expect(t.parse(req())).rejects.toMatchObject({ code: "rate_limited", retryable: true });
    await expect(t.parse(req())).rejects.toMatchObject({ code: "server_error", retryable: true });
    expect((await t.parse(req())).parsed).not.toBeNull();
    expect((await t.parse(req())).parsed).not.toBeNull();
    expect(t.callCount).toBe(4);
  });

  it("invalid without a synth that handles it → output fails the AI schema → parsed null", async () => {
    const t = new ReplayTransport({ scenario: "invalid", fixturesDir: emptyDir() });
    expect((await t.parse(req())).parsed).toBeNull();
  });

  it("ok without fixture or synthesiser throws a non-retryable error", async () => {
    const t = new ReplayTransport({ scenario: "ok", fixturesDir: emptyDir() });
    await expect(t.parse(req())).rejects.toMatchObject({ code: "unknown", retryable: false });
  });

  it("reads AI_REPLAY_SCENARIO", async () => {
    vi.stubEnv("AI_REPLAY_SCENARIO", "refusal");
    const t = new ReplayTransport({ fixturesDir: emptyDir() });
    expect((await t.parse(req())).stopReason).toBe("refusal");
    expect(parseScenarioEnv("rate_limit, ok,bogus")).toEqual(["rate_limit", "ok"]);
    expect(parseScenarioEnv(undefined)).toEqual(["ok"]);
  });
});
