// Vitest stand-in for next/font/local (Next's compiler replaces localFont() calls at build time;
// outside Next the import has no callable default). Deterministic class names derived from the
// CSS variable, so tests can assert which variables a wrapper re-declares.

type LocalFontOptions = { variable?: string; src: string | { path: string; weight?: string; style?: string }[] };

export default function localFont(opts: LocalFontOptions) {
  const name = (opts.variable ?? "--font-local").replace(/^--/, "");
  return {
    className: `__className_${name}`,
    variable: `__variable_${name}`,
    style: { fontFamily: `'__${name}'` },
  };
}
