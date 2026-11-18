// M30 T2 specimen: the two new faces (Archivo Black, Poppins 400 / 700) with their Arabic partners
// through the real bookFontFamily() chains, the magazine + editorial roles in EN + AR through
// roleFont(), and the 12 colourways (accent on panel, accentOnLight on white). Dev-only (rendered
// by /dev-fonts; `?sheet=m30` shows only this). Screenshot: docs/design/m30-fonts.png.

import type { CSSProperties, ReactNode } from "react";
import { BOOK_FONTS, BOOK_FONTS_M30, bookFontFamily } from "@/lib/book/fonts";
import { colourwaysFor } from "@/lib/design/colourways";
import { roleFont, STYLE_TOKENS, type TextRole } from "@/lib/design/styles";

type M30Style = "magazine" | "editorial";
const STYLES: M30Style[] = ["magazine", "editorial"];

const LATIN = "Summer in Abu Dhabi 2026 — “Beach day” & café · ½ ñ ü ø";
const ARABIC = "رحلة العائلة إلى أبوظبي ٢٠٢٦ — أجمل ليلة بدأت بضحكة";
const MIXED = "Eid with Teta عيد سعيد 2026 → ♥ ★ ✓";

const ROWS: { role: TextRole; en: string; ar: string; mm: number; lh: number }[] = [
  { role: "masthead", en: "Adventure", ar: "مغامرة", mm: 13, lh: 1.05 },
  { role: "title", en: "Exploring the world one destination", ar: "نستكشف العالم وجهةً بعد وجهة", mm: 6.4, lh: 1.15 },
  { role: "subtitle", en: "Travel magazine · Abu Dhabi", ar: "مجلة السفر · أبوظبي", mm: 3.6, lh: 1.3 },
  { role: "year", en: "November 2026", ar: "نوفمبر ٢٠٢٦", mm: 3.2, lh: 1.3 },
  { role: "chapter", en: "Life is one change", ar: "الحياة رحلة واحدة", mm: 5.4, lh: 1.15 },
  { role: "caption", en: "Salt in our hair and the longest sunset of the year.", ar: "ملحٌ في شعرنا وأطول غروب في السنة.", mm: 3.2, lh: 1.45 },
  {
    role: "body",
    en: "We left before sunrise, followed the coast road and stopped wherever the light looked good. By evening the whole family was on the sand.",
    ar: "غادرنا قبل الشروق وسرنا على طريق الساحل، وتوقفنا حيثما كان الضوء جميلاً. وفي المساء كانت العائلة كلها على الرمل.",
    mm: 2.9,
    lh: 1.5,
  },
];

function roleStyle(style: M30Style, role: TextRole, text: string, mm: number, lh: number): CSSProperties {
  const f = roleFont(style, role, text);
  return {
    fontFamily: f.fontFamily,
    fontWeight: f.fontWeight,
    fontStyle: f.fontStyle,
    textTransform: f.textTransform,
    letterSpacing: f.letterSpacing,
    fontSize: `${mm}mm`,
    lineHeight: lh,
  };
}

function Faces() {
  const faces = BOOK_FONTS_M30.flatMap((f) => BOOK_FONTS[f].weights.map((w) => ({ f, w })));
  return (
    <>
      {faces.map(({ f, w }) => {
        const style: CSSProperties = { fontFamily: bookFontFamily(f), fontWeight: w };
        return (
          <div key={`${f}${w}`} className="border-t border-neutral-200 py-[1.2mm]" data-font={f} data-weight={w}>
            <div className="font-sans text-[2.4mm] text-neutral-500">
              {BOOK_FONTS[f].label} {w} · Arabic partner {BOOK_FONTS[BOOK_FONTS[f].partner].label}
            </div>
            <p style={{ ...style, fontSize: "5mm", lineHeight: 1.25 }}>
              <span dir="auto" data-m30-sample="latin">
                {LATIN}
              </span>
            </p>
            <p dir="auto" lang="ar" data-m30-sample="arabic" style={{ ...style, fontSize: "5mm", lineHeight: 1.45 }}>
              {ARABIC}
            </p>
            <p dir="auto" style={{ ...style, fontSize: "4mm", lineHeight: 1.4 }}>
              {MIXED}
            </p>
          </div>
        );
      })}
    </>
  );
}

function Roles({ style }: { style: M30Style }) {
  const p = STYLE_TOKENS[style].palette!;
  return (
    <div data-m30-roles={style} style={{ color: p.ink }}>
      <h2 className="mb-[1mm] mt-[2mm] font-sans text-[3mm] font-semibold capitalize text-neutral-500">{style} roles</h2>
      {ROWS.map((r) =>
        [r.en, r.ar].map((t) => (
          <p key={r.role + t} dir="auto" data-role={r.role} data-font={roleFont(style, r.role, t).font} style={roleStyle(style, r.role, t, r.mm, r.lh)}>
            {t}
          </p>
        )),
      )}
    </div>
  );
}

function Swatches({ style }: { style: M30Style }) {
  return (
    <div data-m30-colourways={style}>
      <h2 className="mb-[1mm] mt-[3mm] font-sans text-[3mm] font-semibold capitalize text-neutral-500">{style} colourways</h2>
      <div className="grid grid-cols-3 gap-[2mm]">
        {colourwaysFor(style).map((c) => (
          <div key={c.id} data-colourway={c.id} className="overflow-hidden border border-neutral-200">
            <div style={{ background: c.panel, color: c.onPanel, padding: "2mm" }}>
              <p dir="auto" style={{ ...roleStyle(style, "chapter", c.label, 4.2, 1.1), color: c.accent }}>
                {c.label}
              </p>
              <p dir="auto" style={roleStyle(style, "body", "Text on panel", 2.5, 1.4)}>
                Text on panel · نص على اللوحة
              </p>
              <div style={{ height: "1.2mm", marginTop: "1mm", background: c.accent }} />
            </div>
            <div style={{ background: "#FFFFFF", padding: "2mm" }}>
              <p dir="auto" style={{ ...roleStyle(style, "chapter", "Accent on white", 3.2, 1.2), color: c.accentOnLight }}>
                Accent on white
              </p>
              <p className="font-sans text-[2mm] text-neutral-500">
                {c.accent} · {c.accentOnLight} · {c.panel}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function M30Specimen({ Sheet }: { Sheet: (p: { children: ReactNode }) => ReactNode }) {
  return (
    <>
      <Sheet>
        <h1 className="mb-[2mm] font-sans text-[4mm] font-semibold">M30 faces — Archivo Black, Poppins</h1>
        <Faces />
        {STYLES.map((s) => (
          <Swatches key={s} style={s} />
        ))}
      </Sheet>
      <Sheet>
        <h1 className="mb-[2mm] font-sans text-[4mm] font-semibold">M30 roles — Magazine, Editorial</h1>
        {STYLES.map((s) => (
          <Roles key={s} style={s} />
        ))}
      </Sheet>
    </>
  );
}
