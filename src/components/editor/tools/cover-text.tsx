"use client";

// Cover title + subtitle editor (M5 Task 10). Opens when the cover text is tapped. setCover
// clips the title to 120 code points; the save route mirrors it to books.title (D-037 #7).

import { Heading } from "lucide-react";
import { useId, useState } from "react";
import { BOOK_TITLE_MAX_CODE_POINTS } from "@/lib/book/options";
import { setCover, SUBTITLE_MAX } from "@/lib/book/edit-ops";
import { captionInputLang } from "@/lib/editor/caption-tools";
import { codePointLength } from "@/lib/text/clip";
import type { EditorPanelProps, EditorTool } from "./types";

let sessionSeq = 0;

const inputClass =
  "min-h-11 w-full rounded-lg border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-primary";

function CoverTextPanel({ ctx }: EditorPanelProps) {
  const id = useId();
  const [session] = useState(() => ++sessionSeq);
  const { title, subtitle } = ctx.state.doc.cover;
  const lang = ctx.book.captionLang;

  return (
    <div className="flex flex-col gap-3" data-testid="cover-editor">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-title`} className="text-sm font-medium">
          Title
        </label>
        <input
          id={`${id}-title`}
          dir="auto"
          lang={captionInputLang(title, lang)}
          value={title}
          disabled={ctx.readOnly}
          placeholder="Book title"
          onChange={(e) =>
            ctx.actions.edit((d) => setCover(d, { title: e.target.value }), { coalesceKey: `cover-title:${session}` })
          }
          className={inputClass}
          data-testid="cover-title-input"
        />
        <p className="text-xs text-muted-foreground tabular-nums">
          {codePointLength(title)}/{BOOK_TITLE_MAX_CODE_POINTS}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-subtitle`} className="text-sm font-medium">
          Subtitle <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <input
          id={`${id}-subtitle`}
          dir="auto"
          lang={captionInputLang(subtitle, lang)}
          value={subtitle}
          maxLength={SUBTITLE_MAX}
          disabled={ctx.readOnly}
          placeholder="A date or a place"
          onChange={(e) =>
            ctx.actions.edit((d) => setCover(d, { subtitle: e.target.value }), { coalesceKey: `cover-subtitle:${session}` })
          }
          className={inputClass}
          data-testid="cover-subtitle-input"
        />
      </div>
    </div>
  );
}

export const coverTextTool: EditorTool = {
  id: "cover-text",
  label: "Title",
  icon: Heading,
  scopes: ["cover"],
  order: 50,
  tier: "primary",
  openOnSelect: true,
  panelTitle: "Cover title",
  isAvailable: (ctx) => ctx.state.selection?.kind === "cover" && ctx.state.selection.part === "text",
  Panel: CoverTextPanel,
};
