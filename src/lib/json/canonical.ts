// Canonical JSON (M12 T3): object keys sorted, `undefined` object members dropped (as
// JSON.stringify drops them), arrays in order. Two values with the same canonical string are the
// same jsonb value — Postgres jsonb does not keep key order, so a plain JSON.stringify of what we
// sent and of what we read back can differ for the identical document.

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalise(v)));
  if (value && typeof value === "object") {
    // toJSON (Date etc.) first, like JSON.stringify.
    const maybe = value as { toJSON?: () => unknown };
    if (typeof maybe.toJSON === "function") return normalise(maybe.toJSON());
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      out[key] = normalise(v);
    }
    return out;
  }
  return value;
}
