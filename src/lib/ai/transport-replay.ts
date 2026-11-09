// Replay transport: deterministic answers for local dev, previews and tests (D-024). Never calls
// the API. Answers come from tests/fixtures/ai/<agent>[.<fixtureName>].<scenario>.json when
// present, else from a per-agent synthesiser registered with registerReplaySynth().
// Reports fake token usage (incl. prompt-cache read/write) so cost math is exercised.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_MODEL } from "./client";
import {
  assertRequestShape,
  countImages,
  TransportError,
  type AgentName,
  type AgentRequest,
  type AgentResponse,
  type AgentTransport,
  type TokenUsage,
} from "./transport";

/**
 * `plant_bad_caption` (M4): the Caption Writer synth plants one pre-check failure and one Critic
 * mismatch on its first attempt (see agents/caption-writer-replay.ts); the Critic synth flags the
 * mismatch. Every other agent treats it exactly like "ok" (incl. falling back to `.ok` fixtures).
 */
export const REPLAY_SCENARIOS = [
  "ok",
  "refusal",
  "max_tokens",
  "rate_limit",
  "server_error",
  "invalid",
  "plant_bad_caption",
] as const;
export type ReplayScenario = (typeof REPLAY_SCENARIOS)[number];

export interface ReplaySynthContext {
  /**
   * "ok" → return a valid answer; "invalid" → return something the strict schema rejects;
   * "plant_bad_caption" → like "ok" except for the Caption Writer / Critic synths.
   */
  scenario: "ok" | "invalid" | "plant_bad_caption";
  request: AgentRequest<unknown>;
}

/** Builds an answer from request.scenarioMeta (e.g. the alias list). Must be deterministic. */
export type ReplaySynth = (meta: Record<string, unknown>, ctx: ReplaySynthContext) => unknown;

const registry = new Map<AgentName, ReplaySynth>();

export function registerReplaySynth(agent: AgentName, fn: ReplaySynth): void {
  registry.set(agent, fn);
}
export function getReplaySynth(agent: AgentName): ReplaySynth | undefined {
  return registry.get(agent);
}
/** Tests only. */
export function clearReplaySynths(): void {
  registry.clear();
}

/** Recorded answer on disk. Every field optional; missing ones are filled per scenario. */
export interface ReplayFixture {
  parsed?: unknown;
  stopReason?: string | null;
  stopCategory?: string | null;
  usage?: Partial<TokenUsage>;
  model?: string;
}

export interface ReplayTransportOptions {
  /** One scenario for every call, or a sequence (last entry repeats). Default: AI_REPLAY_SCENARIO or "ok". */
  scenario?: ReplayScenario | ReplayScenario[];
  /** Full control per call (wins over `scenario`). callIndex counts all calls on this instance. */
  scenarioFor?: (agent: AgentName, callIndex: number) => ReplayScenario;
  fixturesDir?: string;
  /** Instance-level synthesisers (win over the global registry). */
  synths?: Partial<Record<AgentName, ReplaySynth>>;
}

/** Parses "ok" or "rate_limit,ok"; unknown entries are dropped; empty → ["ok"]. */
export function parseScenarioEnv(value: string | undefined): ReplayScenario[] {
  const list = (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ReplayScenario => (REPLAY_SCENARIOS as readonly string[]).includes(s));
  return list.length ? list : ["ok"];
}

/** ~4 chars per token; a 512px thumbnail ≈ 350 tokens. Opus 5.5 caches prefixes ≥ 512 tokens. */
const estimateTokens = (s: string) => Math.ceil(s.length / 4);
function mergeUsage(base: TokenUsage, over: Partial<TokenUsage> | undefined): TokenUsage {
  const out = { ...base };
  for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const v = over?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

export const REPLAY_IMAGE_TOKENS = 350;
export const MIN_CACHEABLE_TOKENS = 512;

export class ReplayTransport implements AgentTransport {
  readonly kind = "replay" as const;
  private readonly sequence: ReplayScenario[];
  private readonly scenarioFor?: ReplayTransportOptions["scenarioFor"];
  private readonly fixturesDir: string;
  private readonly synths: Partial<Record<AgentName, ReplaySynth>>;
  private readonly cachedPrefixes = new Set<string>();
  private calls = 0;

  constructor(opts: ReplayTransportOptions = {}) {
    const s = opts.scenario;
    this.sequence = s === undefined ? parseScenarioEnv(process.env.AI_REPLAY_SCENARIO) : Array.isArray(s) ? (s.length ? s : ["ok"]) : [s];
    this.scenarioFor = opts.scenarioFor;
    this.fixturesDir = opts.fixturesDir ?? join(process.cwd(), "tests", "fixtures", "ai");
    this.synths = opts.synths ?? {};
  }

  /** Number of parse() calls so far (including ones that threw). */
  get callCount(): number {
    return this.calls;
  }

  async parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
    assertRequestShape(req);
    const index = this.calls++;
    const scenario = this.scenarioFor
      ? this.scenarioFor(req.agent, index)
      : this.sequence[Math.min(index, this.sequence.length - 1)];

    if (scenario === "rate_limit") throw new TransportError("rate_limited", "replay: rate limited", { status: 429 });
    if (scenario === "server_error") throw new TransportError("server_error", "replay: server error", { status: 529 });

    const fixture = this.loadFixture(req, scenario);
    const model = fixture?.model ?? req.model ?? AI_MODEL;
    const input = this.inputUsage(req);

    if (scenario === "refusal" || scenario === "max_tokens") {
      const refusal = scenario === "refusal";
      const output = refusal ? 24 : req.maxTokens;
      return this.respond<T>({
        parsed: null,
        stopReason: fixture?.stopReason ?? (refusal ? "refusal" : "max_tokens"),
        stopCategory: refusal ? (fixture?.stopCategory ?? "general_harms") : null,
        usage: mergeUsage({ ...input, output }, fixture?.usage),
        model,
      });
    }

    let raw: unknown;
    if (fixture && "parsed" in fixture) {
      raw = fixture.parsed;
    } else {
      const synth = this.synths[req.agent] ?? registry.get(req.agent);
      if (synth) {
        raw = synth(req.scenarioMeta ?? {}, { scenario, request: req as AgentRequest<unknown> });
      } else if (scenario === "invalid") {
        raw = { __replay_invalid__: true };
      } else {
        throw new TransportError("unknown", `replay: no fixture or synthesiser for agent "${req.agent}"`);
      }
    }

    // Same contract as the live lenient format: output that fails the AI schema → parsed null.
    const checked = req.schema.safeParse(raw);
    const outText = JSON.stringify(raw ?? null);
    return this.respond<T>({
      parsed: checked.success ? checked.data : null,
      stopReason: fixture?.stopReason ?? "end_turn",
      stopCategory: null,
      usage: mergeUsage({ ...input, output: estimateTokens(outText) + 40 }, fixture?.usage),
      model,
    });
  }

  private respond<T>(r: Omit<AgentResponse<T>, "latencyMs">): AgentResponse<T> {
    return { ...r, latencyMs: 100 + Math.round(r.usage.output / 10) };
  }

  private loadFixture(req: AgentRequest<unknown>, scenario: ReplayScenario): ReplayFixture | null {
    const name = req.scenarioMeta?.fixtureName;
    const named = typeof name === "string" && /^[\w-]+$/.test(name) ? name : null;
    const forScenario = (s: ReplayScenario) => [...(named ? [`${req.agent}.${named}.${s}.json`] : []), `${req.agent}.${s}.json`];
    // plant_bad_caption behaves like "ok" for fixtures too (its own fixtures win when present).
    const candidates = scenario === "plant_bad_caption" ? [...forScenario(scenario), ...forScenario("ok")] : forScenario(scenario);
    for (const file of candidates) {
      const p = join(this.fixturesDir, file);
      try {
        if (!existsSync(p)) continue;
        const data = JSON.parse(readFileSync(p, "utf8")) as unknown;
        if (data && typeof data === "object" && !Array.isArray(data)) return data as ReplayFixture;
        throw new TransportError("unknown", `replay: fixture ${file} is not an object`);
      } catch (e) {
        if (e instanceof TransportError) throw e;
        throw new TransportError("unknown", `replay: unreadable fixture ${file}`);
      }
    }
    return null;
  }

  /** Fake input usage: system prefix is written to cache once, then read (when ≥ 512 tokens). */
  private inputUsage(req: AgentRequest<unknown>): Omit<TokenUsage, "output"> {
    const systemText = req.system.map((b) => b.text).join("\n");
    const systemTokens = estimateTokens(systemText);
    let messageTokens = countImages(req.messages) * REPLAY_IMAGE_TOKENS;
    for (const m of req.messages) {
      if (typeof m.content === "string") messageTokens += estimateTokens(m.content);
      else for (const p of m.content) if (p.type === "text") messageTokens += estimateTokens(p.text);
    }
    const cacheable = req.system[req.system.length - 1]?.cache_control?.type === "ephemeral" && systemTokens >= MIN_CACHEABLE_TOKENS;
    if (!cacheable) return { input: systemTokens + messageTokens, cacheRead: 0, cacheWrite: 0 };
    const key = `${req.model ?? AI_MODEL}\u0000${systemText}`;
    if (this.cachedPrefixes.has(key)) return { input: messageTokens, cacheRead: systemTokens, cacheWrite: 0 };
    this.cachedPrefixes.add(key);
    return { input: messageTokens, cacheRead: 0, cacheWrite: systemTokens };
  }
}
