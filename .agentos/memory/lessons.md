# Lessons learned (newest at the bottom)

Things that went wrong or surprised us, so no agent repeats them. Format: `- (YYYY-MM-DD, area) lesson`.

- (2026-11-03, images) Read EXIF with exifr BEFORE converting HEIC → JPEG; conversion strips EXIF.
- (2026-11-03, images) Photos received via WhatsApp usually have no EXIF; fall back to file.lastModified.
- (2026-11-03, claude-api) Opus 5.5: no thinking:disabled, no budget_tokens, no temperature, no prefill, no forced tool_choice — all 400.
