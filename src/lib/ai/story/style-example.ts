// Story v4: the ONE labelled style example the writer sees (structure and tone of a chapter story
// page), plus the lines of the user's reference mock-up. Pure, no imports.
//
// The example is deliberately about a different kind of memory than any test or eval book (a
// grandparent's garden), so it shows the SHAPE — a short title, an italic subtitle, a headline,
// one paragraph about meaning, a closing line — without handing the model content to reuse. The
// grounding check (grounding.ts exampleCopyIssue) rejects any line that reuses four or more words
// in a row of the example OR of the reference mock-up: the text must come from the book's own
// inputs, never from a template.

export const STYLE_EXAMPLE = {
  context: "Occasion: family. Relationship: my grandmother. Special memory: she showed us her garden one last summer before she moved. Photos: an older woman and two children among flower beds; a child with a watering can.",
  title: "The Last Garden Walk",
  subtitlePhrase: "One last summer there",
  headline: "One more walk through her garden.",
  body: "Before she moved, my grandmother walked us through her garden one last summer. Nothing about the afternoon was planned. She pointed out each bed, we followed, and the children carried the watering can from row to row, as if the garden would still need them tomorrow.",
  closing: "We left with soil on our hands.",
} as const;

/** The user's reference mock-up (2026-11-19) — never in a prompt; only guarded against verbatim reuse. */
export const REFERENCE_LINES: readonly string[] = [
  "Some moments are worth the wait.",
  "After so much time apart, we finally found ourselves together again in Dubai.",
  "There was no need for a grand occasion.",
  "Just the chance to spend time with my brother, share a coffee, and make another memory together.",
  "A simple day, made special by being together.",
  "A day worth remembering",
];

/** Every line a book's text may not copy (four words in a row or more). */
export const GUARDED_EXAMPLE_LINES: readonly string[] = [STYLE_EXAMPLE.headline, STYLE_EXAMPLE.body, STYLE_EXAMPLE.closing, STYLE_EXAMPLE.subtitlePhrase, STYLE_EXAMPLE.title, ...REFERENCE_LINES];
