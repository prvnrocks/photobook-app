import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));

const { ReviewBody } = await import("@/components/review/ReviewBody");
const { albumEditedByUser, EDITED_ALBUM_COPY, editorHref } = await import("@/lib/review/ui");
const { devEditorData } = await import("@/lib/editor/dev-fixture");

const BOOK = "11111111-1111-4111-8111-111111111111";

function baseDoc() {
  return structuredClone(devEditorData("ok").doc);
}

describe("albumEditedByUser", () => {
  it("fresh / draft albums are not edited", () => {
    expect(albumEditedByUser({})).toBe(false);
    const d = baseDoc();
    d.meta = { generator: "ai", generatorVersion: 1, runId: null, userEdited: false };
    d.pages.forEach((p) => (p.caption = null));
    expect(albumEditedByUser(d)).toBe(false);
  });

  it("meta.userEdited (editor save) → edited", () => {
    const d = baseDoc();
    d.meta = { generator: "ai", generatorVersion: 1, runId: null, userEdited: true };
    expect(albumEditedByUser(d)).toBe(true);
  });

  it("any user caption → edited", () => {
    const d = baseDoc();
    d.meta = { generator: "rule", generatorVersion: 1, runId: null, userEdited: false };
    d.pages.forEach((p) => (p.caption = null));
    d.pages[0].caption = { text: "Our day", source: "user" } as (typeof d.pages)[number]["caption"];
    expect(albumEditedByUser(d)).toBe(true);
  });

  it("unparsable doc → edited (safe side)", () => {
    expect(albumEditedByUser({ pages: "nope" })).toBe(true);
  });

  it("editor href", () => {
    expect(editorHref(BOOK)).toBe(`/books/${BOOK}/edit`);
  });
});

function render(userEdited: boolean) {
  return renderToStaticMarkup(
    <ReviewBody
      bookId={BOOK}
      photos={[
        { id: "p1", status: "kept", dropReason: null, userOverride: false, dupGroup: null, width: 400, height: 300, thumbUrl: "https://x.test/p1" },
      ]}
      aiUsed
      toggle={async () => ({ ok: true })}
      updateAlbum={async () => ({ ok: true, changed: false, pages: 0 })}
      albumPhotoIds={["p1"]}
      userEdited={userEdited}
      building={false}
      rebuild={{ variant: "rebuild", rebuildsLeft: 2 }}
      confirm={async () => {}}
      empty={null}
    />,
  );
}

describe("ReviewBody edited state (D-037 #2)", () => {
  it("edited: editor callout + link, no Continue, no Rebuild", () => {
    const html = render(true);
    expect(html).toContain('data-testid="review-edited"');
    expect(html).toContain(EDITED_ALBUM_COPY.title.replace("'", "&#x27;"));
    expect(html).toMatch(new RegExp(`data-testid="review-open-editor" href="/books/${BOOK}/edit"`));
    expect(html).not.toContain('data-testid="review-continue"');
    expect(html).not.toContain("Rebuild");
    expect(html).not.toContain('data-testid="update-album-bar"');
    expect(html).toContain('data-testid="review-add-photos"');
  });

  it("not edited: Continue and Rebuild as before, no callout", () => {
    const html = render(false);
    expect(html).not.toContain('data-testid="review-edited"');
    expect(html).toContain('data-testid="review-continue"');
  });
});
