// Publish celebration burst (M21 T2, extracted in T3 so SharePreview and PrimaryActionCard share
// it): 16 foil / emerald / cream pieces fired by data-celebrate="on" on an ancestor. Decorative;
// hidden under prefers-reduced-motion (share-motion.css). The ancestor must clip it
// (overflow-hidden) so it can never widen the page at 375 px. Hook-free.

import type { CSSProperties } from "react";
import "./share-motion.css";

/** Confetti pieces: angle spread round the circle, distances varied so the burst isn't a ring. */
const BURST = Array.from({ length: 16 }, (_, i) => ({
  a: Math.round((i * 360) / 16 + (i % 2 ? 9 : -6)),
  d: 90 + ((i * 37) % 70),
}));

export function ShareBurst() {
  return (
    <span aria-hidden="true" className="share-burst" data-testid="share-burst">
      {BURST.map((p, i) => (
        <i key={i} style={{ "--a": `${p.a}deg`, "--d": `${p.d}px`, "--i": i } as CSSProperties} />
      ))}
    </span>
  );
}
