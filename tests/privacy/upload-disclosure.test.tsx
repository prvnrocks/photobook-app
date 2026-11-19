// Task 9: privacy + AI processing disclosure in the upload flow, the privacy page section, and the
// share page's "Turn off and make a new link" option.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DangerZone } from "@/components/publish/DangerZone";
import { UploadPrivacyNote } from "@/components/upload/UploadPrivacyNote";
import { UPLOAD_PRIVACY_NOTE } from "@/lib/legal/upload-disclosure";
import { StoryPreviewBanner } from "@/components/editor/StoryPreviewBanner";
import PrivacyPage from "@/app/(marketing)/privacy/page";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

describe("upload privacy note", () => {
  it("says photos are private, a reduced copy goes to Anthropic's Claude, not used for training, and links to the privacy page", () => {
    const html = renderToStaticMarkup(<UploadPrivacyNote />);
    expect(html).toContain('data-testid="upload-privacy-note"');
    expect(html).toContain(esc(UPLOAD_PRIVACY_NOTE.privateLine));
    expect(html).toContain(esc(UPLOAD_PRIVACY_NOTE.aiLine));
    expect(UPLOAD_PRIVACY_NOTE.aiLine).toMatch(/smaller copy/);
    expect(UPLOAD_PRIVACY_NOTE.aiLine).toMatch(/Anthropic's Claude/);
    expect(UPLOAD_PRIVACY_NOTE.aiLine).toMatch(/isn't used to train/);
    expect(UPLOAD_PRIVACY_NOTE.aiLine).toMatch(/without location data/);
    expect(html).toContain('href="/privacy#ai"');
  });

  it("with AI off it only says the photos are private (no AI claim)", () => {
    const html = renderToStaticMarkup(<UploadPrivacyNote aiOn={false} />);
    expect(html).not.toContain("Anthropic");
    expect(html).toContain(esc(UPLOAD_PRIVACY_NOTE.privateLine));
  });

  it("is used on both upload screens (wizard step and classic upload page)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/components/books/wizard/steps/StepPhotos.tsx", "src/app/books/[id]/upload/page.tsx"]) expect(readFileSync(f, "utf8")).toContain("<UploadPrivacyNote");
  });

  it("the privacy page explains story processing, provider retention without ZDR, deletion and its exceptions, and link revocation", () => {
    const html = renderToStaticMarkup(<PrivacyPage />);
    expect(html).toContain('id="ai"');
    expect(html).toContain('data-testid="privacy-ai-story"');
    expect(html).toContain('data-testid="privacy-ai-retention"');
    expect(html).toMatch(/not arranged zero data retention/);
    expect(html).toMatch(/backups held by our\s+hosting provider/);
    expect(html).toMatch(/Turn off and make a new link/);
  });
});

describe("share page: revocable link", () => {
  it("the confirm step offers 'Turn off and make a new link' when the action is wired", () => {
    const html = renderToStaticMarkup(<DangerZone isPaid={false} confirming onConfirmChange={() => {}} onUnpublish={() => {}} onResetLink={() => {}} busy={false} locked={false} />);
    expect(html).toContain('data-testid="reset-link-button"');
    expect(html).toContain("Turn off and make a new link");
    const without = renderToStaticMarkup(<DangerZone isPaid={false} confirming onConfirmChange={() => {}} onUnpublish={() => {}} busy={false} locked={false} />);
    expect(without).not.toContain("reset-link-button");
  });
});

describe("editor preview banner", () => {
  it("locked: page count + AED 39 unlock button; complete: Complete my book", () => {
    const locked = renderToStaticMarkup(<StoryPreviewBanner state={{ kind: "locked", pages: 5 }} onUnlock={() => {}} onComplete={() => {}} />);
    expect(locked).toContain("This is a 5-page preview.");
    expect(locked).toContain("Unlock the full book — AED 39");
    expect(locked).toContain('data-testid="story-unlock-button"');
    const done = renderToStaticMarkup(<StoryPreviewBanner state={{ kind: "complete" }} onUnlock={() => {}} onComplete={() => {}} />);
    expect(done).toContain('data-testid="story-complete-button"');
    expect(done).toContain("Complete my book");
  });
});
