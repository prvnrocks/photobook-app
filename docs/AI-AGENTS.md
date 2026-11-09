# In-Product AI — Agent Pipeline Design

The photobook AI is a **team of specialist agents run by a code orchestrator**. Each agent is one focused
Claude call with typed input/output; the orchestrator (TypeScript state machine) decides who runs next.
Every step is logged, and agents share a per-user **memory**.

Why not free-chatting autonomous agents? Cost and time must stay predictable (< 90 s, ≈ $1 per 200-photo book),
and every decision must be explainable to the user ("why was this photo dropped?"). See decision D-006.

```
                         ┌──────────────────────── ORCHESTRATOR (code, src/lib/ai/orchestrator.ts) ────────────────────────┐
 photos + metadata ──▶   │                                                                                                │
 (EXIF, GPS→place,       │  ① CURATOR ×N (parallel, 10 photos each)  ──▶ photo notes, keep/drop + reason                   │
  pHash dupes, blur)     │            │                                                                                    │
                         │            ▼                                                                                    │
 USER MEMORY ───────────▶│  ② STORYTELLER  ──▶ moments/chapters, page plan, cover, title                                   │
 (tone, language, fonts, │            │                                                                                    │
  past edits, names)     │            ▼                                                                                    │
                         │  ③ CAPTION WRITER ×moments (parallel)  ──▶ quotes + chapter headings                            │
                         │            │                                                                                    │
                         │            ▼                                                                                    │
                         │  ④ CRITIC  ──▶ score + issues ──(issues & score < 7?)──▶ targeted repair (max 1 round) ─┐       │
                         │            │                                                                       ▲        │       │
                         │            │◀──────────────────────────────────────────────────────────────────────┘        │       │
                         │            ▼                                                                                    │
                         │  ⑤ code validation (ids exist, slot counts, page limits) ──fail──▶ rule-based fallback album   │
                         └────────────┬───────────────────────────────────────────────────────────────────────────────────┘
                                      ▼
                         book.doc saved  →  review screen  →  editor (✨ REWRITER agent on demand)
                                      │
                         user edits ──▶ ⑥ MEMORY KEEPER (code + small AI summary) updates user_memory
```

## The agents

| # | Agent | Input | Output (zod schema) | Effort | When |
|---|---|---|---|---|---|
| ① | **Curator** | 10 thumbnails (512px) + their metadata | `PhotoAnalysis[]` — description, scene, people, mood, quality 1–10, coverWorthy, keep, dropReason | low | every batch, parallel ×3 |
| ② | **Storyteller** | all photo notes (text), dates, places, occasion, page target, layout catalogue, user memory | `AlbumPlan` — title, subtitle, cover, moments → pages (layoutId + photoIds) | medium | once per build |
| ③ | **Caption Writer** | one moment: title, its photo notes, occasion, tone, language, user memory | `MomentCaptions` — heading + one quote per page | medium | per moment, parallel |
| ④ | **Critic** | the full plan + captions + photo notes + rubric | `Critique` — score 1–10, issues[] {type, pageIndex, fix} | medium | once; triggers ≤1 repair |
| — | **Rewriter** | one caption + instruction (shorter / tone / translate) + user memory | `{ text }` | low | on demand in editor |
| ⑥ | **Memory Keeper** | diff between AI draft and the user's final book | updates to `user_memory` | low | on publish |

Schemas `PhotoAnalysis`, `AlbumPlan`, `MomentCaptions` are defined in docs/PLAN.md. New ones:

```ts
Critique = {
  score: number,                       // 1–10 overall
  issues: [{
    type: "duplicate_feel" | "weak_cover" | "chronology" | "caption_mismatch" | "caption_invented_fact"
        | "caption_not_original" | "too_repetitive" | "unbalanced_chapter" | "low_quality_photo",
    pageIndex: number | null,
    detail: string,
    fix: "swap_photo" | "reorder" | "rewrite_caption" | "change_layout" | "change_cover",
  }],
}

UserMemoryUpdate = {
  tonePreference?: "romantic"|"fun"|"nostalgic"|"minimal",
  captionLength?: "short"|"medium",
  preferredFonts?: string[],
  language?: "en"|"ar",
  knownNames?: string[],               // only names the USER typed, never guessed from faces
  avoid?: string[],                    // e.g. "no emojis", "no religious quotes"
}
```

**Critic rubric** (in its prompt): cover is a strong, people-forward photo · chapters in time order ·
no two near-identical photos on the same spread · every caption matches what's visible · no invented
names/places/facts · captions not repetitive (no repeated opening words) · each chapter has 2+ pages ·
captions are original (no well-known quote, lyric, film line, slogan or proverb → `caption_not_original`).

### Rewriter (M5, on demand)

`rewriteCaption({ ctx: { transport, logger, retry? }, runId, input })` in `src/lib/ai/agents/rewriter.ts`
→ `{ ok: true, text, lang } | { ok: false, code }`. Instructions: `rewrite | shorter | tone:<Tone> | translate`
(translate = EN↔AR, target from `translateTarget(text)`). Input: the caption, target lang, book occasion/tone/title,
the doc's chapters, the page's photo notes as text (no images, D-037 #8) and user memory (user message only).
Effort low, max_tokens 2000, timeout 15 s, server-side fallbacks as every agent.
The output goes through the D-030 pre-check for the target lang (doc context + user title, page places/dates,
known names, and names/numbers already in the input caption) plus `unchanged` / `not_shorter`; a failure gets
ONE retry carrying the issue codes, then `rewrite_unusable`. Refusal / max_tokens / transport codes pass through.
Each attempt is one `agent_steps` row (agent `rewriter`, stepKey `rewriter`, attempt 1|2) with instruction,
langs, lengths, memory keys and issue codes only — never caption text or notes (D-027).
Replay (`rewriter-replay.ts`) answers from tone pools in the target script, actually shorter for `shorter`.
The route (`/api/ai/rewrite`) owns limits: one `agent_runs` row per rewrite (trigger `rewrite`), only `ok` counts
(D-037 #6).

## Orchestrator (state machine)

```
queued → curating → storytelling → captioning → critiquing → (repairing) → validating → done
                         any state ──error/refusal/timeout──▶ fallback → done (with ai_status = 'partial')
```

- Runs inside API routes; the client polls `GET /api/ai/runs/[id]` (or Supabase Realtime) for live progress:
  "Looking at your photos 120/200 → Finding your moments → Writing captions → Final check".
- Each step is idempotent and checkpointed in the DB, so a crashed run resumes from the last completed step.
- Limits are checked before every call (free vs paid; see src/lib/ai/limits.ts).
- Repair is targeted: the Critic's issues are fixed by re-calling only the affected agent for the affected pages.

## Memory (two layers)

1. **Book memory** — the `agent_steps` outputs of this run (photo notes, plan) are reused on "Rebuild album",
   so rebuilding never re-analyses photos (saves ~70% of the cost).
2. **User memory** — `user_memory` table, injected into Storyteller / Caption Writer / Rewriter prompts:
   tone, caption length, fonts, language, names the user typed, things to avoid. Learned from what users
   change (e.g. they always shorten captions → `captionLength: short`). Users can view and clear it in Settings.

Privacy: memory never stores face data or guesses identities; only what the user typed or chose.

## Logging (observability)

Every agent call goes through one wrapper:

```ts
runAgentStep({ runId, agent: "curator", input, call: () => client.messages.parse(...) })
// → inserts agent_steps row: agent, status, input_summary, output, model, input/output tokens,
//   cost_usd, latency_ms, stop_reason, error
```

- `/admin/runs/[id]` page: timeline of every step of a build, its output and cost — answers
  "why did the AI do this?" and "what did this book cost?".
- Daily cost dashboard = sum of `agent_steps.cost_usd`.
- Users see a friendly version: tap a dropped photo → "Dropped: looks like a screenshot".

## Database additions

```
agent_runs   id, book_id, user_id, trigger ('build'|'rebuild'|'rewrite'), state, ai_status ('ok'|'partial'|'failed'),
             critic_score, total_cost_usd, started_at, finished_at
agent_steps  id, run_id, agent ('curator'|'storyteller'|'caption_writer'|'critic'|'rewriter'|'memory_keeper'),
             status ('ok'|'error'|'refused'|'skipped'), input_summary jsonb, output jsonb,
             model, input_tokens, output_tokens, cost_usd, latency_ms, stop_reason, error, created_at
user_memory  user_id (pk), prefs jsonb, updated_at
```
(`agent_steps` replaces the earlier `ai_usage` table.)

## Code layout

```
src/lib/ai/
  client.ts            Anthropic client, AI_MODEL, fallbacks config
  orchestrator.ts      state machine + resume logic
  run-step.ts          runAgentStep(): call + log + cost
  limits.ts            free / paid limits
  memory.ts            read/update user_memory
  agents/curator.ts  storyteller.ts  caption-writer.ts  critic.ts  rewriter.ts  memory-keeper.ts
  prompts/<agent>.ts   system prompts (stable, cached)
  schemas.ts           all zod schemas
  fallback.ts          rule-based album (wraps src/lib/autolayout.ts)
tests/ai/              fixture-based tests per agent + orchestrator (no live API calls)
```
