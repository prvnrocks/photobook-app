// Small caps label over a gold foil hairline (M16, the reference business card). Antique gold text on
// cream (4.99:1); the hairline is decoration. Server component.
export function SectionLabel({ children, align = "start" }: { children: string; align?: "start" | "center" }) {
  return (
    <p className={`flex flex-col text-xs font-semibold tracking-[0.3em] text-[#7a5f0e] uppercase sm:text-[0.8rem] ${align === "center" ? "items-center text-center" : "items-start"}`}>
      <span className={align === "center" ? "ps-[0.3em]" : undefined}>{children}</span>
      <span aria-hidden="true" className="home-foil-h mt-3 block h-px w-12" />
    </p>
  );
}
