// Which layouts show the chapter description (M30, D-090). Pure data query, client-safe.
//
// A "description layout" has a text panel bound to "chapterDescription" (magazine / editorial
// chapter openers and feature pages). With no description the panel is empty and several of these
// layouts leave a visible hole, so:
// - the rule-based album (no AI → no descriptions) never uses one (autolayout catalogueOf);
// - re-fits (Update album, photo delete, spread repair) prefer a layout without one unless the
//   page's chapter has a description that its current layout shows (bestPageLayout `description`);
// - the AI path may use them freely once the Caption Writer writes descriptions.
// The rule is this data query — never a list of layout ids.

import { getLayout } from "./index";
import type { Layout } from "@/lib/book/types";

/** True when `layout` has a text panel bound to the chapter description. */
export function layoutShowsDescription(layout: Pick<Layout, "texts"> | null | undefined): boolean {
  return layout?.texts?.some((t) => t.bind === "chapterDescription") === true;
}

/** layoutShowsDescription by layout id (unknown id → false). */
export function layoutIdShowsDescription(id: string | null | undefined): boolean {
  return typeof id === "string" && layoutShowsDescription(getLayout(id));
}

/** `layouts` without description layouts — or all of them when that would leave none. */
export function preferWithoutDescription<L extends Pick<Layout, "texts">>(layouts: readonly L[]): readonly L[] {
  const plain = layouts.filter((l) => !layoutShowsDescription(l));
  return plain.length > 0 ? plain : layouts;
}
