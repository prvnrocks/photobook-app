"use client";

// AI caption menu (M5 Task 10, D-037 #1/#6). Sends the caption text on screen to
// POST /api/ai/rewrite (the server picks the target language), shows the result as a preview,
// and only "Use this" changes the doc — as a 'user' caption (setCaption), so it's undoable and
// never overwritten by AI later. The server's 429 is authoritative for the limit.

import { Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { setCaption } from "@/lib/book/edit-ops";
import { captionFontFamily } from "@/lib/book/fonts";
import {
  nextRewritesLeft,
  REWRITE_FAILURE_COPY,
  requestRewrite,
  rewriteOptions,
  sessionBlockFor,
  type RewriteInstruction,
  type RewriteUiState,
} from "@/lib/editor/caption-tools";
import { cn } from "@/lib/utils";
import type { EditorContextValue } from "../editor-context";
import { UpgradeSheet } from "../UpgradeSheet";
import { selectedCaptionPage } from "./caption-editor";
import type { EditorPanelProps, EditorTool } from "./types";

/** Static reason the menu can't be used right now, or null. */
export function aiMenuBlockedReason(ctx: Pick<EditorContextValue, "ai" | "state">, text: string): string | null {
  if (ctx.ai.mode === "off") return REWRITE_FAILURE_COPY.off;
  // A server answer earlier in this session (503 / auth / daily limit) switched ✨ off.
  if (ctx.ai.blocked) return REWRITE_FAILURE_COPY[ctx.ai.blocked];
  if (text.trim() === "") return "Write a caption first — AI can then rewrite it.";
  return null;
}

const PRIMARY_BTN =
  "flex min-h-11 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";

export function rewritesLeftLabel(left: number): string {
  return `${left} ${left === 1 ? "rewrite" : "rewrites"} left`;
}

function OptionButton({
  label,
  onClick,
  disabled,
  active,
  testId,
  hint,
}: {
  label: string;
  onClick(): void;
  disabled: boolean;
  active: boolean;
  testId: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={cn(
        "flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
        active && "border-primary",
      )}
      data-testid={testId}
    >
      {active ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
      {label}
    </button>
  );
}

export function AiCaptionPanel({ ctx }: EditorPanelProps) {
  const target = selectedCaptionPage(ctx);
  const [ui, setUi] = useState<RewriteUiState>({ kind: "idle" });
  const [last, setLast] = useState<RewriteInstruction | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);

  if (!target) return null;
  const { page } = target;
  const text = page.caption?.text ?? "";
  const blocked = ctx.readOnly ? "Editing is paused." : aiMenuBlockedReason(ctx, text);
  const loading = ui.kind === "loading";
  const limitReached = ui.kind === "limit" || ctx.ai.rewritesLeft <= 0;
  const options = rewriteOptions(text);

  const run = async (instruction: RewriteInstruction) => {
    if (loading || blocked) return;
    setLast(instruction);
    setUi({ kind: "loading", instruction });
    // Not aborted when the panel closes: a finished rewrite is counted by the server either way,
    // so the counter below must still update.
    const result = await requestRewrite({ bookId: ctx.book.id, pageId: page.id, instruction, text });
    if (result.kind === "preview") {
      ctx.ai.setRewrites(ctx.ai.rewritesUsed + 1, nextRewritesLeft(ctx.ai.rewritesLeft, result.remaining));
    } else if (result.kind === "limit") {
      ctx.ai.setRewrites(ctx.ai.rewritesUsed, 0);
    }
    const block = sessionBlockFor(result.kind);
    if (block) {
      // Shown by the blocked view (all options disabled) for the rest of the session.
      ctx.ai.blockSession?.(block);
      setUi({ kind: "idle" });
      return;
    }
    setUi(result);
  };

  const useThis = () => {
    if (ui.kind !== "preview") return;
    const accepted = ui.text;
    // Pages may have moved while waiting: find the page by id.
    ctx.actions.edit((d) => {
      const idx = d.pages.findIndex((p) => p.id === page.id);
      return idx < 0 ? d : setCaption(d, idx, accepted, { captionLang: ctx.book.captionLang });
    });
    setUi({ kind: "idle" });
    ctx.openTool("caption");
  };

  if (blocked) {
    return (
      <div className="flex flex-col gap-3" data-testid="ai-caption-menu" data-state="blocked">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ai-caption-blocked">
          <Sparkles className="size-4 shrink-0" aria-hidden="true" />
          {blocked}
        </p>
        <div className="grid grid-cols-2 gap-2 opacity-60">
          {options.main.map((o) => (
            <OptionButton key={o.instruction} label={o.label} onClick={() => {}} disabled active={false} testId={`ai-option-${o.instruction}`} />
          ))}
        </div>
      </div>
    );
  }

  if (ui.kind === "preview") {
    const lang = ui.lang === "ar" ? "ar" : "en";
    return (
      <div className="flex flex-col gap-3" data-testid="ai-caption-menu" data-state="preview">
        <p className="text-xs font-medium text-muted-foreground">AI suggestion</p>
        <p
          dir="auto"
          lang={lang}
          className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-base leading-snug break-words whitespace-pre-line"
          style={{ fontFamily: captionFontFamily(lang === "ar" ? "Cairo" : "Playfair") }}
          data-testid="ai-preview"
        >
          {ui.text}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={useThis}
            className={PRIMARY_BTN}
            data-testid="ai-use-this"
          >
            Use this
          </button>
          <button
            type="button"
            onClick={() => setUi({ kind: "idle" })}
            className="flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="ai-keep-mine"
          >
            Keep mine
          </button>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="ai-rewrites-left">
          {rewritesLeftLabel(ctx.ai.rewritesLeft)}
        </p>
      </div>
    );
  }

  const failure = ui.kind !== "idle" && ui.kind !== "loading" ? ui.kind : null;
  const disabled = loading || limitReached;
  const shortHint = options.main.find((o) => o.instruction === "shorter")?.disabledReason ?? null;

  return (
    <div className="flex flex-col gap-3" data-testid="ai-caption-menu" data-state={ui.kind}>
      {failure && failure !== "limit" ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-sm text-foreground" data-testid="ai-caption-message">
          <p className="flex-1">{REWRITE_FAILURE_COPY[failure]}</p>
          {last && (failure === "retry" || failure === "serverBusy" || failure === "error" || failure === "busy") && !limitReached ? (
            <button
              type="button"
              onClick={() => void run(last)}
              className="min-h-11 rounded-lg border border-warning-border bg-card px-3 font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="ai-try-again"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {limitReached ? (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-secondary px-3 py-2 text-sm" data-testid="ai-caption-limit">
          <p className="font-medium">{REWRITE_FAILURE_COPY.limit}</p>
          {!ctx.book.isPaid && !showUpgrade ? (
            <button
              type="button"
              onClick={() => setShowUpgrade(true)}
              className={cn(PRIMARY_BTN, "mt-1")}
              data-testid="ai-upgrade"
            >
              Upgrade
            </button>
          ) : null}
        </div>
      ) : null}
      {limitReached && showUpgrade ? <UpgradeSheet reason="rewrites" ctx={ctx} /> : null}
      <div className="grid grid-cols-2 gap-2">
        {options.main.map((o) => (
          <OptionButton
            key={o.instruction}
            label={o.label}
            onClick={() => void run(o.instruction)}
            disabled={disabled || o.disabledReason !== undefined}
            active={loading && ui.instruction === o.instruction}
            testId={`ai-option-${o.instruction}`}
            hint={o.disabledReason}
          />
        ))}
      </div>
      {shortHint && failure !== "tooShort" ? (
        <p className="-mt-1 text-xs text-muted-foreground" data-testid="ai-shorter-hint">
          {shortHint}
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">Change tone</p>
        <div className="grid grid-cols-2 gap-2">
          {options.tones.map((o) => (
            <OptionButton
              key={o.instruction}
              label={o.label}
              onClick={() => void run(o.instruction)}
              disabled={disabled}
              active={loading && ui.instruction === o.instruction}
              testId={`ai-option-${o.instruction.replace(":", "-")}`}
            />
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="ai-rewrites-left" aria-live="polite">
        {loading ? "Writing… this can take up to a minute." : rewritesLeftLabel(ctx.ai.rewritesLeft)}
      </p>
    </div>
  );
}

export const aiCaptionTool: EditorTool = {
  id: "ai-caption",
  // M11: the Sparkles icon carries the "magic"; no emoji in the label (matches the other tools).
  label: "AI",
  icon: Sparkles,
  scopes: ["caption"],
  order: 31,
  panelTitle: "AI caption help",
  Panel: AiCaptionPanel,
};
