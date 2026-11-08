import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

import { CuratorBatchAiSchema } from "@/lib/ai/schemas";
import { cachedSystem, TransportError, type AgentRequest } from "@/lib/ai/transport";
import { LiveTransport, lenientOutputFormat, toTransportError } from "@/lib/ai/transport-live";

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "tests", "fixtures", "ai", "api", name), "utf8");

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** Real SDK client whose fetch returns a recorded body — exercises the whole SDK parse path. */
function clientReturning(status: number, body: string, captured: Captured[] = []) {
  const fetchStub = async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };
  return new Anthropic({ apiKey: "test-key-not-real", maxRetries: 0, fetch: fetchStub as typeof fetch });
}

const req = (): AgentRequest<z.infer<typeof CuratorBatchAiSchema>> => ({
  agent: "curator",
  system: cachedSystem("You are the Curator. ".repeat(10)),
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Photos p1, p2" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      ],
    },
  ],
  schema: CuratorBatchAiSchema,
  effort: "low",
  maxTokens: 4000,
});

describe("LiveTransport request shape", () => {
  it.each([true, false])("useServerFallbacks=%s sends only allowed params", async (fallbacks) => {
    const cap: Captured[] = [];
    const t = new LiveTransport({ client: clientReturning(200, fixture("curator-ok.message.json"), cap), useServerFallbacks: fallbacks });
    const res = await t.parse(req());

    expect(cap).toHaveLength(1);
    const { body, headers, url } = cap[0];
    expect(url).toMatch(/\/v1\/messages(\?beta=true)?$/);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.max_tokens).toBe(4000);
    const oc = body.output_config as { effort: string; format: { type: string; schema: object } };
    expect(oc.effort).toBe("low");
    expect(oc.format.type).toBe("json_schema");
    expect((body.system as Array<{ cache_control?: unknown }>).at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    for (const forbidden of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "budget_tokens"]) {
      expect(body, forbidden).not.toHaveProperty(forbidden);
    }
    expect((body.messages as Array<{ role: string }>).every((m) => m.role === "user")).toBe(true);
    if (fallbacks) {
      expect(body.fallbacks).toBe("default");
      expect(headers.get("anthropic-beta") ?? "").toContain("server-side-fallback-2026-07-01");
      expect(body).not.toHaveProperty("betas");
    } else {
      expect(body).not.toHaveProperty("fallbacks");
    }

    expect(res.stopReason).toBe("end_turn");
    expect(res.parsed?.photos.map((p) => p.photoId)).toEqual(["p1", "p2"]);
    expect(res.usage).toEqual({ input: 812, output: 240, cacheRead: 1450, cacheWrite: 0 });
    expect(res.model).toBe("claude-opus-5-5");
  });

  it("refusal: returns stop_reason + category, parsed null (does not throw)", async () => {
    const t = new LiveTransport({ client: clientReturning(200, fixture("curator-refusal.message.json")) });
    const res = await t.parse(req());
    expect(res).toMatchObject({ parsed: null, stopReason: "refusal", stopCategory: "general_harms" });
    expect(res.usage.cacheWrite).toBe(1450);
  });

  it("max_tokens: truncated JSON → parsed null, stop_reason kept", async () => {
    const t = new LiveTransport({ client: clientReturning(200, fixture("curator-max-tokens.message.json")) });
    const res = await t.parse(req());
    expect(res).toMatchObject({ parsed: null, stopReason: "max_tokens" });
  });

  it.each([
    [429, "rate_limited", true],
    [500, "server_error", true],
    [529, "server_error", true],
    [400, "bad_request", false],
    [401, "auth", false],
    [403, "auth", false],
  ] as const)("HTTP %s → TransportError %s", async (status, code, retryable) => {
    const body = JSON.stringify({ type: "error", error: { type: "x", message: "nope" } });
    const t = new LiveTransport({ client: clientReturning(status, body) });
    const err = await t.parse(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ code, retryable });
  });

  it("rejects more than 10 images before calling", async () => {
    const cap: Captured[] = [];
    const t = new LiveTransport({ client: clientReturning(200, fixture("curator-ok.message.json"), cap) });
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: "A" } };
    const r = { ...req(), messages: [{ role: "user" as const, content: Array.from({ length: 11 }, () => image) }] };
    await expect(t.parse(r)).rejects.toMatchObject({ code: "bad_request", retryable: false });
    expect(cap).toHaveLength(0);
  });
});

describe("toTransportError (SDK classes, most specific first)", () => {
  const h = new Headers();
  it.each([
    [new Anthropic.APIConnectionTimeoutError(), "timeout"],
    [new Anthropic.APIConnectionError({ message: "x" }), "connection"],
    [new Anthropic.RateLimitError(429, undefined, "x", h), "rate_limited"],
    [new Anthropic.InternalServerError(500, undefined, "x", h), "server_error"],
    [new Anthropic.BadRequestError(400, undefined, "x", h), "bad_request"],
    [new Anthropic.AuthenticationError(401, undefined, "x", h), "auth"],
    [new Anthropic.APIUserAbortError(), "unknown"],
    [new Error("Anthropic API key is not configured"), "auth"],
    ["weird", "unknown"],
  ] as const)("%o → %s", (e, code) => {
    expect(toTransportError(e).code).toBe(code);
  });
});

describe("lenientOutputFormat", () => {
  it("returns null instead of throwing on bad JSON / schema mismatch", () => {
    const f = lenientOutputFormat(z.object({ a: z.number() }));
    expect(f.parse('{"a":1}')).toEqual({ a: 1 });
    expect(f.parse('{"a":"x"}')).toBeNull();
    expect(f.parse("not json")).toBeNull();
  });
});
