// Server-only editor class recipes (M22 review N3; lesson M21: shared recipe modules ship every
// export to the client, so recipes only server components use live here). Imported by server
// components only (EditorInvalid) — never from a "use client" module (tests/m22-editor-classes.test.ts
// checks). Plain strings, no imports; same rules as editor-classes.ts (44 px, no transforms, no gold).

/** Ivory/white card on the cream stage (the invalid-book screen) — the share card at editor density. */
export const ED_CARD =
  "rounded-3xl border border-[#e9dfca] bg-card p-4 shadow-[0_18px_40px_-28px_rgb(14_59_46/0.45)] sm:p-5";
