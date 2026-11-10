import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { EditorContextValue } from "@/components/editor/editor-context";
import { aiCaptionTool, aiMenuBlockedReason, rewritesLeftLabel } from "@/components/editor/tools/ai-caption";
import { captionEditorTool, captionStyleTool } from "@/components/editor/tools/caption-editor";
import { chapterTitleTool, currentChapter } from "@/components/editor/tools/chapter-title";
import { coverTextTool } from "@/components/editor/tools/cover-text";
import { autoOpenTool, visibleTools } from "@/components/editor/tools/registry";
import type { EditorTool } from "@/components/editor/tools/types";
import { EditablePage } from "@/components/editor/EditablePage";
import { EditorContext } from "@/components/editor/editor-context";
import { detectCaptionLang, translateTarget } from "@/lib/ai/agents/rewriter";
import { REWRITE_INSTRUCTIONS } from "@/lib/ai/schemas";
import { setCover } from "@/lib/book/edit-ops";
import {
  captionInputLang,
  captionLengthInfo,
  captionScript,
  countWords,
  nextRewritesLeft,
  REWRITE_FAILURE_COPY,
  REWRITE_FETCH_TIMEOUT_MS,
  requestRewrite,
  rewriteOptions,
  rewriteResponseState,
  translateLabel,
} from "@/lib/editor/caption-tools";
import { devEditorData, type DevAiMode } from "@/lib/editor/dev-fixture";
import { initEditorState, type EditorSelection } from "@/lib/editor/store";
import type { EditorShellData } from "@/lib/editor/types";

describe("caption length helpers", () => {
  it("counts words in Latin, Arabic and mixed text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("Sunset at the corniche")).toBe(4);
    expect(countWords("  two\n\nwords  ")).toBe(2);
    expect(countWords("غروب الشمس على الكورنيش")).toBe(4);
    expect(countWords("Eid مبارك 🎉")).toBe(3);
  });

  it("soft hint past 18 words, hard cap at 200 units", () => {
    const w18 = Array.from({ length: 18 }, () => "word").join(" ");
    expect(captionLengthInfo(w18).long).toBe(false);
    expect(captionLengthInfo(`${w18} more`).long).toBe(true);
    expect(captionLengthInfo("a".repeat(200)).full).toBe(true);
    expect(captionLengthInfo("a".repeat(199)).full).toBe(false);
    expect(captionLengthInfo("one").label).toBe("1 word · 3/200");
    expect(captionLengthInfo("two words").label).toBe("2 words · 9/200");
  });

  it("caption input lang", () => {
    expect(captionInputLang("مرحبا", "en")).toBe("ar");
    expect(captionInputLang("Hello", "ar")).toBe("en");
    expect(captionInputLang("🎉 2024", "ar")).toBe("ar");
    expect(captionInputLang("", "en")).toBe("en");
  });
});

describe("✨ rewrite helpers", () => {
  const samples = ["Sunset walk", "غروب الشمس", "Eid مبارك يا أهل", "Love you Mama ❤ حبيبتي", "🎉 2024", ""];

  it("script detection and translate label match the server's target", () => {
    for (const t of samples) {
      expect(captionScript(t)).toBe(detectCaptionLang(t));
      expect(translateLabel(t)).toBe(translateTarget(t) === "ar" ? "Translate to Arabic" : "Translate to English");
    }
    expect(translateLabel("غروب الشمس")).toBe("Translate to English");
    expect(translateLabel("Sunset")).toBe("Translate to Arabic");
  });

  it("menu options are exactly the server's instructions", () => {
    const o = rewriteOptions("Hi");
    const all = [...o.main, ...o.tones].map((x) => x.instruction).sort();
    expect(all).toEqual([...REWRITE_INSTRUCTIONS].sort());
    expect(o.tones.map((t) => t.label)).toEqual(["Romantic", "Fun", "Nostalgic", "Minimal"]);
  });

  it("maps every route response to a UI state", () => {
    const i = "rewrite" as const;
    expect(rewriteResponseState(200, { text: "New one", lang: "en", remaining: 7 }, i)).toEqual({
      kind: "preview",
      text: "New one",
      lang: "en",
      remaining: 7,
      instruction: i,
    });
    expect(rewriteResponseState(200, { text: "جديد", lang: "ar", remaining: null }, i)).toMatchObject({ lang: "ar", remaining: null });
    expect(rewriteResponseState(200, { text: "  " }, i).kind).toBe("unusable");
    expect(rewriteResponseState(200, null, i).kind).toBe("unusable");
    expect(rewriteResponseState(503, { error: "ai_off" }, i).kind).toBe("off");
    expect(rewriteResponseState(429, { error: "limit", remaining: 0 }, i).kind).toBe("limit");
    expect(rewriteResponseState(409, { error: "already_running" }, i).kind).toBe("busy");
    expect(rewriteResponseState(401, { error: "unauthenticated" }, i).kind).toBe("signedOut");
    expect(rewriteResponseState(502, { error: "refusal", retryable: false }, i).kind).toBe("refused");
    expect(rewriteResponseState(502, { error: "rewrite_unusable", retryable: false }, i).kind).toBe("unusable");
    expect(rewriteResponseState(502, { error: "timeout", retryable: true }, i).kind).toBe("retry");
    expect(rewriteResponseState(502, { error: "max_tokens", retryable: false }, i).kind).toBe("unusable");
    expect(rewriteResponseState(504, null, i).kind).toBe("retry");
    expect(rewriteResponseState(500, { error: "server_error" }, i).kind).toBe("error");
    expect(rewriteResponseState(400, { error: "invalid_body" }, i).kind).toBe("error");
  });

  it("copy for the required states", () => {
    expect(REWRITE_FAILURE_COPY.off).toBe("AI captions aren't switched on yet");
    expect(REWRITE_FAILURE_COPY.limit).toBe("No AI rewrites left on this book");
    expect(REWRITE_FAILURE_COPY.busy).toMatch(/^One rewrite at a time/);
    expect(REWRITE_FAILURE_COPY.retry).toMatch(/Try again/);
    expect(REWRITE_FAILURE_COPY.unusable).toBe("Couldn't improve this one — try another option");
    expect(REWRITE_FAILURE_COPY.refused).toBe("Can't rewrite this caption");
    expect(rewritesLeftLabel(1)).toBe("1 rewrite left");
    expect(rewritesLeftLabel(19)).toBe("19 rewrites left");
  });

  it("rewrites left: server remaining wins, else previous − 1 (never negative)", () => {
    expect(nextRewritesLeft(10, 4)).toBe(4);
    expect(nextRewritesLeft(10, null)).toBe(9);
    expect(nextRewritesLeft(0, null)).toBe(0);
  });

  it("requestRewrite posts only the on-screen text and never a target language", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "Shorter", lang: "en", remaining: 3 }), { status: 200 }));
    const r = await requestRewrite(
      { bookId: "b", pageId: "p1", instruction: "translate", text: "Hello" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r).toMatchObject({ kind: "preview", text: "Shorter", remaining: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ai/rewrite");
    expect(JSON.parse(String(init.body))).toEqual({ bookId: "b", pageId: "p1", instruction: "translate", text: "Hello" });
    expect(REWRITE_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("requestRewrite: network error / timeout → retry, non-JSON body handled", async () => {
    const boom = vi.fn(async () => {
      throw new TypeError("network");
    });
    expect((await requestRewrite({ bookId: "b", pageId: "p", instruction: "shorter", text: "x" }, { fetchImpl: boom as unknown as typeof fetch })).kind).toBe("retry");
    const hang = ((_: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    expect((await requestRewrite({ bookId: "b", pageId: "p", instruction: "shorter", text: "x" }, { fetchImpl: hang, timeoutMs: 5 })).kind).toBe("retry");
    const html = (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;
    expect((await requestRewrite({ bookId: "b", pageId: "p", instruction: "shorter", text: "x" }, { fetchImpl: html })).kind).toBe("unusable");
  });
});

// ---- render smoke ------------------------------------------------------------------------------

function makeCtx(selection: EditorSelection, opts: { ai?: DevAiMode; readOnly?: boolean; mutate?: (d: EditorShellData) => void } = {}) {
  const data = devEditorData("ok", opts.ai ?? "off");
  opts.mutate?.(data);
  const base = initEditorState(data.doc, { readOnly: opts.readOnly });
  const state = { ...base, selection, page: selection && selection.kind !== "cover" ? selection.pageIdx : base.page };
  const ctx = {
    book: data.book,
    state,
    actions: { edit: vi.fn(), select: vi.fn() },
    photos: {
      photos: data.photos,
      byId: new Map(data.photos.map((p) => [p.id, p])),
      web: {},
      thumbs: {},
      idForUrl: () => undefined,
      reportBroken: () => {},
    },
    readOnly: opts.readOnly === true,
    save: { status: { kind: "idle" }, flush: () => {} },
    ai: { mode: data.aiMode, rewritesUsed: data.rewritesUsed, rewritesLeft: data.rewritesLeft, setRewrites: vi.fn() },
    activeTool: null,
    openTool: vi.fn(),
    closeTool: vi.fn(),
  } as unknown as EditorContextValue;
  return { ctx, data };
}

function captionPageIdx(): number {
  const idx = devEditorData("ok").doc.pages.findIndex((p) => p.caption && p.caption.text.trim() !== "");
  if (idx < 0) throw new Error("fixture has no captioned page");
  return idx;
}

function renderPanel(tool: EditorTool, ctx: EditorContextValue): string {
  const Panel = tool.Panel!;
  return renderToStaticMarkup(<Panel ctx={ctx} close={() => {}} />);
}

describe("caption tools render", () => {
  const sel: EditorSelection = { kind: "caption", pageIdx: captionPageIdx() };

  it("caption tool opens on caption tap; ✨, Font, Chapter show for captions", () => {
    const { ctx } = makeCtx(sel);
    const ids = visibleTools([captionEditorTool, aiCaptionTool, captionStyleTool, chapterTitleTool, coverTextTool], ctx).map((t) => t.id);
    expect(ids.slice(0, 3)).toEqual(["caption", "ai-caption", "caption-style"]);
    expect(ids).not.toContain("cover-text");
    expect(autoOpenTool([aiCaptionTool, captionEditorTool], ctx)?.id).toBe("caption");
  });

  it("caption editor: dir=auto textarea, lang, count", () => {
    const { ctx } = makeCtx(sel);
    const html = renderPanel(captionEditorTool, ctx);
    expect(html).toMatch(/<textarea[^>]*dir="auto"/);
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('data-testid="caption-count"');
    expect(html).toMatch(/\d+ words? · \d+\/200/);
  });

  it("caption editor: Arabic caption gets lang=ar and a Cairo-first font", () => {
    const { ctx } = makeCtx(sel, {
      mutate: (d) => {
        const p = d.doc.pages[sel.pageIdx];
        p.caption = { text: "غروب الشمس على الكورنيش", font: "Cairo", align: "center", source: "user" };
      },
    });
    const html = renderPanel(captionEditorTool, ctx);
    expect(html).toMatch(/<textarea[^>]*lang="ar"/);
    expect(html).toContain("var(--font-cairo)");
  });

  it("font picker previews each font in itself; align buttons", () => {
    const { ctx } = makeCtx(sel);
    const html = renderPanel(captionStyleTool, ctx);
    for (const f of ["Inter", "Playfair", "Cairo", "Tajawal"]) expect(html).toContain(`data-testid="font-${f}"`);
    expect(html).toContain("font-family:var(--font-tajawal)");
    expect(html).toContain('data-testid="align-right"');
  });

  it("✨ menu: AI off → disabled message", () => {
    const { ctx } = makeCtx(sel, { ai: "off" });
    const html = renderPanel(aiCaptionTool, ctx);
    expect(html).toContain("AI captions aren&#x27;t switched on yet");
    expect(html).toContain('data-state="blocked"');
    expect(aiMenuBlockedReason(ctx, "text")).toBe(REWRITE_FAILURE_COPY.off);
  });

  it("✨ menu: replay → options + counter; empty caption → disabled", () => {
    const { ctx } = makeCtx(sel, { ai: "replay" });
    const html = renderPanel(aiCaptionTool, ctx);
    expect(html).toContain('data-testid="ai-option-rewrite"');
    expect(html).toContain('data-testid="ai-option-tone-nostalgic"');
    expect(html).toContain("20 rewrites left");
    expect(aiMenuBlockedReason(ctx, "  ")).toMatch(/Write a caption first/);
  });

  it("✨ menu: a session block (503 ai_unavailable / daily limit) disables every option", () => {
    const { ctx } = makeCtx(sel, { ai: "replay" });
    for (const [blocked, copy] of [
      ["unavailable", "AI captions aren&#x27;t available right now — try later"],
      ["dailyLimit", "You&#x27;ve reached today&#x27;s AI rewrite limit — try again tomorrow"],
    ] as const) {
      const c = { ...ctx, ai: { ...ctx.ai, blocked } } as EditorContextValue;
      const html = renderPanel(aiCaptionTool, c);
      expect(html).toContain('data-state="blocked"');
      expect(html).toContain(copy);
      expect(html).not.toContain("ai-upgrade");
    }
  });

  it("✨ menu: Shorter disabled with a hint for a ≤ 3-word caption", () => {
    const { ctx } = makeCtx(sel, {
      ai: "replay",
      mutate: (d) => {
        const p = d.doc.pages[sel.pageIdx];
        p.caption = { text: "Eid mubarak", font: "Playfair", align: "center", source: "user" };
      },
    });
    const html = renderPanel(aiCaptionTool, ctx);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="This caption is already short"[^>]*data-testid="ai-option-shorter"/);
    expect(html).toMatch(/<button[^>]*data-testid="ai-option-rewrite"/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="ai-option-rewrite"/);
    expect(html).toContain('data-testid="ai-shorter-hint"');
  });

  it("✨ menu: limit → message + Upgrade", () => {
    const { ctx } = makeCtx(sel, { ai: "limit" });
    const html = renderPanel(aiCaptionTool, ctx);
    expect(html).toContain("No AI rewrites left on this book");
    expect(html).toContain('data-testid="ai-upgrade"');
  });

  it("chapter tool shows for a page selection with a chapter", () => {
    expect(currentChapter(makeCtx(sel).ctx)).toBeNull(); // fixture pages have no chapter
    const { ctx } = makeCtx(sel, {
      mutate: (d) => {
        d.doc.chapters = [{ id: "c1", title: "Henna night", dateLabel: "", place: null }];
        d.doc.pages[sel.pageIdx].chapterId = "c1";
      },
    });
    expect(currentChapter(ctx)?.chapter.title).toBe("Henna night");
    expect(visibleTools([chapterTitleTool], ctx).map((t) => t.id)).toEqual(["chapter"]);
    const html = renderPanel(chapterTitleTool, ctx);
    expect(html).toMatch(/<input[^>]*dir="auto"/);
    expect(currentChapter(makeCtx(null).ctx)).toBeNull();
  });

  it("cover text: tool only for the text part; inputs dir=auto", () => {
    const { ctx } = makeCtx({ kind: "cover", part: "text" });
    expect(visibleTools([coverTextTool], ctx).map((t) => t.id)).toEqual(["cover-text"]);
    expect(visibleTools([coverTextTool], makeCtx({ kind: "cover", part: "photo" }).ctx)).toEqual([]);
    const html = renderPanel(coverTextTool, ctx);
    expect(html).toMatch(/<input[^>]*dir="auto"[^>]*data-testid="cover-title-input"/);
    expect(html).toMatch(/<input[^>]*dir="auto"[^>]*data-testid="cover-subtitle-input"/);
  });

  it("EditablePage cover: text tap target, placeholder when title and subtitle are empty", () => {
    const { ctx } = makeCtx(null);
    const html = renderToStaticMarkup(
      <EditorContext.Provider value={ctx}>
        <EditablePage page="cover" />
      </EditorContext.Provider>,
    );
    expect(html).toContain('data-testid="cover-text-target"');
    expect(html).not.toContain("Tap to add a title");
    const empty = { ...ctx, state: { ...ctx.state, doc: setCover(ctx.state.doc, { title: "", subtitle: "" }) } };
    const html2 = renderToStaticMarkup(
      <EditorContext.Provider value={empty as EditorContextValue}>
        <EditablePage page="cover" />
      </EditorContext.Provider>,
    );
    expect(html2).toContain("Tap to add a title");
  });
});
