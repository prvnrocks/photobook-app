// Task 9: privacy + AI processing disclosure beside the upload (no hooks: renders on the server or
// inside a client island). 375 px first: a small lock line, one short paragraph, one link.

import { Lock } from "lucide-react";
import { UPLOAD_PRIVACY_NOTE } from "@/lib/legal/upload-disclosure";

export function UploadPrivacyNote({ aiOn = true }: { aiOn?: boolean }) {
  return (
    <aside className="mt-4 mb-2 flex gap-2.5 rounded-2xl border border-[#e2d7c1] bg-[#fbf8f1] p-3 text-start" data-testid="upload-privacy-note" aria-label="Privacy">
      <Lock className="mt-0.5 size-4 shrink-0 text-[#0E3B2E]" aria-hidden="true" />
      <div className="min-w-0 type-small text-muted-foreground">
        <p className="font-medium text-foreground">{UPLOAD_PRIVACY_NOTE.privateLine}</p>
        {aiOn ? <p className="mt-1">{UPLOAD_PRIVACY_NOTE.aiLine}</p> : null}
        <a href={UPLOAD_PRIVACY_NOTE.href} className="mt-1 inline-block font-medium text-[#0E3B2E] underline underline-offset-2" data-testid="upload-privacy-link">
          {UPLOAD_PRIVACY_NOTE.linkText}
        </a>
      </div>
    </aside>
  );
}
