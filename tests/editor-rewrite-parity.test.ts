// M5 T14 (tester): POST /api/ai/rewrite contract ↔ editor UI state parity. Every error the route
// can produce must land on a specific, actionable UI state — never the generic "error" for a
// 502 — and retryable failures must offer "Try again".
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { REWRITE_INSTRUCTIONS } from "@/lib/ai/schemas";
import { rewriteResponseState, REWRITE_FAILURE_COPY, type RewriteFailureKind } from "@/lib/editor/caption-tools";

// Mirrors TransportErrorCode (src/lib/ai/transport.ts) + StepErrorCode extras + rewriter codes.
const RETRYABLE_TRANSPORT = ["rate_limited", "server_error", "timeout", "connection"] as const;
const FATAL_TRANSPORT = ["bad_request", "auth", "unknown"] as const;
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

  it("the route's non-502 statuses each map to their own state", () => {
    const cases: [number, unknown, string][] = [
      [503, { error: "ai_off" }, "off"],
      [429, { error: "limit", remaining: 0 }, "limit"],
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
    const kinds: RewriteFailureKind[] = ["off", "limit", "busy", "retry", "unusable", "refused", "signedOut", "error"];
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
