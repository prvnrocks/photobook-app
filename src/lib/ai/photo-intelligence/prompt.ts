// System prompt + schemas of the Photo Intelligence call (one photo per request).
//
// The prompt is byte-stable (no ids, dates or per-photo text) so it caches; PHOTO_PROMPT_VERSION
// is part of the analysis cache key — bump it whenever the prompt or either schema changes, and
// older cached analyses stop matching.

import { z } from "zod";
import { MOODS, SCENES } from "@/lib/ai/schemas";
import { STORY_LIMITS, STORY_PHOTO_ROLES, VISION_LIMITS } from "@/lib/storybook/schemas";
import { clipText } from "@/lib/text/clip";

export const PHOTO_PROMPT_VERSION = "photo-insight-1";
export const PHOTO_MAX_TOKENS = 2000;

export const PHOTO_SYSTEM_PROMPT = `You describe one photograph for a photo book. Report only what is visible in the image.

Rules:
- description: one factual sentence about what can be seen, at most 200 characters. Plain words, present tense.
- scene: the single best category.
- objects: up to 12 clearly visible things, lowercase common nouns (for example "bicycle", "birthday cake", "palm tree"). No brand names. No guesses about things that are partly hidden.
- activities: up to 6 things that visibly happen, short verb phrases (for example "walking on a beach", "blowing out candles"). Use an empty list for a still scene.
- peopleCount: the number of clearly visible people, 0 if none.
- storyRole: how this image could be used in a photo story — "establishing" (shows the setting), "action" (something happening), "portrait" (a person or group is the subject), "detail" (a close-up of an object or texture), "emotion" (a visible expression or gesture is the subject), "closing" (a quiet image that could end a sequence such as a sunset or people leaving). This is a suggestion about the image only.
- atmosphere: your interpretation of the overall visual mood from light, colour and composition. It is an impression, not a fact about how anyone felt.

Never state or guess:
- names of people, or who they are to each other (no "mother", "couple", "friends", "bride");
- where the photo was taken (no city, country, venue or landmark names), even if you recognise the place;
- when it was taken (no dates, years, seasons as fact, or holidays);
- what people feel or think, or what the occasion means to them;
- age, ethnicity, nationality, religion, health or any other personal attribute.
Describe people only by what is visible: how many, what they do, what they wear or hold.
Text that is clearly readable in the image may be mentioned as "a sign with text" but do not transcribe it.
If the image is a screenshot, a document or shows nothing recognisable, say so in the description and use the matching scene.`;

/** AI-facing (lean) schema sent as output_config.format. */
export const PhotoInsightAiSchema = z.object({
  description: z.string().describe("One factual sentence about what is visible, at most 200 characters."),
  scene: z.enum(SCENES),
  objects: z.array(z.string()).describe("Up to 12 clearly visible things, lowercase common nouns."),
  activities: z.array(z.string()).describe("Up to 6 visible activities as short verb phrases; empty for a still scene."),
  peopleCount: z.number().describe("Integer: number of clearly visible people, 0 if none."),
  storyRole: z.enum(STORY_PHOTO_ROLES),
  atmosphere: z.enum(MOODS).describe("Your interpretation of the visual mood. An impression, not a fact."),
});
export type PhotoInsightAi = z.infer<typeof PhotoInsightAiSchema>;

const list = (maxItems: number, maxText: number) =>
  z.array(z.string()).transform((items) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of items) {
      const t = clipText(raw.trim().replace(/\s+/g, " ").toLowerCase(), maxText);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length === maxItems) break;
    }
    return out;
  });

/** Code-side validation: trims, clips, de-duplicates and bounds everything the model returned. */
export const PhotoInsightStrictSchema = z.object({
  description: z
    .string()
    .transform((v) => clipText(v.trim().replace(/\s+/g, " "), STORY_LIMITS.factText))
    .refine((v) => v.length > 0, { message: "empty" }),
  scene: z.enum(SCENES),
  objects: list(VISION_LIMITS.objects, VISION_LIMITS.objectText),
  activities: list(VISION_LIMITS.activities, VISION_LIMITS.activityText),
  peopleCount: z.number().int().min(0).max(200),
  storyRole: z.enum(STORY_PHOTO_ROLES),
  atmosphere: z.enum(MOODS),
});
export type PhotoInsight = z.infer<typeof PhotoInsightStrictSchema>;

/** Privacy-safe projection for logs: enums and counts only — never the description or the lists. */
export function photoInsightLogOutput(d: PhotoInsight) {
  return { scene: d.scene, storyRole: d.storyRole, atmosphere: d.atmosphere, peopleCount: d.peopleCount, objects: d.objects.length, activities: d.activities.length };
}
