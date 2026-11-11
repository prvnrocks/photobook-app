// Read-only captions preview on the review screen (M4 T12). Collapsed by default via a native
// <details> disclosure (keyboard + screen-reader accessible, no client JS). Editing captions is
// M5 (editor); this only shows what the album will say.
// Receives a minimal projection of the doc (no photo ids / URLs).
import { ChevronDown } from "lucide-react";
import {
  captionSourceLabel,
  captionTextAttrs,
  captionsPreviewModel,
  missingCaptionsCopy,
  type CaptionsPreviewDoc,
} from "@/lib/review/ui";
import { cn } from "@/lib/utils";

type CaptionsPreviewProps = {
  preview: CaptionsPreviewDoc | null;
  /**
   * books.caption_lang — 'ar' books use the Arabic font (Cairo / Tajawal) throughout; lang="ar" is
   * set per text, only where the text is mainly Arabic script (captionTextAttrs). dir="auto" always.
   */
  captionLang: string;
};

export function CaptionsPreview({ preview, captionLang }: CaptionsPreviewProps) {
  const model = captionsPreviewModel(preview);
  if (!model) return null;

  return (
    <details className="group min-w-0 rounded-2xl border border-border bg-card shadow-card" data-testid="captions-preview">
      <summary
        className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 text-base font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
      >
        <span data-testid="captions-count">Captions ({model.count})</span>
        <ChevronDown aria-hidden className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
      </summary>

      <div className="flex min-w-0 flex-col gap-5 border-t border-border px-4 py-4">
        {model.missing > 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="captions-missing">
            {missingCaptionsCopy(model.missing)}
          </p>
        ) : null}

        {model.groups.map((group, gi) => (
          <section key={gi} className="flex min-w-0 flex-col gap-3" data-testid="captions-chapter">
            {group.title || group.dateLabel ? (
              <header className="min-w-0">
                {group.title ? <ChapterTitle title={group.title} captionLang={captionLang} /> : null}
                {group.dateLabel ? (
                  <p dir="auto" className="text-sm text-muted-foreground break-words">
                    {group.dateLabel}
                  </p>
                ) : null}
              </header>
            ) : null}
            <ul className="flex min-w-0 flex-col gap-3">
              {group.items.map((item, ii) => {
                const attrs = captionTextAttrs(item.text, captionLang);
                return (
                  <li key={ii} className="min-w-0 rounded-lg bg-secondary/60 px-3 py-2" data-testid="captions-item">
                    <p
                      dir="auto"
                      lang={attrs.lang}
                      className={cn("text-base break-words", attrs.arabicFont && "font-arabic")}
                      data-testid="captions-text"
                    >
                      {item.text}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground" data-testid={`captions-source-${item.source}`}>
                      {captionSourceLabel(item.source)}
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </details>
  );
}

function ChapterTitle({ title, captionLang }: { title: string; captionLang: string }) {
  const attrs = captionTextAttrs(title, captionLang);
  return (
    <h3
      dir="auto"
      lang={attrs.lang}
      className={cn("text-lg font-semibold break-words", attrs.arabicFont ? "font-arabic" : "font-display")}
    >
      {title}
    </h3>
  );
}
