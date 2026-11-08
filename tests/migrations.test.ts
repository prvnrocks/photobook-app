import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static security checks on supabase/migrations/*.sql (no database needed).
// The live counterpart is supabase/tests/rls_check.sql (run by a human in the
// Supabase SQL Editor).

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** Remove `-- line` and block comments, keeping $$ bodies and string literals intact. */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let inDollar = false;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (!inString && two === "$$") {
      inDollar = !inDollar;
      out += two;
      i += 2;
      continue;
    }
    if (!inDollar && sql[i] === "'") {
      inString = !inString;
      out += sql[i++];
      continue;
    }
    if (!inString && two === "--") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (!inString && two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    out += sql[i++];
  }
  return out;
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const migrations = files.map((name) => ({
  name,
  sql: stripSqlComments(readFileSync(join(MIGRATIONS_DIR, name), "utf8")).toLowerCase(),
}));

const all = migrations.map((m) => m.sql).join("\n;\n");

function matchesAll(re: RegExp, text = all): RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- parsed pieces --------------------------------------------------------
const tables = matchesAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/).map((m) => m[1]);

interface Policy {
  table: string; // e.g. public.books, storage.objects
  text: string;
}
const policies: Policy[] = matchesAll(/create\s+policy\s+(?:"[^"]*"|\w+)\s+on\s+([\w.]+)([\s\S]*?);/).map(
  (m) => ({ table: m[1], text: m[0] }),
);

interface SqlFunction {
  name: string; // schema.name
  header: string; // between `create function` and `as $$`
  body: string;
}
const functions: SqlFunction[] = matchesAll(
  /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/,
).map((m) => ({ name: m[1], header: m[2], body: m[3] }));

/** Latest definition of a function (later migrations `create or replace` earlier ones). */
function latestFunction(name: string): SqlFunction | undefined {
  return functions.filter((f) => f.name === name).at(-1);
}

const latest = migrations.at(-1)!;

// --- table privilege simulation -----------------------------------------
// Replays every `grant|revoke <privs> on [table] public.x[, ...] to|from <roles>`
// in file order. Starting point = Supabase's default privileges in schema public
// (ALL to anon, authenticated, service_role on new tables).
const ALL_PRIVS = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];
const API_ROLES = ["anon", "authenticated", "service_role"];
type Acl = Record<string, Record<string, Set<string>>>; // table -> role -> privs

let parsedAclStatements = 0;
function effectiveTablePrivileges(): Acl {
  const acl: Acl = {};
  parsedAclStatements = 0;
  for (const t of tables) {
    acl[`public.${t}`] = Object.fromEntries(API_ROLES.map((r) => [r, new Set(ALL_PRIVS)]));
  }
  const stmt =
    /\b(grant|revoke)\s+([a-z_\s,]+?)\s+on\s+(?:table\s+)?((?:public\.\w+\s*,\s*)*public\.\w+)\s+(to|from)\s+([a-z_\s,]+?)\s*;/g;
  for (const m of all.matchAll(stmt)) {
    parsedAclStatements++;
    const [, verb, privList, tableList, , roleList] = m;
    const privs = privList.trim() === "all" || privList.trim() === "all privileges"
      ? ALL_PRIVS
      : privList.split(",").map((p) => p.trim());
    const targets = tableList.split(",").map((t) => t.trim());
    const roles = roleList.split(",").map((r) => r.trim());
    for (const t of targets) {
      acl[t] ??= {};
      for (const r of roles) {
        acl[t][r] ??= new Set();
        for (const p of privs) {
          if (verb === "grant") acl[t][r].add(p);
          else acl[t][r].delete(p);
        }
      }
    }
  }
  return acl;
}

const sorted = (s: Set<string> | undefined) => [...(s ?? [])].sort();

describe("migrations: files", () => {
  it("found the migration files and parsed them", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(tables.length).toBeGreaterThan(0);
    expect(policies.length).toBeGreaterThan(0);
    expect(functions.length).toBeGreaterThan(0);
  });
});

describe("migrations: RLS on every table", () => {
  it.each(tables)("public.%s has RLS enabled and at least one policy", (t) => {
    expect(all).toMatch(new RegExp(`alter\\s+table\\s+public\\.${esc(t)}\\s+enable\\s+row\\s+level\\s+security`));
    expect(policies.filter((p) => p.table === `public.${t}`).length).toBeGreaterThanOrEqual(1);
  });

  it("never disables RLS", () => {
    expect(all).not.toMatch(/disable\s+row\s+level\s+security/);
    expect(all).not.toMatch(/no\s+force\s+row\s+level\s+security/);
  });

  it("every policy has an explicit role and none is to anon/public", () => {
    for (const p of policies) {
      const to = p.text.match(/\bto\s+([a-z_]+(?:\s*,\s*[a-z_]+)*)/);
      // Omitting TO means TO PUBLIC (includes anon) — require it explicitly.
      expect(to, `policy without TO clause: ${p.text.slice(0, 80)}`).not.toBeNull();
      const roles = to![1].split(",").map((r) => r.trim());
      expect(roles, p.text.slice(0, 80)).not.toContain("anon");
      expect(roles, p.text.slice(0, 80)).not.toContain("public");
    }
  });
});

describe("migrations: explicit table grants", () => {
  const core = ["profiles", "books", "photos", "orders"];
  const acl = effectiveTablePrivileges();

  it("parsed the table grant/revoke statements (guards against a vacuous replay)", () => {
    // 0100: truncate + orders revokes; 0300: 2 revoke all + 4 grants.
    expect(parsedAclStatements).toBeGreaterThanOrEqual(8);
  });

  it("the hardening migration revokes all from anon and authenticated on the 4 core tables", () => {
    const hardening = migrations.find((m) => m.name.endsWith("_hardening.sql"));
    expect(hardening, "hardening migration missing").toBeDefined();
    for (const role of ["anon", "authenticated"]) {
      const m = hardening!.sql.match(
        new RegExp(`revoke\\s+all\\s+on\\s+(?:table\\s+)?([^;]*?)\\s+from\\s+${role}\\s*;`),
      );
      expect(m, `revoke all ... from ${role}`).not.toBeNull();
      const listed = m![1].split(",").map((t) => t.trim());
      for (const t of core) expect(listed, `${role}: ${t}`).toContain(`public.${t}`);
    }
  });

  it.each(core)("anon ends with no privileges on public.%s", (t) => {
    expect(sorted(acl[`public.${t}`]?.anon)).toEqual([]);
  });

  it.each([
    ["books", ["delete", "insert", "select", "update"]],
    ["photos", ["delete", "insert", "select", "update"]],
    ["profiles", ["select", "update"]],
    ["orders", ["select"]],
  ])("authenticated ends with exactly the expected privileges on public.%s", (t, expected) => {
    expect(sorted(acl[`public.${t}`]?.authenticated)).toEqual(expected);
  });

  it.each(core)("service_role keeps all privileges on public.%s", (t) => {
    expect(sorted(acl[`public.${t}`]?.service_role)).toEqual([...ALL_PRIVS].sort());
  });

  it("new public functions are not executable by public/anon by default", () => {
    expect(all).toMatch(
      /alter\s+default\s+privileges\s+in\s+schema\s+public\s+revoke\s+execute\s+on\s+functions\s+from\s+public\s*,\s*anon/,
    );
  });

  it("re-grants get_published_book to anon, authenticated after the default-privilege change", () => {
    const def = latest.sql.search(/alter\s+default\s+privileges\s+in\s+schema\s+public/);
    const grant = all.lastIndexOf("grant execute on function public.get_published_book(text) to anon, authenticated");
    expect(grant).toBeGreaterThanOrEqual(0);
    if (def >= 0) {
      const latestGrant = latest.sql.search(
        /grant\s+execute\s+on\s+function\s+public\.get_published_book\s*\(text\)\s+to\s+anon\s*,\s*authenticated/,
      );
      expect(latestGrant).toBeGreaterThan(def);
    }
  });
});

describe("migrations: constraints", () => {
  it.each(["original_path", "web_path", "thumb_path"])(
    "photos.%s must be null or under {user_id}/{book_id}/",
    (col) => {
      expect(all).toMatch(
        new RegExp(
          `check\\s*\\(\\s*${col}\\s+is\\s+null\\s+or\\s+${col}\\s+like\\s+\\(\\s*user_id::text\\s*\\|\\|\\s*'/'\\s*\\|\\|\\s*book_id::text\\s*\\|\\|\\s*'/%'\\s*\\)\\s*\\)`,
        ),
      );
    },
  );

  it("photo path constraints are not NOT VALID", () => {
    expect(all).not.toMatch(/photos_\w+_path_owner[^;]*not\s+valid/);
  });

  it("books.doc is limited to 1 MiB", () => {
    expect(all).toMatch(/check\s*\(\s*pg_column_size\s*\(\s*doc\s*\)\s*<=\s*1048576\s*\)/);
  });

  it.each([
    ["occasion", 40],
    ["tone", 40],
    ["name", 120],
    ["place", 200],
    ["camera", 120],
    ["drop_reason", 200],
  ])("char_length(%s) <= %i", (col, max) => {
    expect(all).toMatch(new RegExp(`check\\s*\\(\\s*char_length\\s*\\(\\s*${col}\\s*\\)\\s*<=\\s*${max}\\s*\\)`));
  });

  it("handle_new_user (latest) truncates the name to 120 chars and stays definer", () => {
    const f = latestFunction("private.handle_new_user");
    expect(f).toBeDefined();
    expect(f!.header).toMatch(/security\s+definer/);
    expect(f!.body).toMatch(/left\s*\(\s*coalesce\s*\([\s\S]*?\)\s*,\s*120\s*\)/);
  });
});

describe("migrations: functions", () => {
  it.each(functions.map((f) => [f.name, f] as const))("%s sets search_path = ''", (_n, f) => {
    expect(f.header).toMatch(/set\s+search_path\s*=\s*''/);
  });

  it("security definer functions are in schema private or are public.get_published_book", () => {
    const definers = functions.filter((f) => /security\s+definer/.test(f.header));
    expect(definers.length).toBeGreaterThan(0);
    for (const f of definers) {
      expect(f.name.startsWith("private.") || f.name === "public.get_published_book", f.name).toBe(true);
    }
  });

  it("private.protect_book_columns is SECURITY INVOKER (current_user check relies on it)", () => {
    const defs = functions.filter((x) => x.name === "private.protect_book_columns");
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) expect(d.header).not.toMatch(/security\s+definer/);
    const f = latestFunction("private.protect_book_columns");
    expect(f!.body).toMatch(/current_user/);
    for (const col of ["id", "created_at", "is_paid", "max_pages", "expires_at", "slug", "published_at", "user_id"]) {
      expect(f!.body, col).toMatch(new RegExp(`new\\.${col}\\s*:=`));
    }
    expect(all).toMatch(
      /create\s+trigger\s+\w+\s+before\s+insert\s+or\s+update\s+on\s+public\.books[\s\S]*?private\.protect_book_columns\(\)/,
    );
  });
});

describe("migrations: public.get_published_book", () => {
  const f = latestFunction("public.get_published_book");

  it("exists and is security definer", () => {
    expect(f).toBeDefined();
    expect(f!.header).toMatch(/security\s+definer/);
  });

  it("never returns or selects user_id", () => {
    expect(f!.header).not.toMatch(/\buser_id\b/);
    expect(f!.body).not.toMatch(/\buser_id\b/);
    expect(f!.body).not.toMatch(/\bb\.\*|select\s+\*/);
  });

  it("uses password_hash only in IS [NOT] NULL tests", () => {
    expect(f!.header).not.toMatch(/password_hash/);
    const total = matchesAll(/password_hash/, f!.body).length;
    const nullTests = matchesAll(/password_hash\s+is\s+(?:not\s+)?null/, f!.body).length;
    expect(total).toBeGreaterThan(0);
    expect(nullTests).toBe(total);
  });

  it("only returns published rows", () => {
    expect(f!.body).toMatch(/published_at\s+is\s+not\s+null/);
  });

  it("revokes from public before granting to anon, authenticated", () => {
    const revoke = all.search(/revoke\s+all\s+on\s+function\s+public\.get_published_book\s*\([^)]*\)\s+from\s+public/);
    const grant = all.search(
      /grant\s+execute\s+on\s+function\s+public\.get_published_book\s*\([^)]*\)\s+to\s+anon\s*,\s*authenticated/,
    );
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(grant).toBeGreaterThan(revoke);
  });
});

describe("migrations: orders", () => {
  it("revokes insert, update, delete from anon, authenticated", () => {
    expect(all).toMatch(/revoke\s+insert\s*,\s*update\s*,\s*delete\s+on\s+public\.orders\s+from\s+anon\s*,\s*authenticated/);
  });

  it("has only a select policy", () => {
    const ops = policies.filter((p) => p.table === "public.orders").map((p) => p.text.match(/\bfor\s+(\w+)/)?.[1]);
    expect(ops).toEqual(["select"]);
  });
});

describe("migrations: Milestone 1 scope", () => {
  // These tables arrive in Milestone 3; relax this test then.
  it.each(["agent_runs", "agent_steps", "user_memory"])("does not create %s", (t) => {
    expect(tables).not.toContain(t);
  });
});

describe("migrations: storage", () => {
  const bucketTuples = matchesAll(/\(\s*'(\w+)'\s*,\s*'\w+'\s*,\s*(true|false)\b/);

  it.each(["photos", "exports"])("bucket %s is inserted with public = false", (b) => {
    expect(all).toMatch(/insert\s+into\s+storage\.buckets\s*\(\s*id\s*,\s*name\s*,\s*public\b/);
    const t = bucketTuples.find((m) => m[1] === b);
    expect(t, `bucket ${b} not inserted`).toBeDefined();
    expect(t![2]).toBe("false");
  });

  it("every storage.objects policy checks bucket_id and owner folder in each clause", () => {
    const storagePolicies = policies.filter((p) => p.table === "storage.objects");
    expect(storagePolicies.length).toBeGreaterThan(0);
    for (const p of storagePolicies) {
      const clauses = matchesAll(/\b(?:using|with\s+check)\s*\(/, p.text).length;
      const bucket = matchesAll(/bucket_id\s*=\s*'\w+'/, p.text).length;
      const folder = matchesAll(
        /\(\s*storage\.foldername\s*\(\s*name\s*\)\s*\)\s*\[\s*1\s*\]\s*=\s*\(\s*select\s+auth\.uid\s*\(\s*\)\s*\)\s*::\s*text/,
        p.text,
      ).length;
      expect(clauses, p.text.slice(0, 80)).toBeGreaterThan(0);
      expect(bucket, p.text.slice(0, 80)).toBe(clauses);
      expect(folder, p.text.slice(0, 80)).toBe(clauses);
    }
  });

  it("exports bucket has no client write policies", () => {
    const exportWrites = policies.filter(
      (p) => p.table === "storage.objects" && /'exports'/.test(p.text) && !/\bfor\s+select\b/.test(p.text),
    );
    expect(exportWrites).toEqual([]);
  });
});
