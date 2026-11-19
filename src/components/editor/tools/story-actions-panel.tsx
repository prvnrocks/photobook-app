"use client";

// The Story actions sheet (Task 8, lazy chunk): the simple storybook actions in one place — bottom
// sheet on phones, side panel / rail on desktop (the editor's normal panel host).
//   Rewrite story     selected page text → Shorter / Longer / Simpler / Write it again / a tone.
//                     AI text: applied as ONE undo step. The user's own text: a proposal with Accept /
//                     Discard — never replaced on its own.
//   Change photo      selected photo → the existing Replace panel (re-lays the page out if needed)
//   Regenerate page   a fresh template for the page shown, same photos / crops / words (one undo step)
//   View chapters     chapters with page ranges; tap to jump
//   Things to check   the composer's checks (text too long → a shorter rewrite; photo cropped hard /
//                     too few pixels → change photo), dismissible
//   Regenerate story  (secondary) the whole job again — the user's edits stay (Task 6 / 7 merges)
// Every button is disabled while a request runs (no duplicate requests from repeated taps).

import { BookOpen, ChevronLeft, ImageIcon, LayoutTemplate, PenLine, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import type { BookDesign } from "@/lib/book/book-design";
import { cx } from "@/lib/cx";
import { REWRITE_OPTIONS, TONE_OPTIONS, chapterRanges, regeneratablePage, requestStoryRewrite, selectedSlot, selectedStoryText, type RewriteChoice } from "@/lib/editor/story-actions";
import { applyStoryText, pageLayoutIssues, regeneratePageLayout, type PageIssue } from "@/lib/storybook/compose/regenerate-page";
import { showEditorToast } from "../EditorToast";
import type { EditorContextValue } from "../editor-context";
import { TOOL_HINT, TOOL_OPTION, TOOL_SECONDARY, TOOL_WELL } from "./tool-classes";
import type { EditorPanelProps } from "./types";

export const PHOTO_PICKER_ID = "replace";

type View = "menu" | "rewrite" | "chapters" | "regen";

const ROW = cx(TOOL_OPTION, "flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left");

function langOf(ctx: EditorContextValue): "en" | "ar" {
  return ctx.book.captionLang === "ar" ? "ar" : "en";
}

function designOf(ctx: EditorContextValue): BookDesign {
  return { format: ctx.state.doc.format, designStyle: ctx.state.doc.style.designStyle ?? "classic" };
}

const ISSUE_COPY: Record<PageIssue["kind"], string> = {
  text_overflow: "the text is too long for its space",
  crop_excessive: "a photo is cropped a lot",
  dpi_too_low: "a photo may print blurry",
};

export function StoryActionsPanel({ ctx, close }: EditorPanelProps) {
  const [view, setView] = useState<View>("menu");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ pageIdx: number; panel: number; text: string; lang: "en" | "ar" } | null>(null);
  const [checksHidden, setChecksHidden] = useState(false);
  const { state, actions } = ctx;
  const storyText = selectedStoryText(state);
  const slot = selectedSlot(state.selection);
  const pageIdx = regeneratablePage(state.doc, state.page);
  const chapters = useMemo(() => chapterRanges(state.doc), [state.doc]);
  const issues = useMemo(() => pageLayoutIssues(state.doc, ctx.photos.byId, langOf(ctx)), [state.doc, ctx]);
  const readOnly = ctx.readOnly;
  const aiOn = ctx.ai.mode !== "off";

  async function rewrite(choice: RewriteChoice, target = storyText) {
    if (busy || !target || readOnly) return;
    setBusy(true);
    setMessage(null);
    setProposal(null);
    const out = await requestStoryRewrite(ctx.book.id, { blockRef: target.text.blockRef!, text: target.text.text, source: target.text.source, choice });
    setBusy(false);
    if (out.kind === "error") return setMessage(out.message);
    if (out.proposal) return setProposal({ pageIdx: target.pageIdx, panel: target.panel, text: out.text, lang: out.lang });
    actions.edit((d) => applyStoryText(d, target.pageIdx, target.panel, out.text, "ai", { lang: langOf(ctx), photos: ctx.photos.byId }), { select: { kind: "text", pageIdx: target.pageIdx, panel: target.panel } });
    showEditorToast({ message: "Text rewritten", action: { label: "Undo", run: actions.undo }, dismissOnEdit: true });
  }

  function acceptProposal() {
    if (!proposal || readOnly) return;
    const p = proposal;
    actions.edit((d) => applyStoryText(d, p.pageIdx, p.panel, p.text, "user", { lang: langOf(ctx), photos: ctx.photos.byId }), { select: { kind: "text", pageIdx: p.pageIdx, panel: p.panel } });
    setProposal(null);
    showEditorToast({ message: "New text in place", action: { label: "Undo", run: actions.undo }, dismissOnEdit: true });
  }

  function regeneratePage(idx: number | null = pageIdx) {
    if (idx === null || readOnly || busy) return;
    const r = regeneratePageLayout(state.doc, idx, { design: designOf(ctx), lang: langOf(ctx), photos: ctx.photos.byId });
    if (!r.ok) return setMessage(r.reason === "no_alternative" ? "This page already has the only layout that fits its photos and words." : "This page can't be re-arranged.");
    setMessage(null);
    actions.edit(() => r.doc, { goTo: idx });
    showEditorToast({ message: `New layout for page ${idx + 1}`, action: { label: "Undo", run: actions.undo }, dismissOnEdit: true });
  }

  function changePhoto(target: { pageIdx: number; slotIdx: number } | null = slot) {
    if (!target || readOnly) return;
    actions.select({ kind: "slot", pageIdx: target.pageIdx, slotIdx: target.slotIdx });
    ctx.openTool(PHOTO_PICKER_ID);
  }

  function fixIssue(issue: PageIssue) {
    if (issue.kind === "text_overflow") {
      const text = state.doc.pages[issue.pageIdx]?.texts?.find((t) => t.panel === (issue.panel ?? -1));
      if (!text || !text.blockRef) {
        actions.goTo(issue.pageIdx);
        return setMessage("Tap the text on this page to shorten it.");
      }
      actions.select({ kind: "text", pageIdx: issue.pageIdx, panel: text.panel });
      void rewrite({ kind: "shorter" }, { pageIdx: issue.pageIdx, panel: text.panel, text });
      return;
    }
    changePhoto({ pageIdx: issue.pageIdx, slotIdx: issue.slot ?? 0 });
  }

  if (view === "regen") {
    return (
      <div className="flex flex-col gap-3" data-testid="story-regen-confirm">
        <BackButton onClick={() => setView("menu")} />
        <p className="type-small text-foreground">Write the story again from your photos? Text, photos and crops you changed stay exactly as they are.</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={TOOL_SECONDARY}
            disabled={readOnly || busy}
            onClick={() => {
              ctx.storyRegen?.open();
              close();
            }}
            data-testid="story-regen-start"
          >
            <RefreshCw className="size-4" aria-hidden="true" /> Regenerate story
          </button>
          <button type="button" className={TOOL_SECONDARY} onClick={() => setView("menu")} data-testid="story-regen-cancel">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (view === "chapters") {
    return (
      <div className="flex flex-col gap-2" data-testid="story-chapters">
        <BackButton onClick={() => setView("menu")} />
        {chapters.length === 0 ? <p className={TOOL_HINT}>This book has no chapters yet.</p> : null}
        <ol className="flex flex-col gap-2" aria-label="Chapters">
          {chapters.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                className={ROW}
                onClick={() => {
                  actions.goTo(c.firstIdx);
                  close();
                }}
                data-testid={`story-chapter-${c.id}`}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#e6efe9] text-sm font-semibold tabular-nums" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-semibold break-words" dir="auto">
                    {c.title || `Chapter ${i + 1}`}
                  </span>
                  <span className={TOOL_HINT}>{c.from === c.to ? `Page ${c.from}` : `Pages ${c.from}–${c.to}`}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <p className={TOOL_HINT}>To rename a chapter, tap a photo in it and choose Chapter.</p>
      </div>
    );
  }

  if (view === "rewrite") {
    return (
      <div className="flex flex-col gap-3" data-testid="story-rewrite">
        <BackButton onClick={() => setView("menu")} />
        {storyText ? (
          <>
            <p className={cx(TOOL_WELL, "type-small line-clamp-4 text-foreground")} dir="auto" data-testid="story-rewrite-current">
              {storyText.text.text}
            </p>
            {storyText.text.source === "user" ? <p className={TOOL_HINT}>These are your own words — we&rsquo;ll suggest a version and you decide.</p> : null}
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="How to rewrite">
              {REWRITE_OPTIONS.map((o) => (
                <button key={o.kind} type="button" className={cx(TOOL_OPTION, "min-h-11 px-3 text-sm font-semibold")} disabled={busy || readOnly} onClick={() => void rewrite({ kind: o.kind })} data-testid={`story-rewrite-${o.kind}`}>
                  {o.label}
                </button>
              ))}
            </div>
            <p className="text-sm font-semibold text-[#0e3b2e]" id="story-tone-label">
              Tone
            </p>
            <div className="grid grid-cols-3 gap-2" role="group" aria-labelledby="story-tone-label">
              {TONE_OPTIONS.map((o) => (
                <button key={o.tone} type="button" className={cx(TOOL_OPTION, "min-h-11 px-2 text-sm font-semibold")} disabled={busy || readOnly} onClick={() => void rewrite({ kind: "tone", tone: o.tone })} data-testid={`story-tone-${o.tone}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className={TOOL_HINT}>Tap a story text on the page first.</p>
        )}
        {busy ? (
          <p className={TOOL_HINT} role="status">
            Writing…
          </p>
        ) : null}
        {proposal ? <Proposal proposal={proposal} onAccept={acceptProposal} onDiscard={() => setProposal(null)} disabled={readOnly} /> : null}
        {message ? (
          <p className="type-small text-destructive" role="alert" data-testid="story-action-message">
            {message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="story-actions">
      {issues.length > 0 && !checksHidden ? (
        <section className={cx(TOOL_WELL, "flex flex-col gap-2")} aria-labelledby="story-checks-title" data-testid="story-checks">
          <div className="flex items-center justify-between gap-2">
            <h3 id="story-checks-title" className="text-sm font-semibold text-[#0e3b2e]">
              Things to check ({issues.length})
            </h3>
            <button type="button" className="min-h-11 rounded-full px-3 text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground" onClick={() => setChecksHidden(true)} data-testid="story-checks-dismiss">
              Hide
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {issues.slice(0, 5).map((issue, i) => (
              <li key={`${issue.pageIdx}-${issue.kind}-${i}`} className="flex items-center gap-2">
                <span className="type-small min-w-0 flex-1 text-foreground">
                  Page {issue.pageIdx + 1}: {ISSUE_COPY[issue.kind]}
                </span>
                <button type="button" className={TOOL_SECONDARY} disabled={busy || readOnly} onClick={() => fixIssue(issue)} data-testid={`story-check-fix-${i}`}>
                  {issue.kind === "text_overflow" ? "Shorten" : "Change photo"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ul className="flex flex-col gap-2" aria-label="Story actions">
        <ActionRow icon={PenLine} label="Rewrite story" hint={storyText ? "Shorter, longer, simpler or another tone for the selected text" : "Tap a story text on the page first"} disabled={!storyText || readOnly || !aiOn} onClick={() => setView("rewrite")} testId="story-action-rewrite" />
        <ActionRow icon={ImageIcon} label="Change photo" hint={slot ? "Swap the selected photo; the page re-arranges if it needs to" : "Tap a photo on the page first"} disabled={!slot || readOnly} onClick={() => changePhoto()} testId="story-action-photo" />
        <ActionRow icon={LayoutTemplate} label="Regenerate page" hint={pageIdx !== null ? `A fresh layout for page ${pageIdx + 1} — same photos and words` : "Go to a story page first"} disabled={pageIdx === null || readOnly} onClick={() => regeneratePage()} testId="story-action-page" />
        <ActionRow icon={BookOpen} label="View chapters" hint={chapters.length ? `${chapters.length} ${chapters.length === 1 ? "chapter" : "chapters"}` : "No chapters yet"} disabled={chapters.length === 0} onClick={() => setView("chapters")} testId="story-action-chapters" />
      </ul>

      {message ? (
        <p className="type-small text-destructive" role="alert" data-testid="story-action-message">
          {message}
        </p>
      ) : null}
      {proposal ? <Proposal proposal={proposal} onAccept={acceptProposal} onDiscard={() => setProposal(null)} disabled={readOnly} /> : null}

      {aiOn && ctx.storyRegen ? (
        <button type="button" className={cx(TOOL_SECONDARY, "self-start")} disabled={readOnly || busy} onClick={() => setView("regen")} data-testid="story-action-regen">
          <RefreshCw className="size-4" aria-hidden="true" /> Regenerate story
        </button>
      ) : null}
    </div>
  );
}

function ActionRow({ icon: Icon, label, hint, disabled, onClick, testId }: { icon: typeof PenLine; label: string; hint: string; disabled: boolean; onClick: () => void; testId: string }) {
  return (
    <li>
      <button type="button" className={ROW} disabled={disabled} onClick={onClick} data-testid={testId}>
        <Icon className="size-5 shrink-0" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">{label}</span>
          <span className={TOOL_HINT}>{hint}</span>
        </span>
      </button>
    </li>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="inline-flex min-h-11 items-center gap-1 self-start rounded-full pr-3 text-sm font-semibold text-[#0e3b2e] hover:underline" onClick={onClick} data-testid="story-back">
      <ChevronLeft className="size-4" aria-hidden="true" /> Story actions
    </button>
  );
}

function Proposal({ proposal, onAccept, onDiscard, disabled }: { proposal: { text: string; lang: "en" | "ar" }; onAccept: () => void; onDiscard: () => void; disabled: boolean }) {
  return (
    <section className={cx(TOOL_WELL, "flex flex-col gap-2")} aria-label="Suggested text" data-testid="story-proposal">
      <p className="text-xs font-semibold text-accent-text">Suggestion — your text stays until you accept</p>
      <p className="type-small text-foreground" dir="auto" lang={proposal.lang} data-testid="story-proposal-text">
        {proposal.text}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={TOOL_SECONDARY} onClick={onAccept} disabled={disabled} data-testid="story-proposal-accept">
          Use this
        </button>
        <button type="button" className={TOOL_SECONDARY} onClick={onDiscard} data-testid="story-proposal-discard">
          Keep mine
        </button>
      </div>
    </section>
  );
}
