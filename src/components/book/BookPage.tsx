// Milestone 5: the single shared page renderer. Editor, flipbook viewer and PDF (/print) all render
// through this component from the book document JSON. Placeholder until the doc types exist.

export type BookPageProps = {
  // Placeholder: replaced with the real book document + page types in a later milestone.
  doc?: unknown;
  pageIndex?: number;
  mode?: "edit" | "view" | "print";
};

export function BookPage(props: BookPageProps): null {
  void props;
  return null;
}
