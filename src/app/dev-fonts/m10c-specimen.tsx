// M10c type + token specimen (T3, gate G0): Geometric and Scrapbook roles in EN + AR through the
// real roleFont() chains, label plates from the sticker catalogue with live text, the style
// palette, and a small vignette page per language. Dev-only (rendered by /dev-fonts).
// Screenshot: docs/design/m10c-type.png.

import type { CSSProperties, ReactNode } from "react";
import { resolveStickerPaths, STICKERS, plateInk, type StickerId } from "@/lib/design/stickers";
import { roleFont, STYLE_TOKENS, type TextRole } from "@/lib/design/styles";

type NewStyle = "geometric" | "scrapbook";

const SAMPLES: Record<"en" | "ar", { title: string; subtitle: string; chapter: string; date: string; caption: string; plate: string }> = {
  en: {
    title: "Our Summer by the Sea",
    subtitle: "Abu Dhabi · June 2026",
    chapter: "Day one at the beach",
    date: "14 June 2026",
    caption: "Salt in our hair, sand on every page, and the longest sunset of the year.",
    plate: "Sunny days",
  },
  ar: {
    title: "صيفنا على البحر",
    subtitle: "أبوظبي · يونيو ٢٠٢٦",
    chapter: "اليوم الأول على الشاطئ",
    date: "١٤ يونيو ٢٠٢٦",
    caption: "ملحٌ في شعرنا، ورملٌ على كل صفحة، وأطول غروب في السنة.",
    plate: "أيام مشمسة",
  },
};

const ROWS: { key: keyof (typeof SAMPLES)["en"]; role: TextRole; label: string; mm: number; lh: number }[] = [
  { key: "title", role: "title", label: "Title", mm: 10, lh: 1.15 },
  { key: "subtitle", role: "subtitle", label: "Subtitle", mm: 4.4, lh: 1.3 },
  { key: "chapter", role: "chapter", label: "Chapter", mm: 7.4, lh: 1.1 },
  { key: "date", role: "year", label: "Date label", mm: 4.2, lh: 1.3 },
  { key: "caption", role: "caption", label: "Caption", mm: 3.85, lh: 1.45 },
];

function textStyle(style: NewStyle, role: TextRole, text: string, mm: number, lh: number, color?: string): CSSProperties {
  const f = roleFont(style, role, text);
  return {
    fontFamily: f.fontFamily,
    fontWeight: f.fontWeight,
    fontStyle: f.fontStyle,
    textTransform: f.textTransform,
    letterSpacing: f.letterSpacing,
    fontSize: `${mm}mm`,
    lineHeight: lh,
    color,
  };
}

function T({ style, role, text, mm, lh = 1.25, color, className }: { style: NewStyle; role: TextRole; text: string; mm: number; lh?: number; color?: string; className?: string }) {
  const f = roleFont(style, role, text);
  return (
    <p dir="auto" lang={/[؀-ۿ]/.test(text) ? "ar" : "en"} data-role={role} data-font={f.font} className={className} style={textStyle(style, role, text, mm, lh, color)}>
      {text}
    </p>
  );
}

/** A sticker drawn from the catalogue (same paths the renderer will use). */
function Sticker({ id, tint, w, style }: { id: StickerId; tint?: string; w: string; style?: CSSProperties }) {
  const [x, y, vw, vh] = STICKERS[id].viewBox;
  return (
    <svg viewBox={`${x} ${y} ${vw} ${vh}`} style={{ width: w, aspectRatio: `${vw} / ${vh}`, display: "block", overflow: "visible", ...style }} aria-hidden>
      {resolveStickerPaths(id, tint).map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill}
          fillRule={p.fillRule}
          stroke={p.stroke}
          strokeWidth={p.strokeWidth}
          strokeDasharray={p.strokeDasharray}
          strokeLinecap={p.strokeLinecap}
          strokeLinejoin={p.strokeLinejoin}
        />
      ))}
    </svg>
  );
}

/** Label plate: sticker + live bound text inside its textBox. */
function Plate({ style, id, tint, text, w, role = "year", rotate = 0 }: { style: NewStyle; id: StickerId; tint?: string; text: string; w: number; role?: TextRole; rotate?: number }) {
  const def = STICKERS[id];
  const [, , vw, vh] = def.viewBox;
  const h = (w * vh) / vw;
  const tb = def.textBox!;
  const ink = plateInk(id, tint) === "light" ? "#FFFFFF" : "#262626";
  return (
    <div style={{ position: "relative", width: `${w}mm`, height: `${h}mm`, transform: rotate ? `rotate(${rotate}deg)` : undefined }} data-plate={id}>
      <Sticker id={id} tint={tint} w={`${w}mm`} style={{ position: "absolute", inset: 0 }} />
      <div
        style={{ position: "absolute", left: `${tb.x}%`, top: `${tb.y}%`, width: `${tb.w}%`, height: `${tb.h}%`, display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <T style={style} role={role} text={text} mm={h * 0.42} lh={1} color={ink} className="whitespace-nowrap" />
      </div>
    </div>
  );
}

/** A soft photo stand-in (inline SVG data URL, like /dev-style). */
function scene(i: number): string {
  const S = [
    ["#c9d6dc", "#8fb0bd", "#e8dcc6"],
    ["#f0e3d0", "#d6b48f", "#a65a3f"],
    ["#dfe5df", "#9fb3a0", "#566b5c"],
    ["#2f3b55", "#8a6f7d", "#e2b48f"],
    ["#e9d8c2", "#c9a27e", "#5e4a3c"],
  ][i % 5];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300" preserveAspectRatio="xMidYMid slice">` +
    `<rect width="300" height="300" fill="${S[0]}"/><circle cx="210" cy="80" r="26" fill="#fff" fill-opacity=".55"/>` +
    `<path d="M0 190Q90 150 165 185T300 170V300H0Z" fill="${S[1]}"/><path d="M0 245Q120 215 300 250V300H0Z" fill="${S[2]}"/></svg>`;
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

function Photo({ i, style }: { i: number; style: CSSProperties }) {
  return <div style={{ position: "absolute", backgroundImage: scene(i), backgroundSize: "cover", backgroundPosition: "center", ...style }} />;
}

// --- vignettes -----------------------------------------------------------------------------------

function GeometricVignette({ lang }: { lang: "en" | "ar" }) {
  const s = SAMPLES[lang];
  const p = STYLE_TOKENS.geometric.palette!;
  const rtl = lang === "ar";
  return (
    <div dir={rtl ? "rtl" : "ltr"} style={{ position: "relative", width: "62mm", height: "88mm", background: p.background, overflow: "hidden", boxShadow: "0 0.3mm 1.2mm rgba(0,0,0,.18)" }}>
      <Photo i={0} style={{ left: 0, top: 0, width: "62mm", height: "46mm", clipPath: "polygon(0 0, 100% 0, 100% 62%, 0 100%)" }} />
      <Photo i={1} style={{ insetInlineEnd: "5mm", top: "31mm", width: "22mm", height: "22mm", clipPath: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)" }} />
      <Photo i={2} style={{ insetInlineEnd: "4mm", top: "57mm", width: "25mm", height: "25mm", borderRadius: "50%" }} />
      <div style={{ position: "absolute", insetInlineStart: "5mm", top: "49mm", width: "28mm" }}>
        <T style="geometric" role="year" text={s.date} mm={2.4} color={p.accent} />
        <div style={{ width: "8mm", height: "0.35mm", background: p.accent, margin: "1mm 0" }} />
        <T style="geometric" role="chapter" text={s.chapter} mm={4.6} lh={1.02} color={p.ink} />
      </div>
      <div style={{ position: "absolute", insetInlineStart: "5mm", top: "68mm", width: "27mm" }}>
        <T style="geometric" role="caption" text={s.caption} mm={2.5} lh={1.4} color={p.muted} />
      </div>
    </div>
  );
}

function ScrapbookVignette({ lang }: { lang: "en" | "ar" }) {
  const s = SAMPLES[lang];
  const p = STYLE_TOKENS.scrapbook.palette!;
  const lifted = STYLE_TOKENS.scrapbook.shadows!.lifted;
  // Specimen only: an unblurred box-shadow approximates the book's drawn shadow shape (BookPage draws a sibling).
  const shadow = `${lifted.dxMm}mm ${lifted.dyMm}mm 0 ${lifted.color}`;
  const rtl = lang === "ar";
  const flip = (mm: number) => (rtl ? { right: `${mm}mm` } : { left: `${mm}mm` });
  return (
    <div
      dir={rtl ? "rtl" : "ltr"}
      style={{ position: "relative", width: "62mm", height: "88mm", background: `${p.background} url(/design/textures/paper-cream.webp) 0 0 / 40mm 40mm`, overflow: "hidden", boxShadow: "0 0.3mm 1.2mm rgba(0,0,0,.18)" }}
    >
      {/* polaroid 1 */}
      <div style={{ position: "absolute", ...flip(5), top: "7mm", width: "34mm", height: "38mm", background: p.frame, boxShadow: shadow, transform: `rotate(${rtl ? 3 : -3}deg)` }}>
        <Photo i={0} style={{ left: "2mm", top: "2mm", width: "30mm", height: "28mm" }} />
      </div>
      <div style={{ position: "absolute", ...flip(13), top: "4mm", transform: `rotate(${rtl ? 6 : -6}deg)` }}>
        <Sticker id="tape-washi" tint={p.tape} w="18mm" />
      </div>
      {/* polaroid 2 */}
      <div style={{ position: "absolute", ...flip(33), top: "20mm", width: "25mm", height: "29mm", background: p.frame, boxShadow: shadow, transform: `rotate(${rtl ? -5 : 5}deg)` }}>
        <Photo i={1} style={{ left: "1.6mm", top: "1.6mm", width: "21.8mm", height: "21mm" }} />
      </div>
      <div style={{ position: "absolute", ...flip(2.5), top: "40mm" }}>
        <Sticker id="heart-kraft" w="8mm" style={{ transform: `rotate(${rtl ? 12 : -12}deg)` }} />
      </div>
      <div style={{ position: "absolute", ...flip(36), top: "48mm" }}>
        <Plate style="scrapbook" id={p.plate.id} tint={p.plate.tint} text={s.plate} w={22} rotate={rtl ? 3 : -3} />
      </div>
      {/* chapter block */}
      <div style={{ position: "absolute", insetInlineStart: "5mm", top: "52mm", width: "30mm" }}>
        <T style="scrapbook" role="subtitle" text={lang === "ar" ? "لحظات لا تُنسى" : "these moments"} mm={3.2} color={p.muted} />
        <T style="scrapbook" role="chapter" text={s.chapter} mm={6} lh={1} color={p.ink} />
        <T style="scrapbook" role="year" text={s.date} mm={2.4} color={p.accent} className="mt-[1mm]" />
      </div>
      <div style={{ position: "absolute", insetInlineStart: "5mm", insetInlineEnd: "5mm", top: "72mm" }}>
        <T style="scrapbook" role="caption" text={s.caption} mm={2.6} lh={1.4} color={p.ink} />
      </div>
      <div style={{ position: "absolute", ...flip(50), top: "3mm" }}>
        <Sticker id="accent-plane" w="10mm" style={{ transform: rtl ? "scaleX(-1)" : undefined }} />
      </div>
    </div>
  );
}

// --- sheet ---------------------------------------------------------------------------------------

function Swatch({ hex, name }: { hex: string; name: string }) {
  return (
    <div className="flex items-center gap-[1mm]">
      <span style={{ width: "4mm", height: "4mm", background: hex, borderRadius: "0.8mm", border: "0.2mm solid rgba(0,0,0,.15)", display: "inline-block" }} />
      <span className="font-sans text-[2.2mm] text-neutral-600">
        {name} {hex}
      </span>
    </div>
  );
}

const ABOUT: Record<NewStyle, string> = {
  geometric: "Magazine: Cormorant title, tracked Bebas subtitle / date / chapter, Cormorant captions. Arabic: Amiri + Lalezar, never tracked.",
  scrapbook: "Handmade: Bebas titles, chapters and label plates, Cormorant italic subtitle, Cormorant captions. Arabic: Lalezar + Amiri, never tracked.",
};

export function M10cSpecimen({ Sheet }: { Sheet: (p: { children: ReactNode }) => ReactNode }) {
  return (
    <>
      {(["geometric", "scrapbook"] as const).map((style) => {
        const p = STYLE_TOKENS[style].palette!;
        return (
          <Sheet key={style}>
            <div data-specimen={style}>
              <div className="mb-[2mm] flex items-baseline justify-between border-b border-neutral-300 pb-[1.5mm]">
                <h1 className="font-sans text-[4.4mm] font-semibold capitalize">{style}</h1>
                <span className="font-sans text-[2.3mm] text-neutral-500">M10c type + tokens · roleFont() chains</span>
              </div>
              <p className="mb-[2.5mm] font-sans text-[2.4mm] leading-snug text-neutral-600">{ABOUT[style]}</p>
              {ROWS.map((r) => {
                const f = roleFont(style, r.role, SAMPLES.en[r.key]);
                const fa = roleFont(style, r.role, SAMPLES.ar[r.key]);
                return (
                  <div key={r.key} className="border-t border-neutral-200 py-[1.4mm]">
                    <div className="mb-[0.6mm] font-sans text-[2.1mm] text-neutral-500">
                      {r.label} · {f.font} {f.fontWeight}
                      {f.fontStyle === "italic" ? " italic" : ""}
                      {f.letterSpacing ? ` · tracking ${f.letterSpacing}` : ""} / {fa.font} {fa.fontWeight}
                      {fa.letterSpacing ? " (tracked!)" : ""}
                    </div>
                    <div className="grid grid-cols-2 gap-[4mm]">
                      <T style={style} role={r.role} text={SAMPLES.en[r.key]} mm={r.mm} lh={r.lh} color={p.ink} />
                      <T style={style} role={r.role} text={SAMPLES.ar[r.key]} mm={r.mm} lh={r.lh} color={p.ink} />
                    </div>
                  </div>
                );
              })}
              <div className="border-t border-neutral-200 py-[1.6mm]">
                <div className="mb-[1mm] font-sans text-[2.1mm] text-neutral-500">Label plates · live text (date + chapter roles) on catalogue plates</div>
                <div className="flex flex-wrap items-center gap-[3mm]">
                  <Plate style={style} id="plate-label" tint={p.plate.tint} text={SAMPLES.en.plate} w={30} />
                  <Plate style={style} id="plate-label" tint={p.plate.tint} text={SAMPLES.ar.plate} w={30} />
                  <Plate style={style} id="plate-tag" text={SAMPLES.en.date} w={30} />
                  <Plate style={style} id="plate-tag" text={SAMPLES.ar.date} w={30} />
                </div>
              </div>
              <div className="flex flex-wrap gap-x-[3mm] gap-y-[1mm] border-t border-neutral-200 py-[1.6mm]">
                <Swatch hex={p.background} name="page" />
                <Swatch hex={p.ink} name="ink" />
                <Swatch hex={p.muted} name="muted" />
                <Swatch hex={p.accent} name="accent" />
                <Swatch hex={p.frame} name="frame" />
                <Swatch hex={p.tape} name="tape" />
              </div>
              <div className="flex justify-between border-t border-neutral-200 pt-[2mm]">
                {style === "geometric" ? <GeometricVignette lang="en" /> : <ScrapbookVignette lang="en" />}
                {style === "geometric" ? <GeometricVignette lang="ar" /> : <ScrapbookVignette lang="ar" />}
              </div>
            </div>
          </Sheet>
        );
      })}
    </>
  );
}
