#!/usr/bin/env node
// PGlite dry-run: stubs.sql -> supabase/migrations/*.sql (filename order) -> supabase/tests/rls_check.sql.
// Exit 0 only if rls_check raises its intentional "RLS OK ..." exception.
//
// Options (flag or env var):
//   --until=<prefix>   / DRY_RUN_UNTIL   stop after the last migration whose filename <= prefix
//                                        (e.g. --until=20261111001100)
//   --rls=<file>       / DRY_RUN_RLS     use another rls_check file ("-" reads stdin,
//                                        e.g. `git show HEAD:supabase/tests/rls_check.sql | npm run db:dry-run -- --rls=-`)
//   --no-rls                             only apply migrations
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const migrationsDir = path.join(repo, "supabase/migrations");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m || !["until", "rls", "no-rls"].includes(m[1])) fail(`unknown argument: ${a}`);
    return [m[1], m[2] ?? true];
  }),
);
const until = args.until ?? process.env.DRY_RUN_UNTIL;
const rlsArg = args.rls ?? process.env.DRY_RUN_RLS ?? path.join(repo, "supabase/tests/rls_check.sql");
const skipRls = args["no-rls"] === true;

function fail(msg) {
  console.error(`DRY-RUN FAIL: ${msg}`);
  process.exit(1);
}

// Turn a 1-based character position from a Postgres error into "line N: <text>".
function locate(sql, err) {
  const pos = Number(err?.position);
  if (!pos) return "";
  const before = sql.slice(0, pos - 1);
  const line = before.split("\n").length;
  const text = sql.split("\n")[line - 1]?.trim() ?? "";
  return ` (line ${line}: ${text.slice(0, 160)})`;
}

// Errors inside a DO block report "inline_code_block line N" relative to the opening $tag$.
// If the file has exactly one DO block, translate that to a file line.
function doBlockLine(sql, err) {
  const m = /inline_code_block line (\d+)/.exec(err?.where ?? "");
  if (!m) return "";
  const lines = sql.split("\n");
  const starts = lines.flatMap((l, i) => (/^\s*do\s+\$\w*\$/i.test(l) ? [i + 1] : []));
  if (starts.length !== 1) return "";
  const fileLine = starts[0] + Number(m[1]) - 1;
  return ` (~file line ${fileLine}: ${(lines[fileLine - 1] ?? "").trim().slice(0, 160)})`;
}

function describe(err) {
  const parts = [err?.message ?? String(err)];
  if (err?.detail) parts.push(`detail: ${err.detail}`);
  if (err?.hint) parts.push(`hint: ${err.hint}`);
  if (err?.where) parts.push(`where: ${err.where}`);
  return parts.join("\n  ");
}

async function apply(db, label, sql) {
  try {
    await db.exec(sql);
  } catch (err) {
    fail(`${label}${locate(sql, err)}\n  ${describe(err)}`);
  }
}

const db = new PGlite();
await apply(db, "stubs.sql", fs.readFileSync(path.join(here, "stubs.sql"), "utf8"));

let files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
if (until) files = files.filter((f) => f.slice(0, String(until).length) <= String(until));
if (files.length === 0) fail("no migrations selected");
for (const f of files) {
  await apply(db, `migration ${f}`, fs.readFileSync(path.join(migrationsDir, f), "utf8"));
  console.log(`applied ${f}`);
}

if (skipRls) {
  console.log(`OK — ${files.length} migrations applied (rls_check skipped)`);
  await db.close();
  process.exit(0);
}

const rlsAbs = path.resolve(String(rlsArg));
const rlsLabel =
  rlsArg === "-" ? "rls_check (stdin)" : rlsAbs.startsWith(repo + path.sep) ? path.relative(repo, rlsAbs) : rlsAbs;
const rlsSql = rlsArg === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(rlsAbs, "utf8");
try {
  await db.exec(rlsSql);
} catch (err) {
  const msg = err?.message ?? String(err);
  if (msg.startsWith("RLS OK")) {
    const count = /all (\d+) checks/.exec(msg)?.[1] ?? "?";
    console.log(`RLS OK — ${count} checks (${files.length} migrations, ${rlsLabel})`);
    await db.close();
    process.exit(0);
  }
  fail(`${rlsLabel}${locate(rlsSql, err) || doBlockLine(rlsSql, err)}\n  ${describe(err)}`);
}
fail(`${rlsLabel} finished without raising "RLS OK" — the script must end with its intentional exception`);
