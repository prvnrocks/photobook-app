// Gold-foil flecks for the home hero (M16). Server component, CSS animation only (home-fleck in
// globals.css; still under prefers-reduced-motion). Positions are data in lib/marketing/hero.
import type { CSSProperties } from "react";
import { FOIL_FLECKS, type FoilFleck } from "@/lib/marketing/hero";

function fleckStyle(p: FoilFleck): CSSProperties {
  return {
    left: `${p.x}%`,
    top: `${p.y}%`,
    width: `calc(${p.w}px * var(--fs))`,
    height: `calc(${p.h}px * var(--fs))`,
    "--r": `${p.rot}deg`,
    "--dur": `${p.dur}s`,
    "--delay": `${p.delay}s`,
  } as CSSProperties;
}

export function HeroFlecks({ layer, className = "" }: { layer: FoilFleck["layer"]; className?: string }) {
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 [--fs:1] lg:[--fs:1.3] ${className}`}>
      {FOIL_FLECKS.filter((p) => p.layer === layer).map((p, i) => (
        <span key={i} className={`home-fleck absolute ${p.desktopOnly ? "hidden md:block" : "block"}`} style={fleckStyle(p)} />
      ))}
    </div>
  );
}
