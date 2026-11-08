# AI fixtures

- `<agent>[.<fixtureName>].<scenario>.json` — answers for `ReplayTransport`
  (`{ parsed?, stopReason?, stopCategory?, usage?, model? }`). None are committed yet: replay
  synthesises answers from `scenarioMeta` via `registerReplaySynth()` (agents register in T8+).
  A generic `<agent>.ok.json` is returned for EVERY call of that agent — only use one for
  single-call agents (Storyteller), or set `scenarioMeta.fixtureName` per call.
- `api/*.message.json` — Messages API response bodies used by `tests/ai/transport-live.test.ts`
  via a stubbed `fetch` (no network). Hand-written in the exact API shape (no API key existed
  when they were made); replace with real recordings in M3b. Content is fake.
