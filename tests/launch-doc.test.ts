import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// docs/LAUNCH.md must stay in sync with the repo (M9 T16): every .env.example key has a row in the
// environment-variable table, and the migration / rls_check numbers match the files.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

function envExampleKeys(): string[] {
  return read(".env.example")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => l.slice(0, l.indexOf("=")).trim());
}

/** The "## 3. Environment variables" section, up to the next "## " heading. */
function envSection(doc: string): string {
  const start = doc.search(/^## 3\. Environment variables/m);
  expect(start, "LAUNCH.md has a '## 3. Environment variables' section").toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** First-column keys of the env table rows: | `KEY` | … */
function tableKeys(section: string): string[] {
  const keys: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = /^\|\s*`([A-Z0-9_]+)`\s*\|/.exec(line.trim());
    if (m) keys.push(m[1]);
  }
  return keys;
}

describe("docs/LAUNCH.md", () => {
  const doc = read("docs/LAUNCH.md");

  it("env table lists every .env.example key exactly once, and nothing else", () => {
    const keys = tableKeys(envSection(doc));
    expect(new Set(keys).size, "duplicate rows in the env table").toBe(keys.length);
    expect([...keys].sort()).toEqual([...envExampleKeys()].sort());
  });

  it("every env table row has all six columns", () => {
    for (const line of envSection(doc).split(/\r?\n/)) {
      if (!/^\|\s*`[A-Z0-9_]+`/.test(line.trim())) continue;
      const cells = line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/); // escaped \| stays inside a cell
      expect(cells.length, line).toBe(6);
      for (const c of cells) expect(c.trim(), line).not.toBe("");
    }
  });

  it("names the latest migration", () => {
    const files = readdirSync(join(root, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const latest = files[files.length - 1];
    expect(doc).toContain(latest);
  });

  it("quotes the current rls_check count", () => {
    const m = /RLS OK — all (\d+) checks passed/.exec(read("supabase/tests/rls_check.sql"));
    expect(m, "rls_check.sql states its expected count").not.toBeNull();
    expect(doc).toContain(`RLS OK — all ${m![1]} checks passed`);
  });

  it("lists the six Stripe webhook events", () => {
    for (const ev of [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
      "charge.refunded",
      "charge.dispute.created",
    ]) {
      expect(doc).toContain(`\`${ev}\``);
    }
  });
});
