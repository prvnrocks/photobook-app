#!/usr/bin/env node
// Comp a book (D-061): the ONLY non-webhook path that sets books.is_paid. Admin-only.
//
// Calls public.comp_book (migration 1700, service-role only) with the secret key: one 'comped' order
// (AED 0, note = reason, comped_by = admin) + is_paid / max_pages 100 / no expiry. Prints the result
// only: comped | already_paid | not_found. No revert flag on purpose — see docs/RUNBOOK.md
// ("Reverting a comp") for the manual SQL.
//
// Usage:
//   node scripts/comp-book.mjs --book <book uuid> --admin <your user uuid> --reason "demo"
//
// Env (process env first, then .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
// ADMIN_USER_IDS (comma-separated uuids; --admin must be listed). Point it at the right project:
// .env.local usually holds the DEV project — export prod values in the shell for a prod comp.
//
// Exit codes: 0 = comped / already_paid, 1 = not_found or an RPC error, 2 = bad arguments / env.
// Importable for tests: parseArgs, validate, compBook.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const RESULTS = ["comped", "already_paid", "not_found"];

export class UsageError extends Error {}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === "revert") throw new UsageError("--revert is not supported: see docs/RUNBOOK.md (Reverting a comp)");
    if (!["book", "admin", "reason"].includes(key)) throw new UsageError(`unknown flag: ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`missing value for ${a}`);
    out[key] = v;
  }
  return out;
}

/** Returns { book, admin, reason } or throws UsageError. adminIds = raw ADMIN_USER_IDS. */
export function validate(args, adminIds) {
  const book = (args.book ?? "").trim();
  const admin = (args.admin ?? "").trim();
  const reason = (args.reason ?? "").trim();
  if (!UUID_RE.test(book)) throw new UsageError("--book must be a uuid");
  if (!UUID_RE.test(admin)) throw new UsageError("--admin must be a uuid");
  const allowed = (adminIds ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => UUID_RE.test(s));
  if (!allowed.includes(admin.toLowerCase())) throw new UsageError("--admin is not listed in ADMIN_USER_IDS");
  const len = [...reason].length;
  if (len < 1 || len > 200 || CONTROL_RE.test(reason)) {
    throw new UsageError("--reason must be 1-200 characters, no control characters");
  }
  return { book: book.toLowerCase(), admin: admin.toLowerCase(), reason };
}

/** Calls comp_book through a supabase-js client (secret key). Returns the result string. */
export async function compBook(client, { book, admin, reason }) {
  const { data, error } = await client.rpc("comp_book", { p_book: book, p_admin: admin, p_reason: reason });
  if (error) {
    const code = String(error.code ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
    throw new Error(`comp_book failed (${code})`);
  }
  if (!RESULTS.includes(data)) throw new Error("comp_book failed (bad_result)");
  return data;
}

async function main() {
  const envFile = path.join(process.cwd(), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables already set
  let input;
  try {
    input = validate(parseArgs(process.argv.slice(2)), process.env.ADMIN_USER_IDS);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "bad arguments");
    console.error('usage: node scripts/comp-book.mjs --book <uuid> --admin <uuid> --reason "demo"');
    process.exit(2);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (env or .env.local)");
    process.exit(2);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const result = await compBook(client, input);
    console.log(result);
    process.exit(result === "not_found" ? 1 : 0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "comp_book failed");
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
