// Paper confetti for the home hero (M15). Server component, CSS animation only (home-confetti in
// globals.css; still under prefers-reduced-motion). Positions/colours are data in lib/marketing/hero.
import type { CSSProperties } from "react";
import { CONFETTI, CONFETTI_COLORS, type ConfettiPiece } from "@/lib/marketing/hero";

function pieceStyle(p: ConfettiPiece): CSSProperties {
  return {
    left: `${p.x}%`,
    top: `${p.y}%`,
    width: `calc(${p.w}px * var(--cs))`,
    height: `calc(${p.h}px * var(--cs))`,
    backgroundColor: CONFETTI_COLORS[p.color],
    "--r": `${p.rot}deg`,
    "--dur": `${p.dur}s`,
    "--delay": `${p.delay}s`,
  } as CSSProperties;
}

export function HeroConfetti({ layer, className = "" }: { layer: ConfettiPiece["layer"]; className?: string }) {
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 [--cs:0.85] md:[--cs:1.1] lg:[--cs:1.3] ${className}`}>
      {CONFETTI.filter((p) => p.layer === layer).map((p, i) => (
        <span
          key={i}
          className={`home-confetti absolute rounded-[2px] shadow-[0_1px_2px_rgb(22_18_28/0.14)] ${p.desktopOnly ? "hidden md:block" : "block"}`}
          style={pieceStyle(p)}
        />
      ))}
    </div>
  );
}
