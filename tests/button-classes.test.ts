// Guards src/components/app/button-classes.ts: every frozen string must equal its recipe computed
// from the real buttonVariants + cn, so the light client bundles render exactly what Button would.
import { describe, expect, it } from "vitest";
import { BTN } from "@/components/app/button-classes";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const RECIPES: Record<keyof typeof BTN, () => string> = {
  ctaPrimary: () => buttonVariants({ variant: "default", size: "cta" }),
  ctaPrimaryWrap: () => cn(buttonVariants({ variant: "default", size: "cta" }), "h-auto min-h-12 py-2 whitespace-normal"),
  ctaOutlineCard: () => cn(buttonVariants({ variant: "outline", size: "cta" }), "bg-card"),
  touchPrimary: () => buttonVariants({ variant: "default", size: "touch" }),
  touchOutlineCard: () => cn(buttonVariants({ variant: "outline", size: "touch" }), "bg-card"),
  touchOutlineDanger: () => cn(buttonVariants({ variant: "outline", size: "touch" }), "bg-card text-destructive hover:bg-destructive-soft hover:text-destructive"),
  touchOutlineWrap: () => cn(buttonVariants({ variant: "outline", size: "touch" }), "h-auto min-h-11 w-full bg-card py-2 whitespace-normal"),
  touchDestructiveSolid: () => cn(buttonVariants({ size: "touch" }), "bg-destructive text-white hover:bg-destructive/90"),
  touchGhostDanger: () => cn(buttonVariants({ variant: "ghost", size: "touch" }), "-ms-3 self-start text-destructive hover:bg-destructive-soft hover:text-destructive"),
  shareSecondary: () => cn(buttonVariants({ variant: "outline", size: "touch" }), "min-w-[9rem] flex-1 basis-0 bg-card"),
  ctaWhatsapp: () => cn(buttonVariants({ variant: "whatsapp", size: "cta" })),
  touchWhatsapp: () => cn(buttonVariants({ variant: "whatsapp", size: "touch" })),
  viewerPrimary: () => cn(buttonVariants({ size: "cta" }), "rounded-full"),
  viewerSecondary: () => cn(buttonVariants({ variant: "outline", size: "cta" }), "rounded-full bg-card"),
};

describe("BTN precomputed button classes", () => {
  it.each(Object.keys(RECIPES) as (keyof typeof BTN)[])("%s matches its buttonVariants recipe", (key) => {
    expect(BTN[key], `regenerate BTN.${key} in src/components/app/button-classes.ts`).toBe(RECIPES[key]());
  });

  it("has a recipe for every key", () => {
    expect(Object.keys(BTN).sort()).toEqual(Object.keys(RECIPES).sort());
  });
});
