// Static brand card for "/", /privacy and /terms link previews. No external fetches: ASCII text in
// next/og's bundled font, shapes drawn with CSS (see OG_HEADLINE in src/lib/marketing/copy.ts).
import { ImageResponse } from "next/og";
import { APP_NAME } from "@/lib/brand";
import { OG_HEADLINE, OG_SUBLINE } from "@/lib/marketing/copy";

export const alt = `${APP_NAME} — ${OG_HEADLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          gap: 64,
          padding: "0 80px",
          background: "linear-gradient(135deg, #fff7ed 0%, #fde68a 55%, #fb923c 100%)",
          color: "#1c1917",
        }}
      >
        <div style={{ display: "flex", position: "relative", width: 300, height: 420, flexShrink: 0 }}>
          <div
            style={{
              display: "flex",
              position: "absolute",
              left: 36,
              top: 0,
              width: 264,
              height: 374,
              borderRadius: 16,
              background: "linear-gradient(135deg, #bae6fd, #0ea5e9)",
              transform: "rotate(6deg)",
            }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              position: "absolute",
              left: 0,
              top: 30,
              width: 264,
              height: 374,
              padding: 18,
              borderRadius: 16,
              background: "#ffffff",
              boxShadow: "0 20px 40px rgba(0,0,0,0.18)",
            }}
          >
            <div
              style={{
                display: "flex",
                flex: 1,
                borderRadius: 8,
                background: "linear-gradient(135deg, #fde68a, #fb7185)",
              }}
            />
            <div style={{ display: "flex", marginTop: 14, height: 10, width: "80%", borderRadius: 5, background: "#d6d3d1" }} />
            <div style={{ display: "flex", marginTop: 8, height: 10, width: "55%", borderRadius: 5, background: "#e7e5e4" }} />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700, letterSpacing: 1, color: "#9a3412" }}>{APP_NAME}</div>
          <div style={{ display: "flex", marginTop: 20, fontSize: 60, fontWeight: 700, lineHeight: 1.1 }}>{OG_HEADLINE}</div>
          <div style={{ display: "flex", marginTop: 28, fontSize: 30, color: "#44403c" }}>{OG_SUBLINE}</div>
        </div>
      </div>
    ),
    size,
  );
}
