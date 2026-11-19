// Task 9 privacy guard: no console call under src/ may log photo data, sensitive metadata, private
// text or secrets. Every console.* call is parsed; each interpolated / extra argument expression is
// checked against a deny list (captions, descriptions, narrative / story text, prompts, titles,
// e-mail addresses, GPS / EXIF, paths, URLs incl. signed URLs, base64, passwords, raw error
// messages and whole error objects). Logging codes, counts and route tags stays allowed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

/** The text between the call's parentheses (balanced, string-aware enough for this codebase). */
function callArgs(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      else if (quote === "`" && c === "$" && src[i + 1] === "{") {
        // template interpolation: skip to its closing brace
        let d = 0;
        for (i = i + 1; i < src.length; i++) {
          if (src[i] === "{") d++;
          else if (src[i] === "}" && --d === 0) break;
        }
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Expressions that reach the log: template interpolations + top-level non-literal arguments. */
function loggedExpressions(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/\$\{([^}]*)\}/g)) out.push(m[1]!);
  // top-level comma split
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    cur += c;
    if (quote) {
      if (c === "\\") cur += args[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(cur.slice(0, -1));
      cur = "";
    }
  }
  parts.push(cur);
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (/^(["'`])[\s\S]*\1$/.test(p) && !p.includes("${")) continue; // a plain literal
    if (p.startsWith("`")) continue; // template: its interpolations were collected above
    out.push(p);
  }
  return out;
}

const DENY =
  /\b(caption|captions|description|narrative|story|prompt|text|title|answers?|email|lat|lng|gps|exif|place|path|paths|url|signedUrl|signed|base64|password|token|secret|apiKey|doc)\b|\w+_(path|url)\b|\.message\b|\.stack\b|^(err|error|e)$/i;

function violations(): string[] {
  const found: string[] = [];
  for (const file of files(ROOT)) {
    // comments are not code: drop whole-line // and block-comment lines before scanning
    const src = readFileSync(file, "utf8")
      .split("\n")
      .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l))
      .join("\n");
    for (const m of src.matchAll(/console\.(log|info|warn|error|debug)\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const args = callArgs(src, open);
      for (const expr of loggedExpressions(args)) {
        // string literals inside an expression are constant text, not data
        const bare = expr.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').trim();
        if (DENY.test(bare)) found.push(`${relative(process.cwd(), file)}: console.${m[1]}(… ${expr.trim()} …)`);
      }
    }
  }
  return found;
}

describe("privacy: no sensitive data in logs (Task 9)", () => {
  it("scans every console call under src/", () => {
    const count = files(ROOT).reduce((n, f) => n + (readFileSync(f, "utf8").match(/console\.(log|info|warn|error|debug)\s*\(/g)?.length ?? 0), 0);
    expect(count).toBeGreaterThan(50);
  });

  it("no console call logs captions, descriptions, story text, prompts, titles, e-mails, GPS / EXIF, paths, URLs, secrets or raw error messages", () => {
    expect(violations()).toEqual([]);
  });

  it("the deny list catches the patterns it is meant to catch", () => {
    for (const bad of ["photo.description", "signedUrl", "row.thumb_path", "err.message", "err", "book.title", "user.email", "photo.lat", "page.text", "story.text", "data.url", "e.stack", "insight.caption"]) {
      expect(DENY.test(bad), bad).toBe(true);
    }
    for (const ok of ["code", "errorCodeOf(err)", "exportId", "built.reason", "res.status", "deleted.length", "TAG"]) expect(DENY.test(ok), ok).toBe(false);
  });

  it("console.log is not used in src/ (debug output never ships)", () => {
    const hits = files(ROOT).filter((f) => /console\.log\s*\(/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => relative(process.cwd(), f))).toEqual([]);
  });
});
