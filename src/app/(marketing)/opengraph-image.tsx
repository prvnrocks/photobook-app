// Static brand card for "/", /privacy and /terms link previews (M16 emerald & gold, mirrors the home
// hero): deep emerald field framed by two gold foil rules, pale-gold small caps, cream + gold headline
// and the hero book on the right. Text uses next/og's bundled font only (Latin subset — see OG_* in
// src/lib/marketing/copy.ts); the book PNG is read from /public and inlined as a data URL. No dynamic
// APIs, so Next prerenders this at build time (process.cwd() = project root).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { APP_NAME } from "@/lib/brand";
import { OG_EYEBROW, OG_HEADLINE, OG_HEADLINE_ACCENT, OG_HEADLINE_LEAD, OG_SUBLINE } from "@/lib/marketing/copy";
import { HERO_BOOK } from "@/lib/marketing/hero";

export const alt = `${APP_NAME} — ${OG_HEADLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const EMERALD = "#0e3b2e";
const GOLD = "#c9a227";
const PALE_GOLD = "#e3c766";
const CREAM = "#f2e8d8";

const BOOK_H = 430;
const BOOK_W = Math.round((BOOK_H * HERO_BOOK.w) / HERO_BOOK.h);

async function loadBook(): Promise<string | null> {
  try {
    const png = await readFile(join(process.cwd(), "public", HERO_BOOK.src));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null; // card still renders, text-only
  }
}

function Rule({ left }: { left: number }) {
  return <div style={{ display: "flex", position: "absolute", top: 0, bottom: 0, left, width: 2, background: GOLD }} />;
}

export default async function OpengraphImage() {
  const book = await loadBook();
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          alignItems: "center",
          padding: "0 100px 0 108px",
          background: `radial-gradient(circle at 70% 40%, #155040 0%, ${EMERALD} 60%)`,
          color: CREAM,
        }}
      >
        <Rule left={56} />
        <Rule left={1142} />
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <div style={{ display: "flex", fontSize: 24, fontWeight: 700, letterSpacing: 6, color: PALE_GOLD }}>
            {OG_EYEBROW}
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 28, fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>
            <div style={{ display: "flex", color: CREAM, whiteSpace: "nowrap" }}>{OG_HEADLINE_LEAD}</div>
            <div style={{ display: "flex", color: GOLD }}>{OG_HEADLINE_ACCENT}</div>
          </div>
          <div style={{ display: "flex", marginTop: 30, width: 72, height: 2, background: GOLD }} />
          <div style={{ display: "flex", marginTop: 26, fontSize: 30, color: CREAM, opacity: 0.88 }}>{OG_SUBLINE}</div>
        </div>
        {book ? (
          <img src={book} width={BOOK_W} height={BOOK_H} alt="" style={{ flexShrink: 0, marginLeft: 24 }} />
        ) : null}
      </div>
    ),
    size,
  );
}
