import "server-only";
// The editor's "Rewrite story" (Task 8): rewrite ONE page text of a composed storybook through Task
// 6's rewriteNarrativeBlock, addressed by the text's `blockRef` (Task 7 keeps it on every AI text).
//
//   AI-written text  → rewriteNarrativeBlock stores a new story version in which only that block
//                      changed and returns the text; the editor applies it as ONE undo step.
//   user-written text → the user's words are first recorded in the story as a user edit (no model
//                      call), then rewritten as a PROPOSAL (nothing stored); the editor shows it
//                      with Accept / Discard and never overwrites the user's text on its own.
//
// Errors are StoryError codes (not_found, protected, limit_reached, budget_exhausted, ungrounded,
// ai_off, refused, model_error, invalid_instruction, usage_unavailable, conflict). Nothing here logs
// text or ids.

import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyBook } from "@/lib/db/books";
import { appendStorybookVersion, getCurrentStorybook } from "@/lib/db/storybooks";
import { userEdit } from "@/lib/storybook/versioning";
import type { Storybook } from "@/lib/storybook/types";
import { isUuid } from "@/lib/uuid";
import { rewriteNarrativeBlock, StoryError, type RewriteNarrativeInstruction, type RewriteNarrativeResult } from "./service";

export type RewritePageTextInput = {
  bookId: string;
  /** The page text's blockRef ("b12"). */
  blockRef: string;
  /** The text as it stands in the editor now. */
  text: string;
  /** Who wrote the editor's text: "user" → the answer is a proposal only. */
  source: "ai" | "user";
  instruction: RewriteNarrativeInstruction;
};

export type RewritePageTextResult = { text: string; lang: "en" | "ar"; proposal: boolean };

export type RewritePageTextDeps = {
  ownerOf?: (bookId: string) => Promise<string | null>;
  getCurrent?: typeof getCurrentStorybook;
  appendVersion?: typeof appendStorybookVersion;
  rewrite?: (blockId: string, instruction: RewriteNarrativeInstruction, opts: { bookId: string; propose: boolean }) => Promise<RewriteNarrativeResult>;
  now?: () => number;
};

async function defaultOwnerOf(bookId: string): Promise<string | null> {
  const [user, book] = await Promise.all([getCurrentUser(), getMyBook(bookId)]);
  return user && book ? user.id : null;
}

const BLOCK_RE = /^b[1-9]\d{0,3}$/;
const collapse = (t: string) => t.replace(/\s+/g, " ").trim();

export async function rewritePageText(input: RewritePageTextInput, deps: RewritePageTextDeps = {}): Promise<RewritePageTextResult> {
  if (!isUuid(input.bookId) || !BLOCK_RE.test(input.blockRef)) throw new StoryError("not_found");
  const userId = await (deps.ownerOf ?? defaultOwnerOf)(input.bookId);
  if (!userId) throw new StoryError("not_found");
  const rewrite = deps.rewrite ?? ((id, how, o) => rewriteNarrativeBlock(id, how, o));
  const ref = `${input.bookId}/${input.blockRef}`;

  let propose = input.source === "user";
  if (propose) {
    // Record the user's own words first, so the proposal rewrites what they see.
    const current = await (deps.getCurrent ?? getCurrentStorybook)(input.bookId, userId);
    const page = current?.pages.find((p) => p.blocks.some((b) => b.id === input.blockRef));
    const block = page?.blocks.find((b) => b.id === input.blockRef);
    if (!current || !page || !block) throw new StoryError("not_found");
    if (collapse(block.text) !== collapse(input.text) && collapse(input.text) !== "") {
      const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
      const next: Storybook = {
        ...current,
        version: current.version + 1,
        parentVersion: current.version,
        origin: "user",
        createdAt: nowIso,
        pages: current.pages.map((p) =>
          p.id !== page.id ? p : { ...p, blocks: p.blocks.map((b) => (b.id !== block.id ? b : { ...b, text: input.text.trim(), provenance: userEdit(b.provenance, nowIso) })) },
        ),
      };
      const outcome = await (deps.appendVersion ?? appendStorybookVersion)(next, userId).catch(() => "invalid" as const);
      if (outcome === "conflict") throw new StoryError("conflict", undefined, true);
      // an edit the story schema can't hold (e.g. far too long) → still propose from the stored text
    }
  }
  let result: RewriteNarrativeResult;
  try {
    result = await rewrite(ref, input.instruction, { bookId: input.bookId, propose });
  } catch (e) {
    // The editor showed AI text but the story already has the user's words there: propose instead.
    if (e instanceof StoryError && e.code === "protected" && !propose) {
      propose = true;
      result = await rewrite(ref, input.instruction, { bookId: input.bookId, propose });
    } else throw e;
  }
  return { text: result.proposal.text, lang: result.proposal.lang, proposal: propose || !result.stored };
}
