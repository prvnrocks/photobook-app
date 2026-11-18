// Opt-in integration test against the REAL model. Skipped unless PHOTO_AI_LIVE=1 (it costs about
// one cent). The image is generated here (coloured shapes) — no user photo ever leaves the machine.
//
//   PHOTO_AI_LIVE=1 node --env-file=.env.local node_modules/.bin/vitest run tests/ai/photo-intelligence.live.test.ts
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/photo-analyses", () => ({}));
vi.mock("@/lib/db/photo-ingest", () => ({}));
vi.mock("@/lib/db/photos", () => ({}));
vi.mock("@/lib/ai/budget", () => ({}));

import { analyzePhoto } from "@/lib/ai/photo-intelligence/analyze";
import { readPhotoAiConfig } from "@/lib/ai/photo-intelligence/config";
import { getTransport } from "@/lib/ai/transport-factory";
import type { CallRecord, OwnPhoto } from "@/lib/db/photo-analyses";
import { prepareAiCopy } from "@/lib/photos/ingest-verify";
import { PhotoAnalysisSchema } from "@/lib/storybook/schemas";

const LIVE = process.env.PHOTO_AI_LIVE === "1" && (process.env.ANTHROPIC_API_KEY ?? "").trim() !== "";

describe.skipIf(!LIVE)("photo intelligence — live model (opt-in)", () => {
  it("analyses a generated image end to end: structured output, usage, cost", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384">
      <rect width="512" height="230" fill="#8ec5ff"/><rect y="230" width="512" height="154" fill="#3a9d5d"/>
      <circle cx="410" cy="80" r="42" fill="#ffd84a"/>
      <rect x="150" y="170" width="150" height="110" fill="#c0392b"/><polygon points="135,170 225,95 315,170" fill="#7f3b1d"/>
      <rect x="205" y="215" width="40" height="65" fill="#5b3a1a"/></svg>`;
    const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
    const copy = prepareAiCopy(new Uint8Array(jpeg));
    if (!copy.ok) throw new Error("fixture is not a valid AI copy");

    const photo: OwnPhoto = {
      id: "00000000-0000-4000-8000-000000000001",
      user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      book_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      upload_state: "ready",
      thumb_path: "x/y/z-thumb.jpg",
      width: 512,
      height: 384,
      taken_at: null,
      date_source: null,
      lat: null,
      lng: null,
      place: null,
      blur_score: null,
      dup_group: null,
      color: null,
      ai: null,
      status: "kept",
      drop_reason: null,
      user_override: false,
      bookIsPaid: false,
    };
    const records: CallRecord[] = [];
    const a = await analyzePhoto(photo.id, {
      loadPhoto: async () => photo,
      isRejected: async () => false,
      loadAiCopy: async () => Buffer.from(copy.bytes).toString("base64"),
      getCached: async () => null,
      record: async (r) => void records.push(r),
      countAnalysed: async () => 0,
      budgetExhausted: async () => false,
      mode: "live",
      transport: getTransport("live"),
      config: { ...readPhotoAiConfig(), retries: 0 },
    });

    expect(PhotoAnalysisSchema.safeParse(a).success).toBe(true);
    expect(a.vision!.atmosphere.interpretation).toBe(true);
    expect(a.vision!.peopleCount).toBe(0);
    expect(a.vision!.objects.length).toBeGreaterThan(0);
    expect(a).toMatchObject({ takenAt: null, place: null, hasGps: false, orientation: "landscape" });
    const r = records[0]!;
    expect(r.status).toBe("ok");
    expect(r.usage.input).toBeGreaterThan(0);
    expect(r.usage.output).toBeGreaterThan(0);
    expect(r.latencyMs).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.costUsd).toBeLessThan(0.05);
    // Numbers only — never the description.
    console.info(`[live] model=${a.vision!.model} in=${r.usage.input} out=${r.usage.output} cacheRead=${r.usage.cacheRead} ms=${r.latencyMs} usd=${r.costUsd} objects=${a.vision!.objects.length} scene=${a.vision!.scene} role=${a.vision!.storyRole}`);
  }, 60_000);
});
