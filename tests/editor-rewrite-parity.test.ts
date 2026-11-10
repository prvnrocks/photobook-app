// M5 T14 (tester): POST /api/ai/rewrite contract ↔ editor UI state parity. Every error the route
// can produce must land on a specific, actionable UI state — never the generic "error" for a
// 502 — and retryable failures must offer "Try again".
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { REWRITE_INSTRUCTIONS } from "@/lib/ai/schemas";
import {
  canShorten,
  rewriteOptions,
  rewriteResponseState,
  REWRITE_FAILURE_COPY,
  sessionBlockFor,
  type RewriteFailureKind,
} from "@/lib/editor/caption-tools";

// Mirrors TransportErrorCode (src/lib/ai/transport.ts) + StepErrorCode extras + rewriter codes.
const RETRYABLE_TRANSPORT = ["rate_limited", "server_error", "timeout", "connection"] as const;
const FATAL_TRANSPORT = ["unknown"] as const;
// Our key / request shape is wrong: not the user's caption → neutral "not available" copy.
const CONFIG_TRANSPORT = ["bad_request", "auth"] as const;
const STEP_EXTRAS = ["max_tokens", "context_window_exceeded", "parse_failed", "schema_invalid"] as const;

describe("rewrite route ↔ UI parity", () => {
  it("transport retryable codes on 502 → retry (Try again)", () => {
    for (const code of RETRYABLE_TRANSPORT) {
      expect(rewriteResponseState(502, { error: code, retryable: true }, "rewrite").kind, code).toBe("retry");
    }
  });

  it("non-retryable 502 codes → unusable (never generic error); refusal → refused", () => {
    for (const code of [...FATAL_TRANSPORT, ...STEP_EXTRAS, "rewrite_unusable"]) {
      expect(rewriteResponseState(502, { error: code, retryable: false }, "shorter").kind, code).toBe("unusable");
    }
    expect(rewriteResponseState(502, { error: "refusal", retryable: false }, "translate").kind).toBe("refused");
    // A refusal is refused even if a future server marks it retryable.
    expect(rewriteResponseState(502, { error: "refusal", retryable: true }, "translate").kind).toBe("refused");
  });

  it("502 auth / bad_request → neutral 'not available right now' (T14 bug 4), and ✨ is switched off", () => {
    for (const code of CONFIG_TRANSPORT) {
      const st = rewriteResponseState(502, { error: code, retryable: false }, "rewrite");
      expect(st.kind, code).toBe("unavailable");
      expect(sessionBlockFor(st.kind)).toBe("unavailable");
    }
    expect(REWRITE_FAILURE_COPY.unavailable).toBe("AI captions aren't available right now — try later");
  });

  it("new route codes: 503 ai_unavailable, 429 daily_limit, 400 too_short", () => {
    const unavailable = rewriteResponseState(503, { error: "ai_unavailable" }, "rewrite");
    expect(unavailable.kind).toBe("unavailable");
    expect(sessionBlockFor(unavailable.kind)).toBe("unavailable");

    const daily = rewriteResponseState(429, { error: "daily_limit" }, "rewrite");
    expect(daily.kind).toBe("dailyLimit");
    expect(sessionBlockFor(daily.kind)).toBe("dailyLimit");
    expect(REWRITE_FAILURE_COPY.dailyLimit).toBe("You've reached today's AI rewrite limit — try again tomorrow");
    // The per-book cap is still its own state (with Upgrade).
    expect(rewriteResponseState(429, { error: "limit", remaining: 0 }, "rewrite").kind).toBe("limit");

    const short = rewriteResponseState(400, { error: "too_short" }, "shorter");
    expect(short.kind).toBe("tooShort");
    expect(sessionBlockFor(short.kind)).toBeNull(); // only this caption
    expect(REWRITE_FAILURE_COPY.tooShort).toBe("This caption is already short");
    // ai_off keeps its own copy and also switches ✨ off.
    expect(sessionBlockFor(rewriteResponseState(503, { error: "ai_off" }, "rewrite").kind)).toBe("off");
  });

  it("'Shorter' is disabled client-side for captions of ≤ 3 words", () => {
    expect(canShorten("")).toBe(false);
    expect(canShorten("Sunset")).toBe(false);
    expect(canShorten("Sunset at  the\nbeach")).toBe(true);
    expect(canShorten("Sunset at sea")).toBe(false);
    expect(canShorten("غروب الشمس على البحر")).toBe(true);
    expect(canShorten("غروب الشمس")).toBe(false);
    const short = rewriteOptions("Eid mubarak");
    expect(short.main.find((o) => o.instruction === "shorter")?.disabledReason).toBe(REWRITE_FAILURE_COPY.tooShort);
    expect(short.main.filter((o) => o.disabledReason)).toHaveLength(1);
    const long = rewriteOptions("A long walk along the Corniche");
    expect(long.main.every((o) => o.disabledReason === undefined)).toBe(true);
  });

  it("the route's non-502 statuses each map to their own state", () => {
    const cases: [number, unknown, string][] = [
      [503, { error: "ai_off" }, "off"],
      [503, { error: "ai_unavailable" }, "unavailable"],
      [503, null, "unavailable"],
      [429, { error: "limit", remaining: 0 }, "limit"],
      [429, { error: "daily_limit" }, "dailyLimit"],
      [400, { error: "too_short" }, "tooShort"],
      [409, { error: "already_running" }, "busy"],
      [401, { error: "unauthenticated" }, "signedOut"],
      [400, { error: "invalid_body" }, "error"],
      [403, { error: "forbidden" }, "error"],
      [404, { error: "not_found" }, "error"],
      [500, { error: "server_error" }, "error"],
      // Platform-level failures without JSON (e.g. Vercel function timeout).
      [504, null, "retry"],
      [408, null, "retry"],
    ];
    for (const [status, body, kind] of cases) expect(rewriteResponseState(status, body, "rewrite").kind, String(status)).toBe(kind);
  });

  it("every failure kind has non-empty copy", () => {
    const kinds: RewriteFailureKind[] = [
      "off",
      "unavailable",
      "limit",
      "dailyLimit",
      "tooShort",
      "busy",
      "retry",
      "unusable",
      "refused",
      "signedOut",
      "error",
    ];
    for (const k of kinds) expect(REWRITE_FAILURE_COPY[k].length).toBeGreaterThan(5);
  });

  it("200 preview keeps the instruction for every server instruction; remaining clamps", () => {
    for (const instruction of REWRITE_INSTRUCTIONS) {
      const st = rewriteResponseState(200, { text: "Hi there", lang: "en", remaining: -3 }, instruction);
      expect(st).toMatchObject({ kind: "preview", instruction, remaining: 0 });
    }
    expect(rewriteResponseState(200, { text: "x", lang: "fr", remaining: 2.7 }, "rewrite")).toMatchObject({ lang: "en", remaining: 2 });
    expect(rewriteResponseState(200, { text: "x", remaining: Number.NaN }, "rewrite")).toMatchObject({ remaining: null });
  });
});
