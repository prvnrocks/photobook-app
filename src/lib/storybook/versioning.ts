// Versioning of AI-generated content and user edits. Pure functions.
//
// Two levels:
//  - VERSION: one immutable snapshot of the whole storybook (a storybook_versions row). Every AI
//    run and every saved user editing session creates a new version; nothing is updated in place.
//  - PROVENANCE: per editable piece (title, narrative block) — who wrote the current text, how
//    often it changed, and which AI version last wrote it.
// Rule (CLAUDE.md, "AI drafts, the user decides"): an AI run never replaces user-written text or
// a user-locked page. `mergeAiDraft` is the one place that rule is applied.

import type { NarrativeBlock, Provenance, StoryPage, Storybook } from "./types";

export function aiProvenance(version: number): Provenance {
  return { source: "ai", rev: 1, aiVersion: version, editedAt: null };
}

/** Provenance after the user changed a piece (keeps the pointer to the last AI draft). */
export function userEdit(prev: Provenance | null, nowIso: string): Provenance {
  return { source: "user", rev: (prev?.rev ?? 0) + 1, aiVersion: prev?.aiVersion ?? null, editedAt: nowIso };
}

/** Provenance after an AI rewrite the user accepted for an AI-written piece. */
export function aiRewrite(prev: Provenance, version: number): Provenance {
  return { source: "ai", rev: prev.rev + 1, aiVersion: version, editedAt: null };
}

export function isUserOwned(p: Provenance): boolean {
  return p.source === "user";
}

/** A page the AI must not touch: locked by the user, or carrying any user-written block. */
export function isProtectedPage(page: StoryPage): boolean {
  return page.userLocked || page.blocks.some((b) => isUserOwned(b.provenance));
}

export function hasUserContent(s: Storybook): boolean {
  return (
    isUserOwned(s.title.provenance) ||
    (s.subtitle !== null && isUserOwned(s.subtitle.provenance)) ||
    s.chapters.some((c) => isUserOwned(c.title.provenance)) ||
    s.pages.some(isProtectedPage)
  );
}

export type MergeReport = {
  keptPages: string[];
  keptBlocks: string[];
  keptTitles: ("title" | "subtitle" | `chapter:${string}`)[];
  /** Protected pages of `current` that the draft no longer contains: carried over at the end of their chapter. */
  carriedPages: string[];
};

/**
 * Combine a fresh AI draft with the current storybook: the draft wins everywhere EXCEPT
 *  - pages the user locked or wrote on (kept whole, in the draft's position when the page id
 *    still exists, otherwise appended),
 *  - single user-written blocks on pages the draft also has (text kept, by block id),
 *  - user-written titles.
 * The result is a new version (current.version + 1, origin "merge") — or origin "ai" when
 * nothing had to be kept. The caller validates it with StorybookSchema before storing.
 */
export function mergeAiDraft(current: Storybook, draft: Storybook, nowIso: string): { storybook: Storybook; report: MergeReport } {
  const report: MergeReport = { keptPages: [], keptBlocks: [], keptTitles: [], carriedPages: [] };
  const version = current.version + 1;
  const currentPages = new Map(current.pages.map((p) => [p.id, p]));
  const currentBlocks = new Map<string, NarrativeBlock>();
  for (const p of current.pages) for (const b of p.blocks) currentBlocks.set(b.id, b);

  const draftPageIds = new Set(draft.pages.map((p) => p.id));
  const pages: StoryPage[] = draft.pages.map((dp) => {
    const cp = currentPages.get(dp.id);
    if (cp && isProtectedPage(cp)) {
      report.keptPages.push(cp.id);
      return cp;
    }
    const blocks = dp.blocks.map((db) => {
      const cb = currentBlocks.get(db.id);
      if (cb && isUserOwned(cb.provenance)) {
        report.keptBlocks.push(cb.id);
        return cb;
      }
      return db;
    });
    return { ...dp, blocks };
  });
  for (const cp of current.pages) {
    if (draftPageIds.has(cp.id) || !isProtectedPage(cp)) continue;
    report.carriedPages.push(cp.id);
    // after the last page of the same chapter, else at the end
    let at = -1;
    pages.forEach((p, i) => {
      if (p.chapterId === cp.chapterId) at = i;
    });
    if (at === -1) pages.push(cp);
    else pages.splice(at + 1, 0, cp);
  }

  const title = isUserOwned(current.title.provenance) ? (report.keptTitles.push("title"), current.title) : draft.title;
  const subtitle =
    current.subtitle !== null && isUserOwned(current.subtitle.provenance) ? (report.keptTitles.push("subtitle"), current.subtitle) : draft.subtitle;
  const currentChapters = new Map(current.chapters.map((c) => [c.id, c]));
  const chapters = draft.chapters.map((dc) => {
    const cc = currentChapters.get(dc.id);
    if (cc && isUserOwned(cc.title.provenance)) {
      report.keptTitles.push(`chapter:${cc.id}`);
      return { ...dc, title: cc.title };
    }
    return dc;
  });

  const keptAnything = report.keptPages.length + report.keptBlocks.length + report.keptTitles.length + report.carriedPages.length > 0;
  return {
    storybook: {
      ...draft,
      bookId: current.bookId,
      version,
      parentVersion: current.version,
      origin: keptAnything ? "merge" : "ai",
      title,
      subtitle,
      chapters,
      pages,
      createdAt: nowIso,
    },
    report,
  };
}
