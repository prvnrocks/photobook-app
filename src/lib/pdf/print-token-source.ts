// Where the print route reads its token from (N6). Pure: no secrets, no server imports, so the
// renderer (header name) and the print page share one definition.
//
// Production: ONLY the `x-print-token` request header, which the PDF renderer adds to same-origin
// navigation requests (src/lib/pdf/render-pdf.ts) — tokens never appear in URLs, access logs,
// history or Referer. Outside production the `?token=` query is a fallback for manual debugging.

export const PRINT_TOKEN_HEADER = "x-print-token";

export function readPrintToken(
  header: string | null | undefined,
  query: string | string[] | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string | undefined {
  if (typeof header === "string" && header.length > 0) return header;
  if (nodeEnv === "production") return undefined;
  return typeof query === "string" && query.length > 0 ? query : undefined;
}
