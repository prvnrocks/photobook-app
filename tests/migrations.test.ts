import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** Tables with RLS on and no policies: only the service role (BYPASSRLS) touches them. */
const SERVICE_ROLE_ONLY_TABLES = ["agent_steps", "book_unlock_attempts"];

describe("migrations: files", () => {
  it("found the migration files and parsed them", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(tables.length).toBeGreaterThan(0);
    expect(policies.length).toBeGreaterThan(0);
    expect(functions.length).toBeGreaterThan(0);
  });
});

describe("migrations: RLS on every table", () => {
  it.each(tables)("public.%s has RLS enabled and at least one policy (or is service-role only)", (t) => {
    expect(all).toMatch(new RegExp(`alter\\s+table\\s+public\\.${esc(t)}\\s+enable\\s+row\\s+level\\s+security`));
    if (SERVICE_ROLE_ONLY_TABLES.includes(t)) {
      // No policies on purpose: clients get no grants at all (checked in the 0600 suite).
      expect(policies.filter((p) => p.table === `public.${t}`)).toEqual([]);
    } else {
      expect(policies.filter((p) => p.table === `public.${t}`).length).toBeGreaterThanOrEqual(1);
    }
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

  it("exists; the latest definition (1000) is SECURITY INVOKER (read by the server with the admin client)", () => {
    expect(f).toBeDefined();
    expect(f!.header).toMatch(/security\s+invoker/);
    expect(f!.header).not.toMatch(/security\s+definer/);
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

  it("only returns published rows (live = published_doc is not null)", () => {
    expect(f!.body).toMatch(/published_at\s+is\s+not\s+null/);
    expect(f!.body).toMatch(/published_doc\s+is\s+not\s+null/);
  });

  it("0200 revoked from public before granting to anon, authenticated (superseded by 1000)", () => {
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

describe("migrations: Milestone 3 scope", () => {
  it.each(["agent_runs", "agent_steps", "user_memory"])("creates %s", (t) => {
    expect(tables).toContain(t);
  });

  it("never creates the superseded ai_usage table", () => {
    expect(tables).not.toContain("ai_usage");
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

describe("migrations: Milestone 2 photo upload (0400)", () => {
  const upload = migrations.find((m) => m.name.endsWith("_photo_upload.sql"));

  it("the photo upload migration exists", () => {
    expect(upload, "20261108000400_photo_upload.sql missing").toBeDefined();
  });

  it.each([
    ["fingerprint", /add\s+column\s+fingerprint\s+text\s+not\s+null\b/],
    ["upload_state", /add\s+column\s+upload_state\s+text\s+not\s+null\s+default\s+'pending'/],
    ["original_bytes", /add\s+column\s+original_bytes\s+integer\b/],
    ["original_mime", /add\s+column\s+original_mime\s+text\b/],
  ])("photos.%s is added", (_col, re) => {
    expect(upload!.sql).toMatch(re);
  });

  it("fingerprint length is checked (16..128)", () => {
    expect(upload!.sql).toMatch(/check\s*\(\s*char_length\s*\(\s*fingerprint\s*\)\s+between\s+16\s+and\s+128\s*\)/);
  });

  it("(book_id, fingerprint) is unique as photos_book_fingerprint_key", () => {
    expect(upload!.sql).toMatch(
      /add\s+constraint\s+photos_book_fingerprint_key\s+unique\s*\(\s*book_id\s*,\s*fingerprint\s*\)/,
    );
  });

  it("upload_state, original_bytes, original_mime are checked", () => {
    expect(upload!.sql).toMatch(/check\s*\(\s*upload_state\s+in\s*\(\s*'pending'\s*,\s*'ready'\s*\)\s*\)/);
    expect(upload!.sql).toMatch(/check\s*\(\s*original_bytes\s*>\s*0\s*\)/);
    expect(upload!.sql).toMatch(
      /check\s*\(\s*original_mime\s+in\s*\(\s*'image\/jpeg'\s*,\s*'image\/png'\s*,\s*'image\/webp'\s*\)\s*\)/,
    );
  });

  it("does not add column-level grants or change table grants", () => {
    expect(upload!.sql).not.toMatch(/\b(grant|revoke)\s+[a-z_\s,]+\s+on\s+(?:table\s+)?public\./);
  });

  it("private.enforce_photo_cap is SECURITY INVOKER with search_path ''", () => {
    const f = latestFunction("private.enforce_photo_cap");
    expect(f).toBeDefined();
    expect(f!.header).not.toMatch(/security\s+definer/);
    expect(f!.header).toMatch(/security\s+invoker/);
    expect(f!.header).toMatch(/set\s+search_path\s*=\s*''/);
    expect(f!.body).toMatch(/pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*new\.book_id::text\s*,\s*0\s*\)\s*\)/);
    expect(f!.body).toMatch(/raise\s+exception\s+'photo_limit_reached'[\s\S]*?errcode\s*=\s*'p0001'/);
    // Cap applies to everyone: no role-based exemption.
    expect(f!.body).not.toMatch(/current_user|service_role|auth\.role/);
  });

  it("enforce_photo_cap is revoked from public, anon, authenticated", () => {
    expect(upload!.sql).toMatch(
      /revoke\s+all\s+on\s+function\s+private\.enforce_photo_cap\s*\(\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/,
    );
  });

  it("a BEFORE INSERT row trigger on public.photos runs enforce_photo_cap", () => {
    expect(all).toMatch(
      /create\s+trigger\s+\w+\s+before\s+insert\b[^;]*?\bon\s+public\.photos\s+for\s+each\s+row\s+execute\s+function\s+private\.enforce_photo_cap\(\)/,
    );
  });

  const limitsPath = join(process.cwd(), "src", "lib", "ai", "limits.ts");
  const capTest = existsSync(limitsPath) ? it : it.todo;
  capTest("cap numbers in the SQL equal LIMITS.free/paid.maxUploadPhotos (src/lib/ai/limits.ts)", async () => {
    const { LIMITS } = (await import("@/lib/ai/limits")) as {
      LIMITS: { free: { maxUploadPhotos: number }; paid: { maxUploadPhotos: number } };
    };
    const f = latestFunction("private.enforce_photo_cap")!;
    const m = f.body.match(/case\s+when\s+v_is_paid\s+then\s+(\d+)\s+else\s+(\d+)\s+end/);
    expect(m, "cap CASE expression not found").not.toBeNull();
    expect(Number(m![1])).toBe(LIMITS.paid.maxUploadPhotos);
    expect(Number(m![2])).toBe(LIMITS.free.maxUploadPhotos);
  });
});

describe("migrations: Milestone 2 review fixes — photo integrity (0500)", () => {
  const m = migrations.find((x) => x.name.endsWith("_photo_integrity.sql"));
  const sql = m?.sql ?? "";
  const ws = (s: string) => s.replace(/\s+/g, " ");
  const flat = ws(sql);

  it("the photo integrity migration exists and is the 0500 file", () => {
    expect(m, "20261108000500_photo_integrity.sql missing").toBeDefined();
    expect(m!.name).toBe("20261108000500_photo_integrity.sql");
  });

  it("ready rows must have paths, dimensions, mime and bytes (NOT VALID, then VALIDATE)", () => {
    const re =
      /add constraint photos_ready_complete check \( upload_state <> 'ready' or \( original_path is not null and web_path is not null and thumb_path is not null and width > 0 and height > 0 and original_mime is not null and original_bytes > 0 \) \) not valid/;
    expect(flat).toMatch(re);
    expect(flat).toMatch(/alter table public\.photos validate constraint photos_ready_complete/);
    expect(flat.search(/validate constraint photos_ready_complete/)).toBeGreaterThan(
      flat.search(/add constraint photos_ready_complete/),
    );
  });

  it.each([
    ["ai ≤ 16 KiB", /check \( ?pg_column_size\(ai\) <= 16384 ?\)/],
    ["phash 16 lowercase hex", /check \( ?phash is null or phash ~ '\^\[0-9a-f\]\{16\}\$' ?\)/],
    ["width 1..20000", /check \( ?width between 1 and 20000 ?\)/],
    ["height 1..20000", /check \( ?height between 1 and 20000 ?\)/],
    ["blur_score ≥ 0", /check \( ?blur_score >= 0 ?\)/],
    ["place_checked_at column", /add column place_checked_at timestamptz/],
  ])("%s", (_n, re) => {
    expect(flat).toMatch(re);
  });

  it.each([
    ["original_path", String.raw`'-original\.(jpg|png|webp)$'`],
    ["web_path", String.raw`'-web\.jpg$'`],
    ["thumb_path", String.raw`'-thumb\.jpg$'`],
  ])("%s must match {user_id}/{book_id}/{id}-… exactly", (col, suffix) => {
    expect(flat).toContain(
      `add constraint photos_${col}_format check ( ${col} is null or ${col} ~ ('^' || user_id::text || '/' || book_id::text || '/' || id::text || ${suffix}) )`,
    );
  });

  describe("private.protect_photo_columns guard", () => {
    const f = latestFunction("private.protect_photo_columns");

    it("is SECURITY INVOKER with search_path '' and checks current_user like protect_book_columns", () => {
      expect(f).toBeDefined();
      expect(f!.header).not.toMatch(/security\s+definer/);
      expect(f!.header).toMatch(/security\s+invoker/);
      expect(f!.header).toMatch(/set\s+search_path\s*=\s*''/);
      expect(ws(f!.body)).toMatch(
        /if current_user in \('postgres', 'service_role', 'supabase_admin'\) then return new; end if;/,
      );
    });

    const insertPart = () => ws(f!.body).split("elsif tg_op = 'update'")[0];
    const updatePart = () => ws(f!.body).split("elsif tg_op = 'update'")[1] ?? "";

    it.each([
      ["ai", "null"],
      ["dup_group", "null"],
      ["place", "null"],
      ["place_checked_at", "null"],
      ["status", "'kept'"],
      ["drop_reason", "null"],
      ["user_override", "false"],
    ])("INSERT forces new.%s := %s", (col, value) => {
      expect(insertPart()).toContain(`new.${col} := ${value};`);
    });

    it.each(["id", "created_at", "user_id", "book_id", "fingerprint", "ai", "dup_group", "place", "place_checked_at"])(
      "UPDATE keeps old.%s",
      (col) => {
        expect(updatePart()).toContain(`new.${col} := old.${col};`);
      },
    );

    it("UPDATE of a ready row keeps it ready and freezes the file columns", () => {
      const ready = updatePart().match(/if old\.upload_state = 'ready' then([\s\S]*?)end if;/);
      expect(ready).not.toBeNull();
      expect(ready![1]).toContain("new.upload_state := 'ready';");
      for (const col of ["original_path", "web_path", "thumb_path", "original_mime", "original_bytes", "width", "height"]) {
        expect(ready![1], col).toContain(`new.${col} := old.${col};`);
      }
    });

    it("leaves status / drop_reason / user_override client-updatable (user decides, M3 review)", () => {
      for (const col of ["status", "drop_reason", "user_override"]) {
        expect(updatePart()).not.toContain(`new.${col} :=`);
      }
    });

    it("requires the three storage objects before a row becomes ready", () => {
      const body = ws(f!.body);
      expect(body).toMatch(/from storage\.objects as o where o\.bucket_id = 'photos'/);
      expect(body).toMatch(/raise exception 'photo_files_missing' using errcode = '23514'/);
    });

    it("runs as a BEFORE INSERT OR UPDATE row trigger and is not executable by clients", () => {
      expect(flat).toMatch(
        /create trigger photos_protect_columns before insert or update on public\.photos for each row execute function private\.protect_photo_columns\(\)/,
      );
      expect(flat).toMatch(
        /revoke all on function private\.protect_photo_columns\(\) from public, anon, authenticated/,
      );
      // fires after photos_enforce_cap (alphabetical BEFORE-trigger order), so moves into a full book still fail
      expect("photos_enforce_cap" < "photos_protect_columns").toBe(true);
    });
  });

  it("photos bucket allows only jpeg/png/webp", () => {
    expect(flat).toMatch(
      /update storage\.buckets set allowed_mime_types = array\['image\/jpeg', 'image\/png', 'image\/webp'\] where id = 'photos'/,
    );
  });

  describe("storage.objects write policies for bucket photos", () => {
    it("drops and recreates photos_insert_own / photos_update_own on storage.objects", () => {
      expect(flat).toContain('drop policy "photos_insert_own" on storage.objects;');
      expect(flat).toContain('drop policy "photos_update_own" on storage.objects;');
    });

    const created = matchesAll(/create\s+policy\s+"(photos_(?:insert|update)_own)"\s+on\s+storage\.objects([\s\S]*?);/, sql);

    it("both are recreated", () => {
      expect(created.map((c) => c[1]).sort()).toEqual(["photos_insert_own", "photos_update_own"]);
    });

    it.each(["photos_insert_own", "photos_update_own"])(
      "%s requires the exact object name and an own pending photo row in every clause",
      (name) => {
        const p = ws(created.find((c) => c[1] === name)![2]);
        const clauses = matchesAll(/\b(?:using|with check) \(/, p).length;
        expect(clauses).toBe(name === "photos_insert_own" ? 1 : 2);
        const uuid = "\\[0-9a-f\\]\\{8\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{12\\}";
        const nameRe = new RegExp(
          `objects\\.name ~ '\\^${uuid}/${uuid}/${uuid}-\\(original\\\\\\.\\(jpg\\|png\\|webp\\)\\|web\\\\\\.jpg\\|thumb\\\\\\.jpg\\)\\$'`,
        );
        expect(matchesAll(nameRe, p).length).toBe(clauses);
        expect(matchesAll(/exists \( select 1 from public\.photos as p/, p).length).toBe(clauses);
        expect(matchesAll(/p\.id = left\(split_part\(objects\.name, '\/', 3\), 36\)::uuid/, p).length).toBe(clauses);
        expect(matchesAll(/p\.book_id = split_part\(objects\.name, '\/', 2\)::uuid/, p).length).toBe(clauses);
        expect(matchesAll(/p\.user_id = \(select auth\.uid\(\)\)/, p).length).toBe(clauses);
        expect(matchesAll(/p\.upload_state = 'pending'/, p).length).toBe(clauses);
        expect(p).toContain("to authenticated");
      },
    );

    it("select/delete own-folder policies for photos are kept (not dropped)", () => {
      expect(flat).not.toMatch(/drop policy "photos_(select|delete)_own" on storage\.objects/);
    });
  });

  describe("finalize rate limit (private.finalize_runs + RPCs)", () => {
    it("table lives in schema private with RLS on, cascades with the book", () => {
      expect(flat).toMatch(
        /create table private\.finalize_runs \( book_id uuid primary key references public\.books \(id\) on delete cascade, last_run_at timestamptz not null, day date not null/,
      );
      expect(flat).toMatch(/alter table private\.finalize_runs enable row level security/);
    });

    it("has no client grants — service role only", () => {
      expect(flat).toMatch(/revoke all on table private\.finalize_runs from public, anon, authenticated/);
      const grants = matchesAll(/grant ([a-z_, ]+?) on (?:table )?private\.finalize_runs to ([a-z_, ]+?);/, flat);
      expect(grants.length).toBeGreaterThan(0);
      for (const g of grants) expect(g[2].trim()).toBe("service_role");
      expect(flat).not.toMatch(/grant [^;]* on schema private to [^;]*(anon|authenticated|public)/);
    });

    it.each([
      ["public.claim_finalize_run", "uuid, integer"],
      ["public.reserve_geocode_calls", "uuid, integer, integer"],
    ])("%s is SECURITY INVOKER, revoked from clients, executable by service_role only", (name, sig) => {
      const f = latestFunction(name);
      expect(f).toBeDefined();
      expect(f!.header).toMatch(/security\s+invoker/);
      expect(f!.header).not.toMatch(/security\s+definer/);
      expect(f!.body).toMatch(/private\.finalize_runs/);
      const esc2 = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(flat).toMatch(
        new RegExp(`revoke all on function ${esc2(name)}\\(${esc2(sig)}\\) from public, anon, authenticated`),
      );
      const grants = matchesAll(new RegExp(`grant execute on function ${esc2(name)}\\([^)]*\\) to ([a-z_, ]+?);`), all);
      expect(grants.map((g) => g[1].trim())).toEqual(["service_role"]);
    });

    it("claim is a single atomic upsert guarded by the interval", () => {
      const body = ws(latestFunction("public.claim_finalize_run")!.body);
      expect(body).toMatch(
        /insert into private\.finalize_runs as r \(book_id, last_run_at\) values \(p_book_id, v_now\) on conflict \(book_id\) do update set last_run_at = excluded\.last_run_at where r\.last_run_at <= excluded\.last_run_at - make_interval\(secs => p_min_interval_seconds\) returning true into v_claimed/,
      );
    });

    it("geocode reservation locks the row and never exceeds the daily cap", () => {
      const body = ws(latestFunction("public.reserve_geocode_calls")!.body);
      expect(body).toMatch(/for update;/);
      expect(body).toMatch(/v_granted := least\(p_want, greatest\(0, p_daily_cap - v_used\)\)/);
    });
  });

  it("does not change table grants on public tables", () => {
    expect(sql).not.toMatch(/\b(grant|revoke)\s+[a-z_\s,]+\s+on\s+(?:table\s+)?public\./);
  });
});

describe("migrations: Milestone 3 agent pipeline (0600)", () => {
  const m = migrations.find((x) => x.name.endsWith("_agent_pipeline.sql"));
  const sql = m?.sql ?? "";
  const ws = (s: string) => s.replace(/\s+/g, " ");
  const flat = ws(sql);
  const acl = effectiveTablePrivileges();
  const agentTables = ["agent_runs", "agent_steps", "user_memory"];

  it("the agent pipeline migration exists and is the 0600 file", () => {
    expect(m, "20261108000600_agent_pipeline.sql missing").toBeDefined();
    expect(m!.name).toBe("20261108000600_agent_pipeline.sql");
  });

  it("the header documents D-021 and D-027", () => {
    const raw = readFileSync(join(MIGRATIONS_DIR, m!.name), "utf8");
    expect(raw).toMatch(/D-021/);
    expect(raw).toMatch(/D-027/);
  });

  describe("tables", () => {
    it("agent_runs columns, FKs and enum checks", () => {
      for (const frag of [
        "book_id uuid references public.books (id) on delete set null",
        "user_id uuid references auth.users (id) on delete set null",
        "trigger text not null",
        "mode text not null",
        "state text not null default 'queued'",
        "progress jsonb not null default '{}'::jsonb",
        "cursor jsonb not null default '{}'::jsonb",
        "lease_until timestamptz",
        "attempts integer not null default 0",
        "critic_score numeric(3, 1)",
        "total_cost_usd numeric(10, 4) not null default 0",
        "total_input_tokens integer not null default 0",
        "total_output_tokens integer not null default 0",
        "started_at timestamptz not null default now()",
        "updated_at timestamptz not null default now()",
        "check (trigger in ('build', 'rebuild', 'rewrite'))",
        "check (mode in ('live', 'replay', 'rule'))",
        "check ( state in ('queued', 'curating', 'storytelling', 'captioning', 'critiquing', 'repairing', 'validating', 'done', 'failed') )",
        "check (ai_status in ('ok', 'partial', 'failed'))",
      ]) {
        expect(flat, frag).toContain(frag);
      }
    });

    it("agent_steps columns, FK cascade, unique attempt key and enum checks", () => {
      for (const frag of [
        "run_id uuid not null references public.agent_runs (id) on delete cascade",
        "attempt smallint not null default 1",
        "unique (run_id, step_key, attempt)",
        "check ( agent in ('curator', 'storyteller', 'caption_writer', 'critic', 'rewriter', 'memory_keeper') )",
        "check (status in ('ok', 'error', 'refused', 'skipped'))",
        "cost_usd numeric(10, 6) not null default 0",
        "cache_read_tokens integer not null default 0",
        "cache_write_tokens integer not null default 0",
      ]) {
        expect(flat, frag).toContain(frag);
      }
    });

    it("user_memory is keyed by user and cascades with the auth user", () => {
      expect(flat).toContain("user_id uuid primary key references auth.users (id) on delete cascade");
      expect(flat).toContain("prefs jsonb not null default '{}'::jsonb");
    });

    it.each([
      ["progress", 4096],
      ["cursor", 65536],
      ["input_summary", 8192],
      ["output", 262144],
      ["prefs", 8192],
    ])("pg_column_size(%s) <= %i", (col, max) => {
      expect(flat).toContain(`check (pg_column_size(${col}) <= ${max})`);
    });

    it.each([
      ["error_code", 64],
      ["step_key", 64],
      ["model", 64],
      ["stop_reason", 32],
      ["error", 200],
    ])("char_length(%s) <= %i", (col, max) => {
      expect(flat).toContain(`check (char_length(${col}) <= ${max})`);
    });

    it("at most one active run per book (unique partial index) + user/started_at index", () => {
      expect(flat).toMatch(
        /create unique index \w+ on public\.agent_runs \(book_id\) where state not in \('done', 'failed'\)/,
      );
      expect(flat).toMatch(/create index \w+ on public\.agent_runs \(user_id, started_at desc\)/);
      expect(flat).toMatch(/create index \w+ on public\.agent_steps \(run_id, created_at\)/);
    });

    it("agent_runs.updated_at is maintained by private.set_updated_at", () => {
      expect(flat).toMatch(
        /create trigger \w+ before update on public\.agent_runs for each row execute function private\.set_updated_at\(\)/,
      );
    });

    it("no client-writable counter columns exist (D-021)", () => {
      expect(all).not.toMatch(/\b(rebuild_count|rewrite_count|rebuilds_used|rewrites_used|ai_photos_analyzed)\b/);
    });
  });

  describe("RLS, grants and policies", () => {
    it.each(agentTables)("public.%s has RLS enabled", (t) => {
      expect(flat).toContain(`alter table public.${t} enable row level security`);
    });

    it("revokes all from anon, authenticated, public and grants all to service_role", () => {
      expect(flat).toContain(
        "revoke all on table public.agent_runs, public.agent_steps, public.user_memory from anon, authenticated, public",
      );
      expect(flat).toContain("grant all on table public.agent_runs, public.agent_steps, public.user_memory to service_role");
    });

    it.each(agentTables)("anon ends with no privileges on public.%s", (t) => {
      expect(sorted(acl[`public.${t}`]?.anon)).toEqual([]);
    });

    it.each([
      // agent_runs: table-level SELECT replaced by column grants in 0700 (checked there).
      ["agent_runs", []],
      ["agent_steps", []],
      ["user_memory", ["delete", "select"]],
    ])("authenticated ends with exactly the expected table privileges on public.%s", (t, expected) => {
      expect(sorted(acl[`public.${t}`]?.authenticated)).toEqual(expected);
    });

    it.each(agentTables)("service_role keeps all privileges on public.%s", (t) => {
      expect(sorted(acl[`public.${t}`]?.service_role)).toEqual([...ALL_PRIVS].sort());
    });

    it("policies: agent_runs select own; user_memory select + delete own; agent_steps none", () => {
      const ops = (t: string) =>
        policies
          .filter((p) => p.table === `public.${t}`)
          .map((p) => ws(p.text))
          .map((p) => ({ op: p.match(/\bfor (\w+)/)?.[1], text: p }));
      const runs = ops("agent_runs");
      expect(runs.map((p) => p.op)).toEqual(["select"]);
      expect(runs[0].text).toContain("to authenticated using (user_id = (select auth.uid()))");
      const mem = ops("user_memory");
      expect(mem.map((p) => p.op).sort()).toEqual(["delete", "select"]);
      for (const p of mem) expect(p.text).toContain("to authenticated using (user_id = (select auth.uid()))");
      expect(ops("agent_steps")).toEqual([]);
    });
  });

  describe("lease RPCs (0600 versions; replaced in 0700)", () => {
    // Functions as defined in the 0600 file itself (0700 drops and recreates them).
    const own = (name: string) =>
      matchesAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/, sql)
        .map((x) => ({ name: x[1], header: x[2], body: x[3] }))
        .find((f) => f.name === name);

    it.each([
      ["public.claim_agent_run", "uuid, integer"],
      ["public.release_agent_run", "uuid"],
    ])("%s is SECURITY INVOKER, revoked from clients, executable by service_role only", (name, sig) => {
      const f = own(name);
      expect(f).toBeDefined();
      expect(f!.header).toMatch(/security\s+invoker/);
      expect(f!.header).not.toMatch(/security\s+definer/);
      expect(f!.header).toMatch(/set\s+search_path\s*=\s*''/);
      expect(flat).toContain(`revoke all on function ${name}(${sig}) from public, anon, authenticated`);
      const grants = matchesAll(new RegExp(`grant execute on function ${esc(name)}\\([^)]*\\) to ([a-z_, ]+?);`), sql);
      expect(grants.map((g) => g[1].trim())).toEqual(["service_role"]);
    });

    it("claim is one guarded update with the lease clamped to 5..300 s", () => {
      const body = ws(own("public.claim_agent_run")!.body);
      expect(body).toContain("v_secs := least(300, greatest(5, p_lease_seconds));");
      expect(body).toContain(
        "update public.agent_runs as r set lease_until = now() + make_interval(secs => v_secs), attempts = r.attempts + 1 where r.id = p_run_id and r.state not in ('done', 'failed') and (r.lease_until is null or r.lease_until < now());",
      );
    });
  });

  describe("books.ai_status (D-021)", () => {
    it("books_ai_status_check is dropped and re-added including 'partial'", () => {
      expect(flat).toContain("alter table public.books drop constraint books_ai_status_check");
      expect(flat).toContain(
        "add constraint books_ai_status_check check ( ai_status in ('idle', 'analyzing', 'planning', 'captioning', 'done', 'partial', 'failed') )",
      );
      expect(flat.indexOf("drop constraint books_ai_status_check")).toBeLessThan(
        flat.indexOf("add constraint books_ai_status_check"),
      );
    });

    it("protect_book_columns is redefined here, stays INVOKER and forces ai_status", () => {
      // The 0600 definition (0900 redefines it again; see the M5 editor block below).
      const f = functions.filter((x) => x.name === "private.protect_book_columns").find((x) => sql.includes(x.body))!;
      expect(f).toBeDefined();
      expect(f.header).not.toMatch(/security\s+definer/);
      expect(f.header).toMatch(/set\s+search_path\s*=\s*''/);
      const body = ws(f.body);
      expect(body).toMatch(/if current_user in \('postgres', 'service_role', 'supabase_admin'\) then return new; end if;/);
      const [ins, upd = ""] = body.split("elsif tg_op = 'update'");
      expect(ins).toContain("new.ai_status := 'idle';");
      expect(upd).toContain("new.ai_status := old.ai_status;");
      // everything the 0300 version guarded is still guarded
      for (const col of ["is_paid", "max_pages", "expires_at", "slug", "published_at"]) {
        expect(ins, col).toMatch(new RegExp(`new\\.${col} :=`));
      }
      for (const col of ["id", "created_at", "is_paid", "max_pages", "expires_at", "slug", "published_at", "user_id"]) {
        expect(upd, col).toContain(`new.${col} := old.${col};`);
      }
      expect(flat).toContain("revoke all on function private.protect_book_columns() from public, anon, authenticated");
    });

    it("keeps the definer-bypass warning comment", () => {
      const raw = readFileSync(join(MIGRATIONS_DIR, m!.name), "utf8");
      expect(raw).toMatch(/WARNING: any future SECURITY DEFINER function owned by postgres that writes\s*\n--\s*to public\.books bypasses this guard/);
    });
  });

  describe("step scrub on book delete (D-027)", () => {
    const f = latestFunction("private.scrub_agent_steps");

    it("private.scrub_agent_steps nulls output and input_summary when book_id goes null", () => {
      expect(f).toBeDefined();
      expect(f!.header).toMatch(/returns\s+trigger/);
      expect(f!.header).toMatch(/set\s+search_path\s*=\s*''/);
      const body = ws(f!.body);
      expect(body).toContain("if old.book_id is not null and new.book_id is null then");
      expect(body).toMatch(/update public\.agent_steps as s set output = null, input_summary = null where s\.run_id = new\.id/);
      // costs / tokens are kept
      expect(body).not.toMatch(/cost_usd|_tokens/);
    });

    it("runs as a BEFORE UPDATE OF book_id row trigger on agent_runs and is not executable by clients", () => {
      expect(flat).toMatch(
        /create trigger \w+ before update of book_id on public\.agent_runs for each row execute function private\.scrub_agent_steps\(\)/,
      );
      expect(flat).toContain("revoke all on function private.scrub_agent_steps() from public, anon, authenticated");
    });
  });

  it("does not touch photos/orders/profiles grants or policies", () => {
    expect(sql).not.toMatch(/\b(grant|revoke)\s+[a-z_\s,]+\s+on\s+(?:table\s+)?public\.(photos|orders|profiles|books)\b/);
    expect(sql).not.toMatch(/\b(create|drop|alter)\s+policy\b[^;]*\bon\s+public\.(photos|orders|profiles|books)\b/);
  });
});

describe("migrations: M3 review fixes — agent pipeline hardening (0700)", () => {
  const m = migrations.find((x) => x.name.endsWith("_agent_pipeline_hardening.sql"));
  const sql = m?.sql ?? "";
  const ws = (s: string) => s.replace(/\s+/g, " ");
  const flat = ws(sql);
  const raw = m ? readFileSync(join(MIGRATIONS_DIR, m.name), "utf8") : "";
  const grantsTo = (fn: string) =>
    matchesAll(new RegExp(`grant execute on function ${esc(fn)}\\s*\\([^)]*\\)\\s+to\\s+([a-z_, ]+?)\\s*;`), all).map((g) =>
      g[1].trim(),
    );
  const RPCS: [string, string][] = [
    ["public.claim_agent_run", "uuid, integer"],
    ["public.release_agent_run", "uuid, uuid"],
    ["public.create_agent_run_capped", "uuid, uuid, text, text, integer, integer, boolean"],
  ];
  // Functions as defined in the 0700 file itself (0900 redefines claim_agent_run).
  const own = (name: string) =>
    matchesAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/, sql)
      .map((x) => ({ name: x[1], header: x[2], body: x[3] }))
      .find((f) => f.name === name);

  it("exists, sorts after 0600 and is the latest migration", () => {
    expect(m, "20261109000700_agent_pipeline_hardening.sql missing").toBeDefined();
    expect(m!.name).toBe("20261109000700_agent_pipeline_hardening.sql");
    expect(files.indexOf(m!.name)).toBeGreaterThan(files.indexOf("20261108000600_agent_pipeline.sql"));
  });

  it("is additive: no table/column drops, no RLS changes, no policy changes", () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column|policy|index|trigger)\b/);
    expect(sql).not.toMatch(/\brow\s+level\s+security\b/);
    expect(sql).not.toMatch(/\b(create|alter)\s+policy\b/);
    expect(sql).not.toMatch(/\b(grant|revoke)\s+[a-z_\s,()]+\s+on\s+(?:table\s+)?public\.(photos|orders|profiles|books|agent_steps|user_memory)\b/);
  });

  it("widens the cost columns to numeric(12, 6) (T16 #16)", () => {
    expect(flat).toContain("alter table public.agent_runs alter column total_cost_usd type numeric(12, 6)");
    expect(flat).toContain("alter table public.agent_steps alter column cost_usd type numeric(12, 6)");
  });

  describe("lease tokens", () => {
    it("adds agent_runs.lease_token uuid and drops the 0600 RPC signatures", () => {
      expect(flat).toContain("alter table public.agent_runs add column lease_token uuid");
      expect(flat).toContain("drop function public.claim_agent_run(uuid, integer)");
      expect(flat).toContain("drop function public.release_agent_run(uuid)");
      expect(flat.indexOf("drop function public.claim_agent_run")).toBeLessThan(
        flat.indexOf("create or replace function public.claim_agent_run"),
      );
    });

    it.each(RPCS)("%s is SECURITY INVOKER, revoked from clients, executable by service_role only", (name, sig) => {
      const f = own(name);
      expect(f).toBeDefined();
      expect(f!.header).toMatch(/security\s+invoker/);
      expect(f!.header).not.toMatch(/security\s+definer/);
      expect(f!.header).toMatch(/set\s+search_path\s*=\s*''/);
      expect(flat).toContain(`revoke all on function ${name}(${sig}) from public, anon, authenticated`);
      expect(flat).toMatch(new RegExp(`grant execute on function ${esc(name)}\\(${esc(sig)}\\) to service_role;`));
    });

    it("no client role is ever granted EXECUTE on the run RPCs", () => {
      for (const [name] of RPCS) {
        const grants = grantsTo(name);
        expect(grants.length, name).toBeGreaterThanOrEqual(1);
        for (const roles of grants) expect(roles, name).toBe("service_role");
      }
    });

    it("claim returns a fresh token stored on the run, null when not claimable", () => {
      const f = own("public.claim_agent_run")!;
      expect(f.header).toMatch(/returns\s+uuid/);
      const body = ws(f.body);
      expect(body).toContain("v_secs := least(300, greatest(5, p_lease_seconds));");
      expect(body).toContain("v_token := gen_random_uuid();");
      expect(body).toContain(
        "update public.agent_runs as r set lease_until = now() + make_interval(secs => v_secs), lease_token = v_token, attempts = r.attempts + 1 where r.id = p_run_id and r.state not in ('done', 'failed') and (r.lease_until is null or r.lease_until < now());",
      );
      expect(body).toContain("if not found then return null; end if; return v_token;");
    });

    it("release only clears a lease whose token matches", () => {
      const body = ws(latestFunction("public.release_agent_run")!.body);
      expect(body).toContain(
        "update public.agent_runs as r set lease_until = null, lease_token = null where r.id = p_run_id and r.lease_token = p_token;",
      );
    });

    it("documents that checkpoints check the token client-side", () => {
      expect(raw).toMatch(/\.eq\('lease_token', token\)/);
    });
  });

  describe("create_agent_run_capped (T16 #4 / #5)", () => {
    const f = latestFunction("public.create_agent_run_capped");
    const body = ws(f?.body ?? "");

    it("returns jsonb and serialises per user with a transaction advisory lock", () => {
      expect(f!.header).toMatch(/returns\s+jsonb/);
      expect(body).toContain("perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1));");
      expect(body.indexOf("pg_advisory_xact_lock")).toBeLessThan(body.indexOf("select count(*)"));
      expect(body.indexOf("pg_advisory_xact_lock")).toBeLessThan(body.indexOf("insert into public.agent_runs"));
    });

    it("rejects null arguments", () => {
      expect(body).toMatch(/if p_book_id is null or p_user_id is null[\s\S]*?raise exception 'invalid_argument' using errcode = '22023'/);
    });

    it("daily cap: live build/rebuild runs of the user in 24 h that cost something or are still active", () => {
      expect(body).toContain(
        "where r.user_id = p_user_id and r.mode = 'live' and r.trigger in ('build', 'rebuild') and r.started_at >= now() - interval '24 hours' and (r.total_cost_usd > 0 or r.state not in ('done', 'failed'));",
      );
      expect(body).toContain("if v_n >= p_daily_cap then return jsonb_build_object('error', 'limit', 'limit', 'daily_builds');");
    });

    it("rebuild cap: billed successful live rebuilds of the book", () => {
      expect(body).toContain(
        "where r.book_id = p_book_id and r.mode = 'live' and r.trigger = 'rebuild' and r.total_cost_usd > 0 and r.ai_status in ('ok', 'partial');",
      );
      expect(body).toContain("if v_n >= p_rebuild_cap then return jsonb_build_object('error', 'limit', 'limit', 'rebuilds');");
    });

    it("caps only when p_enforce; unique violation → already_running; success → {id}", () => {
      expect(body).toContain("if p_enforce then");
      expect(body).toContain("exception when unique_violation then return jsonb_build_object('error', 'already_running');");
      expect(body).toContain("return jsonb_build_object('id', v_id);");
    });
  });

  describe("agent_runs column grants (T16 #6)", () => {
    const OWNER_COLS = ["id", "book_id", "user_id", "state", "ai_status", "progress", "error_code", "mode", "trigger", "started_at", "finished_at"];

    it("revokes table-level SELECT and grants exactly the progress-screen columns", () => {
      expect(flat).toContain("revoke select on table public.agent_runs from authenticated;");
      const g = flat.match(/grant select \(([^)]*)\) on public\.agent_runs to authenticated;/);
      expect(g).not.toBeNull();
      expect(g![1].split(",").map((c) => c.trim())).toEqual(OWNER_COLS);
      expect(flat.indexOf("revoke select on table public.agent_runs")).toBeLessThan(flat.indexOf("grant select ("));
    });

    it.each(["cursor", "lease_token", "lease_until", "attempts", "total_cost_usd", "total_input_tokens", "total_output_tokens", "critic_score"])(
      "never grants %s to a client role",
      (col) => {
        for (const g of matchesAll(/grant\s+select\s*\(([^)]*)\)\s+on\s+(?:table\s+)?public\.agent_runs\s+to\s+([a-z_, ]+);/)) {
          expect(g[1].split(",").map((c) => c.trim()), g[0]).not.toContain(col);
        }
      },
    );

    it("src/lib/db/agent-runs.ts owner reads select only granted columns", () => {
      const src = readFileSync(join(process.cwd(), "src", "lib", "db", "agent-runs.ts"), "utf8");
      const cols = src.match(/const OWNER_RUN_COLUMNS =\s*"([^"]+)"/);
      expect(cols).not.toBeNull();
      for (const c of cols![1].split(",").map((x) => x.trim())) expect(OWNER_COLS, c).toContain(c);
    });
  });

  describe("scrub on book delete (T16 #7)", () => {
    it("latest private.scrub_agent_steps also clears the run's cursor and progress", () => {
      const f = latestFunction("private.scrub_agent_steps")!;
      expect(sql).toContain(f.body);
      expect(f.header).toMatch(/security\s+invoker/);
      expect(f.header).toMatch(/set\s+search_path\s*=\s*''/);
      const body = ws(f.body);
      expect(body).toContain("if old.book_id is not null and new.book_id is null then");
      expect(body).toMatch(/update public\.agent_steps as s set output = null, input_summary = null where s\.run_id = new\.id/);
      expect(body).toContain("new.cursor := '{}'::jsonb; new.progress := '{}'::jsonb;");
      expect(body).not.toMatch(/cost_usd|_tokens/);
      expect(flat).toContain("revoke all on function private.scrub_agent_steps() from public, anon, authenticated");
    });
  });
});

describe("migrations: Milestone 4 cursor size (0800, D-033)", () => {
  const name = "20261109000800_cursor_size.sql";
  const m = migrations.find((x) => x.name === name);
  const flat = (m?.sql ?? "").replace(/\s+/g, " ").trim();
  const raw = m ? readFileSync(join(MIGRATIONS_DIR, m.name), "utf8") : "";

  it("exists and sorts after 0700", () => {
    expect(m, `${name} missing`).toBeDefined();
    expect(files.indexOf(name)).toBeGreaterThan(files.indexOf("20261109000700_agent_pipeline_hardening.sql"));
    expect(raw).toMatch(/D-033/);
  });

  it("drops the 0600 cursor check and re-adds it with the same name at 262144 bytes", () => {
    expect(flat).toContain("alter table public.agent_runs drop constraint agent_runs_cursor_size;");
    expect(flat).toContain(
      "alter table public.agent_runs add constraint agent_runs_cursor_size check (pg_column_size(cursor) <= 262144);",
    );
    expect(flat.indexOf("drop constraint")).toBeLessThan(flat.indexOf("add constraint"));
  });

  it("contains nothing else (exactly the two statements)", () => {
    const stmts = flat.split(";").map((s) => s.trim()).filter(Boolean);
    expect(stmts).toEqual([
      "alter table public.agent_runs drop constraint agent_runs_cursor_size",
      "alter table public.agent_runs add constraint agent_runs_cursor_size check (pg_column_size(cursor) <= 262144)",
    ]);
  });

  it("the latest agent_runs_cursor_size definition across all migrations is 256 KB", () => {
    const defs = matchesAll(/constraint\s+agent_runs_cursor_size\s+check\s*\(\s*pg_column_size\(cursor\)\s*<=\s*(\d+)\s*\)/);
    expect(defs.map((d) => Number(d[1]))).toEqual([65536, 262144]);
  });
});

describe("migrations: Milestone 5 editor (0900, D-036 / D-037)", () => {
  const name = "20261110000900_editor.sql";
  const m = migrations.find((x) => x.name === name);
  const sql = m?.sql ?? "";
  const ws = (s: string) => s.replace(/\s+/g, " ");
  const flat = ws(sql);
  const raw = m ? readFileSync(join(MIGRATIONS_DIR, m.name), "utf8") : "";
  const RPC = "public.create_rewrite_run_capped";
  const RPC_ARGS = "uuid, uuid, text, integer, integer, boolean";

  it("exists, sorts after 0800 and documents D-036 / D-037", () => {
    expect(m, `${name} missing`).toBeDefined();
    expect(files.indexOf(name)).toBeGreaterThan(files.indexOf("20261109000800_cursor_size.sql"));
    expect(raw).toMatch(/D-036/);
    expect(raw).toMatch(/D-037/);
  });

  it("is additive: no table/column/policy drops, no RLS or table-grant changes", () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column|policy|trigger|function)\b/);
    expect(sql).not.toMatch(/\brow\s+level\s+security\b/);
    expect(sql).not.toMatch(/\b(create|alter)\s+policy\b/);
    expect(sql).not.toMatch(/\b(grant|revoke)\s+[a-z_\s,()]+\s+on\s+(?:table\s+)?public\.\w+/);
  });

  describe("books.doc_rev", () => {
    it("adds doc_rev bigint not null default 0 (non-negative)", () => {
      expect(flat).toContain("alter table public.books add column doc_rev bigint not null default 0;");
      expect(flat).toContain("check (doc_rev >= 0)");
    });

    it("private.set_book_doc_rev bumps only when doc changes and otherwise keeps the old rev", () => {
      const f = latestFunction("private.set_book_doc_rev");
      expect(f).toBeDefined();
      expect(sql).toContain(f!.body);
      expect(f!.header).toMatch(/returns\s+trigger/);
      expect(f!.header).toMatch(/security\s+invoker/);
      expect(f!.header).toMatch(/set\s+search_path\s*=\s*''/);
      expect(ws(f!.body)).toContain(
        "if new.doc is distinct from old.doc then new.doc_rev := old.doc_rev + 1; else new.doc_rev := old.doc_rev; end if;",
      );
      expect(flat).toContain("revoke all on function private.set_book_doc_rev() from public, anon, authenticated");
    });

    it("runs as BEFORE UPDATE row trigger books_set_doc_rev, which sorts after books_protect_columns", () => {
      expect(flat).toMatch(
        /create trigger books_set_doc_rev before update on public\.books for each row execute function private\.set_book_doc_rev\(\)/,
      );
      // BEFORE triggers fire alphabetically: the guard must reset a client's doc first.
      expect(ws(all)).toMatch(/create trigger books_protect_columns before insert or update on public\.books/);
      expect("books_set_doc_rev" > "books_protect_columns").toBe(true);
    });

    it("BEFORE triggers on public.books fire in the intended (alphabetical) order", () => {
      // Every BEFORE trigger ever created on books, by name, as Postgres fires them.
      const names = matchesAll(/create\s+trigger\s+(\w+)\s+before\s+[^;]*?\bon\s+public\.books\b/)
        .map((x) => x[1])
        .sort();
      const dropped = matchesAll(/drop\s+trigger\s+(?:if\s+exists\s+)?(\w+)\s+on\s+public\.books\b/).map((x) => x[1]);
      const live = [...new Set(names)].filter((n) => !dropped.includes(n));
      const at = (n: string) => live.indexOf(n);
      expect(at("books_protect_columns")).toBeGreaterThanOrEqual(0);
      expect(at("books_set_doc_rev")).toBeGreaterThan(at("books_protect_columns"));
      expect(at("books_set_updated_at")).toBeGreaterThan(at("books_set_doc_rev"));
    });
  });

  describe("protect_book_columns (D-036)", () => {
    // The 0900 definition itself (1000 redefines it as a superset — checked in the 1000 suite).
    const f = matchesAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/, sql)
      .map((x) => ({ name: x[1], header: x[2], body: x[3] }))
      .find((x) => x.name === "private.protect_book_columns");
    const body = ws(f?.body ?? "");
    const [ins, upd = ""] = body.split("elsif tg_op = 'update'");

    it("0900 defines it, INVOKER with search_path '' and the privileged-role bypass", () => {
      expect(f).toBeDefined();
      expect(f!.header).not.toMatch(/security\s+definer/);
      expect(f!.header).toMatch(/set\s+search_path\s*=\s*''/);
      expect(body).toMatch(/if current_user in \('postgres', 'service_role', 'supabase_admin'\) then return new; end if;/);
      expect(flat).toContain("revoke all on function private.protect_book_columns() from public, anon, authenticated");
      expect(raw).toMatch(/WARNING: any future SECURITY DEFINER function owned by postgres that writes\s*\n--\s*to public\.books bypasses this guard/);
    });

    it("INSERT forces doc '{}', page_count 0, doc_rev 0 plus everything 0600 forced", () => {
      for (const s of [
        "new.doc := '{}'::jsonb;",
        "new.page_count := 0;",
        "new.doc_rev := 0;",
        "new.is_paid := false;",
        "new.max_pages := 20;",
        "new.expires_at := null;",
        "new.slug := null;",
        "new.published_at := null;",
        "new.ai_status := 'idle';",
      ]) {
        expect(ins, s).toContain(s);
      }
    });

    it.each(["doc", "page_count", "doc_rev", "id", "created_at", "is_paid", "max_pages", "expires_at", "slug", "published_at", "user_id", "ai_status"])(
      "UPDATE keeps old.%s",
      (col) => {
        expect(upd).toContain(`new.${col} := old.${col};`);
      },
    );

    it("title / occasion / tone / caption_lang stay client-editable", () => {
      for (const col of ["title", "occasion", "tone", "caption_lang"]) expect(body).not.toMatch(new RegExp(`new\\.${col} :=`));
    });
  });

  describe("one active run per book excludes rewrites (D-037 (6))", () => {
    it("drops and recreates agent_runs_one_active_per_book_idx with trigger <> 'rewrite'", () => {
      expect(flat).toContain("drop index public.agent_runs_one_active_per_book_idx;");
      expect(flat).toContain(
        "create unique index agent_runs_one_active_per_book_idx on public.agent_runs (book_id) where state not in ('done', 'failed') and trigger <> 'rewrite';",
      );
      expect(flat.indexOf("drop index")).toBeLessThan(flat.indexOf("create unique index"));
    });

    it("the latest definition across all migrations is the 0900 one", () => {
      const defs = matchesAll(/create\s+unique\s+index\s+agent_runs_one_active_per_book_idx\s+on\s+public\.agent_runs\s*\(book_id\)\s+where\s+([^;]+);/);
      expect(defs).toHaveLength(2);
      expect(ws(defs.at(-1)![1])).toBe("state not in ('done', 'failed') and trigger <> 'rewrite'");
    });
  });

  describe("rewrite runs never look like builds (M5 review B1)", () => {
    it("adds state 'rewriting' to agent_runs_state_check (drop + re-add)", () => {
      expect(flat).toContain("alter table public.agent_runs drop constraint agent_runs_state_check;");
      expect(flat).toContain(
        "add constraint agent_runs_state_check check ( state in ('queued', 'curating', 'storytelling', 'captioning', 'critiquing', 'repairing', 'validating', 'rewriting', 'done', 'failed') );",
      );
      expect(flat.indexOf("drop constraint agent_runs_state_check")).toBeLessThan(flat.indexOf("add constraint agent_runs_state_check"));
    });

    it("an active rewrite run is always 'rewriting', and only rewrite runs may be", () => {
      expect(flat).toContain(
        "add constraint agent_runs_rewriting_state_check check ( (state = 'rewriting') = (trigger = 'rewrite' and state not in ('done', 'failed')) );",
      );
    });

    it("claim_agent_run (latest = 0900) only leases build / rebuild runs; privileges re-stated", () => {
      const f = latestFunction("public.claim_agent_run")!;
      expect(sql).toContain(f.body);
      expect(f.header).toMatch(/returns\s+uuid/);
      expect(f.header).toMatch(/security\s+invoker/);
      expect(f.header).toMatch(/set\s+search_path\s*=\s*''/);
      expect(ws(f.body)).toContain(
        "update public.agent_runs as r set lease_until = now() + make_interval(secs => v_secs), lease_token = v_token, attempts = r.attempts + 1 where r.id = p_run_id and r.trigger in ('build', 'rebuild') and r.state not in ('done', 'failed') and (r.lease_until is null or r.lease_until < now());",
      );
      expect(flat).toContain("revoke all on function public.claim_agent_run(uuid, integer) from public, anon, authenticated;");
      expect(flat).toContain("grant execute on function public.claim_agent_run(uuid, integer) to service_role;");
    });
  });

  describe("create_rewrite_run_capped", () => {
    const f = latestFunction(RPC);
    const body = ws(f?.body ?? "");

    it("signature (p_book, p_user, p_mode, p_cap, p_daily_cap, p_enforce) returns jsonb; INVOKER with search_path ''", () => {
      expect(f).toBeDefined();
      expect(ws(f!.header).trim()).toMatch(
        /^p_book uuid, p_user uuid, p_mode text, p_cap integer, p_daily_cap integer, p_enforce boolean \) returns jsonb/,
      );
      expect(f!.header).toMatch(/security\s+invoker/);
      expect(f!.header).not.toMatch(/security\s+definer/);
      expect(f!.header).toMatch(/set\s+search_path\s*=\s*''/);
    });

    it("rejects null arguments (caps only required when enforced)", () => {
      expect(body).toContain(
        "if p_book is null or p_user is null or p_mode is null or p_enforce is null or (p_enforce and (p_cap is null or p_daily_cap is null)) then raise exception 'invalid_argument' using errcode = '22023';",
      );
    });

    it("serialises per user with a transaction advisory lock before any check, reap or insert", () => {
      expect(body).toContain("perform pg_advisory_xact_lock(hashtextextended(p_user::text, 3));");
      const lock = body.indexOf("pg_advisory_xact_lock");
      expect(lock).toBeLessThan(body.indexOf("select count(*)"));
      expect(lock).toBeLessThan(body.indexOf("update public.agent_runs"));
      expect(lock).toBeLessThan(body.indexOf("insert into public.agent_runs"));
      expect(lock).toBeLessThan(body.indexOf("from public.books"));
    });

    it("returns not_found unless the book belongs to p_user", () => {
      expect(body).toMatch(/if not exists \( select 1 from public\.books as b where b\.id = p_book and b\.user_id = p_user \) then return jsonb_build_object\('error', 'not_found'\);/);
      expect(body.indexOf("'not_found'")).toBeLessThan(body.indexOf("update public.agent_runs"));
    });

    it("fails this book's unfinished rewrite runs older than 5 min (error_code 'stale') before counting", () => {
      expect(body).toContain(
        "update public.agent_runs as r set state = 'failed', ai_status = 'failed', error_code = 'stale', finished_at = now() where r.book_id = p_book and r.trigger = 'rewrite' and r.state not in ('done', 'failed') and r.started_at <= now() - interval '5 minutes';",
      );
      expect(body.indexOf("error_code = 'stale'")).toBeLessThan(body.indexOf("select count(*)"));
    });

    it("max one rewrite in flight per book → already_running", () => {
      expect(body).toContain(
        "where r.book_id = p_book and r.trigger = 'rewrite' and r.state not in ('done', 'failed'); if v_n > 0 then return jsonb_build_object('error', 'already_running');",
      );
    });

    it("daily ceiling (only when p_enforce): ALL rewrite runs of the user in the last 24 h → daily_limit", () => {
      expect(body).toContain(
        "if p_enforce then select count(*) into v_n from public.agent_runs as r where r.user_id = p_user and r.trigger = 'rewrite' and r.started_at > now() - interval '24 hours'; if v_n >= p_daily_cap then return jsonb_build_object('error', 'daily_limit');",
      );
    });

    it("per-book cap (only when p_enforce) counts ok rewrites + in-flight ones of the book", () => {
      expect(body).toContain(
        "where r.book_id = p_book and r.trigger = 'rewrite' and (r.ai_status = 'ok' or r.state not in ('done', 'failed')); if v_n >= p_cap then return jsonb_build_object('error', 'limit', 'limit', 'rewrites');",
      );
      expect(body.indexOf("'daily_limit'")).toBeLessThan(body.indexOf("'rewrites'"));
    });

    it("inserts a 'rewrite' run in state 'rewriting' (never 'queued') and returns {id}", () => {
      expect(body).toContain(
        "insert into public.agent_runs (book_id, user_id, trigger, mode, state) values (p_book, p_user, 'rewrite', p_mode, 'rewriting') returning id into v_id;",
      );
      expect(body).toContain("return jsonb_build_object('id', v_id);");
    });

    it("EXECUTE revoked from public/anon/authenticated, granted to service_role only", () => {
      expect(flat).toContain(`revoke all on function ${RPC}(${RPC_ARGS}) from public, anon, authenticated;`);
      const grants = matchesAll(new RegExp(`grant execute on function ${esc(RPC)}\\s*\\([^)]*\\)\\s+to\\s+([a-z_, ]+?)\\s*;`), all).map((g) => g[1].trim());
      expect(grants).toEqual(["service_role"]);
      expect(flat.indexOf(`revoke all on function ${RPC}`)).toBeLessThan(flat.indexOf(`grant execute on function ${RPC}`));
    });
  });

  it("database.types.ts declares books.doc_rev and the RPC args (hand-edited until types gen)", () => {
    const types = readFileSync(join(process.cwd(), "src", "lib", "supabase", "database.types.ts"), "utf8");
    // scoped to the books table block (exports, 1400, has its own doc_rev columns)
    const books = types.slice(types.indexOf("      books: {"), types.indexOf("      exports: {"));
    expect(books.length).toBeGreaterThan(0);
    expect(books.match(/doc_rev\??: number/g)).toHaveLength(3);
    expect(types).toMatch(
      /create_rewrite_run_capped: \{\s*Args: \{\s*p_book: string\s*p_cap: number\s*p_daily_cap: number\s*p_enforce: boolean\s*p_mode: string\s*p_user: string\s*\}\s*Returns: Json/,
    );
  });
});

describe("migrations: Milestone 6 publish (1000, D-039 / D-040)", () => {
  const name = "20261111001000_publish.sql";
  const m = migrations.find((x) => x.name === name);
  const sql = m?.sql ?? "";
  const ws = (s: string) => s.replace(/\s+/g, " ");
  const flat = ws(sql);
  const raw = m ? readFileSync(join(MIGRATIONS_DIR, m.name), "utf8") : "";
  const own = (fn: string) =>
    matchesAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/, sql)
      .map((x) => ({ name: x[1], header: x[2], body: x[3] }))
      .find((x) => x.name === fn);
  const grantsTo = (fn: string) =>
    matchesAll(new RegExp(`grant execute on function ${esc(fn)}\\s*\\([^)]*\\)\\s+to\\s+([a-z_, ]+?)\\s*;`), sql).map((g) =>
      g[1].trim(),
    );
  const GUARDED = ["published_doc", "published_rev", "last_published_at", "password_hash"];
  const UNLOCK = "public.try_book_unlock";
  const UNLOCK_ARGS = "uuid, text, integer, integer, integer";

  it("exists, sorts after 0900 and documents D-039 / D-040", () => {
    expect(m, `${name} missing`).toBeDefined();
    expect(files.indexOf(name)).toBeGreaterThan(files.indexOf("20261110000900_editor.sql"));
    expect(raw).toMatch(/D-039/);
    expect(raw).toMatch(/D-040/);
  });

  it("is additive: only get_published_book is dropped; no policies, no RLS disable, no core table-grant changes", () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column|policy|trigger|index|constraint)\b/);
    expect(matchesAll(/\bdrop\s+function\s+([\w.]+)/, sql).map((x) => x[1])).toEqual(["public.get_published_book"]);
    expect(sql).not.toMatch(/\b(create|alter)\s+policy\b/);
    expect(matchesAll(/row\s+level\s+security/, sql)).toHaveLength(1);
    expect(flat).toContain("alter table public.book_unlock_attempts enable row level security;");
    expect(sql).not.toMatch(
      /\b(grant|revoke)\s+[a-z_\s,()]+\s+on\s+(?:table\s+)?public\.(photos|orders|profiles|books|agent_runs|agent_steps|user_memory)\b/,
    );
  });

  describe("books publish columns", () => {
    it("adds published_doc jsonb, published_rev bigint, last_published_at timestamptz (all nullable)", () => {
      expect(flat).toContain(
        "alter table public.books add column published_doc jsonb, add column published_rev bigint, add column last_published_at timestamptz;",
      );
    });

    it("published_doc has the same 1 MiB limit as doc; published_rev >= 0", () => {
      expect(flat).toContain("add constraint books_published_doc_size check (pg_column_size(published_doc) <= 1048576)");
      expect(flat).toContain("add constraint books_published_rev_check check (published_rev >= 0)");
    });

    it("a snapshot requires slug + published_at and published_rev + last_published_at", () => {
      expect(flat).toContain(
        "add constraint books_published_doc_requires_publish check ( published_doc is null or (slug is not null and published_at is not null) )",
      );
      expect(flat).toContain(
        "add constraint books_published_doc_has_rev check ( published_doc is null or (published_rev is not null and last_published_at is not null) )",
      );
    });
  });

  describe("protect_book_columns (extends D-011 / D-036)", () => {
    const f = latestFunction("private.protect_book_columns");
    const body = ws(f?.body ?? "");
    const [ins, upd = ""] = body.split("elsif tg_op = 'update'");
    const prev = matchesAll(
      /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/,
      migrations.find((x) => x.name === "20261110000900_editor.sql")!.sql,
    )
      .map((x) => ({ name: x[1], body: x[3] }))
      .find((x) => x.name === "private.protect_book_columns")!;
    const [prevIns, prevUpd = ""] = ws(prev.body).split("elsif tg_op = 'update'");
    const assigns = (s: string) => matchesAll(/new\.\w+ := [^;]+;/, s).map((x) => x[0]);

    it("latest definition is the 1000 one: INVOKER, search_path '', privileged-role bypass, revoked", () => {
      expect(f).toBeDefined();
      expect(sql).toContain(f!.body);
      expect(f!.header).not.toMatch(/security\s+definer/);
      expect(f!.header).toMatch(/set\s+search_path\s*=\s*''/);
      expect(body).toMatch(/if current_user in \('postgres', 'service_role', 'supabase_admin'\) then return new; end if;/);
      expect(flat).toContain("revoke all on function private.protect_book_columns() from public, anon, authenticated");
      expect(raw).toMatch(/WARNING: any future SECURITY DEFINER function owned by postgres that writes\s*\n--\s*to public\.books bypasses this guard/);
    });

    it("keeps every assignment of the 0900 guard (INSERT and UPDATE)", () => {
      expect(assigns(prevIns).length).toBeGreaterThanOrEqual(9);
      expect(assigns(prevUpd).length).toBeGreaterThanOrEqual(12);
      for (const a of assigns(prevIns)) expect(assigns(ins), a).toContain(a);
      for (const a of assigns(prevUpd)) expect(assigns(upd), a).toContain(a);
    });

    it.each(GUARDED)("INSERT forces new.%s := null and UPDATE keeps the old value", (col) => {
      expect(assigns(ins)).toContain(`new.${col} := null;`);
      expect(assigns(upd)).toContain(`new.${col} := old.${col};`);
    });

    it("adds nothing beyond the 4 new columns; title / occasion / tone / caption_lang stay client-editable", () => {
      expect(assigns(ins).length).toBe(assigns(prevIns).length + GUARDED.length);
      expect(assigns(upd).length).toBe(assigns(prevUpd).length + GUARDED.length);
      for (const col of ["title", "occasion", "tone", "caption_lang"]) expect(body).not.toMatch(new RegExp(`new\\.${col} :=`));
    });

    it("does not recreate any trigger; BEFORE trigger order on books is unchanged", () => {
      expect(sql).not.toMatch(/\bcreate\s+trigger\b/);
      const names = [...new Set(matchesAll(/create\s+trigger\s+(\w+)\s+before\s+[^;]*?\bon\s+public\.books\b/).map((x) => x[1]))].sort();
      expect(names).toEqual(["books_protect_columns", "books_set_doc_rev", "books_set_updated_at"]);
    });
  });

  describe("public.book_unlock_attempts", () => {
    const acl = effectiveTablePrivileges();

    it("columns, FK cascade with the book, ip_hash length check", () => {
      expect(flat).toContain(
        "create table public.book_unlock_attempts ( id bigserial primary key, book_id uuid not null references public.books (id) on delete cascade, ip_hash text not null, created_at timestamptz not null default now(),",
      );
      expect(flat).toContain("check (char_length(ip_hash) between 1 and 128)");
    });

    it("indexes (book_id, created_at) and (ip_hash, created_at)", () => {
      expect(flat).toMatch(/create index \w+ on public\.book_unlock_attempts \(book_id, created_at\);/);
      expect(flat).toMatch(/create index \w+ on public\.book_unlock_attempts \(ip_hash, created_at\);/);
    });

    it("RLS on, no policies, clients have no privileges, service_role all (table + sequence)", () => {
      expect(policies.filter((p) => p.table === "public.book_unlock_attempts")).toEqual([]);
      expect(sorted(acl["public.book_unlock_attempts"]?.anon)).toEqual([]);
      expect(sorted(acl["public.book_unlock_attempts"]?.authenticated)).toEqual([]);
      expect(sorted(acl["public.book_unlock_attempts"]?.service_role)).toEqual([...ALL_PRIVS].sort());
      expect(flat).toContain("revoke all on table public.book_unlock_attempts from public, anon, authenticated;");
      expect(flat).toContain("revoke all on sequence public.book_unlock_attempts_id_seq from public, anon, authenticated;");
      expect(flat).toContain("grant usage, select on sequence public.book_unlock_attempts_id_seq to service_role;");
    });
  });

  describe("try_book_unlock", () => {
    const f = own(UNLOCK);
    const body = ws(f?.body ?? "");

    it("signature (p_book, p_ip_hash, p_ip_limit, p_book_limit, p_window_s) returns boolean; INVOKER, search_path ''", () => {
      expect(f).toBeDefined();
      expect(latestFunction(UNLOCK)!.body).toBe(f!.body);
      expect(ws(f!.header).trim()).toMatch(
        /^p_book uuid, p_ip_hash text, p_ip_limit integer, p_book_limit integer, p_window_s integer \) returns boolean language plpgsql volatile security invoker set search_path = ''/,
      );
      expect(f!.header).not.toMatch(/security\s+definer/);
    });

    it("rejects null / non-positive limits / out-of-range window / empty ip hash", () => {
      expect(body).toContain(
        "if p_book is null or p_ip_hash is null or p_ip_limit is null or p_book_limit is null or p_window_s is null or p_ip_limit < 1 or p_book_limit < 1 or p_window_s < 1 or p_window_s > 86400 or char_length(p_ip_hash) = 0 then raise exception 'invalid_argument' using errcode = '22023';",
      );
    });

    it("locks the book (key space 4) then the ip (key space 5) before any delete, count or insert", () => {
      const book = body.indexOf("perform pg_advisory_xact_lock(hashtextextended(p_book::text, 4));");
      const ip = body.indexOf("perform pg_advisory_xact_lock(hashtextextended(p_ip_hash, 5));");
      expect(book).toBeGreaterThanOrEqual(0);
      expect(ip).toBeGreaterThan(book);
      for (const s of ["delete from", "select count(*)", "insert into"]) expect(ip, s).toBeLessThan(body.indexOf(s));
    });

    it("advisory key spaces 4 and 5 are used only by the unlock RPCs (try_book_unlock + 1100 clear_unlock_attempt)", () => {
      const spaces = matchesAll(/hashtextextended\s*\([^,]+,\s*(\d+)\s*\)/).map((x) => x[1]);
      expect(spaces.filter((k) => k === "4")).toHaveLength(2);
      expect(spaces.filter((k) => k === "5")).toHaveLength(2);
      const unlockSql = migrations
        .filter((x) => x.name === name || x.name === "20261111001100_unlock_tuning.sql")
        .map((x) => x.sql)
        .join("\n");
      expect(matchesAll(/hashtextextended\s*\([^,]+,\s*[45]\s*\)/, unlockSql)).toHaveLength(4);
    });

    it("housekeeping deletes this book's and this ip's rows older than greatest(window, 1 h)", () => {
      expect(body).toContain("v_keep := make_interval(secs => greatest(p_window_s, 3600));");
      expect(body).toContain("delete from public.book_unlock_attempts as a where a.book_id = p_book and a.created_at < now() - v_keep;");
      expect(body).toContain("delete from public.book_unlock_attempts as a where a.ip_hash = p_ip_hash and a.created_at < now() - v_keep;");
    });

    it("ip limit counts the ip across books in p_window_s; book limit counts the book across ips in 1 hour", () => {
      expect(body).toContain(
        "select count(*) into v_ip_n from public.book_unlock_attempts as a where a.ip_hash = p_ip_hash and a.created_at > now() - make_interval(secs => p_window_s); if v_ip_n >= p_ip_limit then return false;",
      );
      expect(body).toContain(
        "select count(*) into v_book_n from public.book_unlock_attempts as a where a.book_id = p_book and a.created_at > now() - interval '1 hour'; if v_book_n >= p_book_limit then return false;",
      );
    });

    it("records the attempt only when allowed, then returns true", () => {
      expect(body.trim()).toMatch(/insert into public\.book_unlock_attempts \(book_id, ip_hash\) values \(p_book, p_ip_hash\); return true; end;$/);
      expect(body.lastIndexOf("return false")).toBeLessThan(body.indexOf("insert into"));
    });

    it("EXECUTE revoked from public/anon/authenticated, granted to service_role only", () => {
      expect(flat).toContain(`revoke all on function ${UNLOCK}(${UNLOCK_ARGS}) from public, anon, authenticated;`);
      expect(grantsTo(UNLOCK)).toEqual(["service_role"]);
      expect(flat.indexOf(`revoke all on function ${UNLOCK}`)).toBeLessThan(flat.indexOf(`grant execute on function ${UNLOCK}`));
    });
  });

  describe("get_published_book (snapshot read)", () => {
    const f = own("public.get_published_book");
    const body = ws(f?.body ?? "");
    const expired = "(not b.is_paid and b.expires_at is not null and b.expires_at <= now())";

    it("is dropped then created (return type changed) and is the latest definition", () => {
      expect(f).toBeDefined();
      expect(latestFunction("public.get_published_book")!.body).toBe(f!.body);
      expect(flat.indexOf("drop function public.get_published_book(text);")).toBeLessThan(
        flat.indexOf("create function public.get_published_book"),
      );
    });

    it("returns exactly the documented columns, stable INVOKER with search_path ''", () => {
      expect(ws(f!.header).trim()).toMatch(
        /^p_slug text\) returns table \( id uuid, slug text, title text, caption_lang text, is_paid boolean, page_count integer, published_rev bigint, published_at timestamptz, expires_at timestamptz, is_expired boolean, has_password boolean, doc jsonb \) language sql stable security invoker set search_path = ''/,
      );
    });

    it("live = published_doc is not null; never reads books.doc, user_id or the password hash value", () => {
      expect(body).toMatch(/where b\.slug = p_slug and b\.published_doc is not null and b\.published_at is not null limit 1;/);
      expect(body).not.toMatch(/\bb\.doc\b/);
      expect(body).not.toMatch(/\buser_id\b/);
      expect(body).not.toMatch(/\bb\.\*|select \*/);
    });

    it("page_count comes from published_doc.pages", () => {
      expect(body).toContain(
        "case when jsonb_typeof(b.published_doc -> 'pages') = 'array' then jsonb_array_length(b.published_doc -> 'pages') else 0 end as page_count",
      );
    });

    it("paid books never expire; doc is the snapshot only when not expired and no password", () => {
      expect(body).toContain(`${expired} as is_expired`);
      expect(body).toContain(
        `case when ${expired} then null when b.password_hash is not null then null else b.published_doc end as doc`,
      );
    });

    it("EXECUTE: revoked from public/anon/authenticated, granted to service_role only", () => {
      expect(flat).toContain("revoke all on function public.get_published_book(text) from public, anon, authenticated;");
      expect(grantsTo("public.get_published_book")).toEqual(["service_role"]);
      expect(flat.indexOf("revoke all on function public.get_published_book")).toBeGreaterThan(
        flat.indexOf("create function public.get_published_book"),
      );
    });
  });

  it("database.types.ts declares the publish columns, book_unlock_attempts and both RPCs (hand-edited)", () => {
    const types = readFileSync(join(process.cwd(), "src", "lib", "supabase", "database.types.ts"), "utf8");
    expect(types.match(/published_doc\??: Json \| null/g)).toHaveLength(3);
    expect(types.match(/published_rev\??: number \| null/g)).toHaveLength(3);
    expect(types.match(/last_published_at\??: string \| null/g)).toHaveLength(3);
    expect(types).toMatch(/book_unlock_attempts: \{\s*Row: \{\s*book_id: string\s*created_at: string\s*id: number\s*ip_hash: string\s*\}/);
    expect(types).toMatch(
      /try_book_unlock: \{\s*Args: \{\s*p_book: string\s*p_book_limit: number\s*p_ip_hash: string\s*p_ip_limit: number\s*p_window_s: number\s*\}\s*Returns: boolean/,
    );
    expect(types).toMatch(/get_published_book: \{[\s\S]*?published_rev: number[\s\S]*?\}\[\]/);
  });
});

describe("migrations: M6 review S2 unlock tuning (1100)", () => {
  const name = "20261111001100_unlock_tuning.sql";
  const m = migrations.find((x) => x.name === name);
  const sql = m?.sql ?? "";
  const ws = (s: string) => s.replace(/\s+/g, " ");
  const flat = ws(sql);
  const FN = "public.clear_unlock_attempt";
  const f = matchesAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/, sql)
    .map((x) => ({ name: x[1], header: x[2], body: x[3] }))
    .find((x) => x.name === FN);
  const body = ws(f?.body ?? "");

  it("exists, sorts right after 1000 and does not touch the applied 1000 objects", () => {
    expect(m, `${name} missing`).toBeDefined();
    expect(files.indexOf(name)).toBe(files.indexOf("20261111001000_publish.sql") + 1);
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).not.toMatch(/\b(create|alter)\s+(policy|table)\b/);
    expect(sql).not.toMatch(/row\s+level\s+security/);
    expect(sql).not.toMatch(/function\s+public\.(try_book_unlock|get_published_book)\b/);
    expect(sql).not.toMatch(/\b(grant|revoke)\s+[a-z_\s,()]+\s+on\s+(?:table\s+)?public\./);
  });

  it("clear_unlock_attempt(p_book uuid, p_ip_hash text) returns boolean; INVOKER, search_path '', latest definition", () => {
    expect(f).toBeDefined();
    expect(latestFunction(FN)!.body).toBe(f!.body);
    expect(ws(f!.header).trim()).toMatch(
      /^p_book uuid, p_ip_hash text \) returns boolean language plpgsql volatile security invoker set search_path = ''$/,
    );
    expect(f!.header).not.toMatch(/security\s+definer/);
  });

  it("rejects null book / null or empty ip hash with 22023", () => {
    expect(body).toContain(
      "if p_book is null or p_ip_hash is null or char_length(p_ip_hash) = 0 then raise exception 'invalid_argument' using errcode = '22023';",
    );
  });

  it("takes the same advisory locks as try_book_unlock (book 4, then ip 5) before deleting", () => {
    const book = body.indexOf("perform pg_advisory_xact_lock(hashtextextended(p_book::text, 4));");
    const ip = body.indexOf("perform pg_advisory_xact_lock(hashtextextended(p_ip_hash, 5));");
    expect(book).toBeGreaterThanOrEqual(0);
    expect(ip).toBeGreaterThan(book);
    expect(ip).toBeLessThan(body.indexOf("delete from"));
  });

  it("deletes only the newest row of the (book, ip) pair from the last hour and reports it", () => {
    expect(body).toContain(
      "delete from public.book_unlock_attempts as a where a.id = ( select x.id from public.book_unlock_attempts as x where x.book_id = p_book and x.ip_hash = p_ip_hash and x.created_at > now() - interval '1 hour' order by x.created_at desc, x.id desc limit 1 );",
    );
    expect(matchesAll(/delete from/, body)).toHaveLength(1);
    expect(body).toContain("get diagnostics v_n = row_count; return v_n > 0;");
    expect(body).not.toMatch(/insert into|update public/);
  });

  it("EXECUTE revoked from public/anon/authenticated, granted to service_role only", () => {
    expect(flat).toContain(`revoke all on function ${FN}(uuid, text) from public, anon, authenticated;`);
    const grants = matchesAll(new RegExp(`grant execute on function ${esc(FN)}\\s*\\([^)]*\\)\\s+to\\s+([a-z_, ]+?)\\s*;`), sql).map((g) =>
      g[1].trim(),
    );
    expect(grants).toEqual(["service_role"]);
    expect(matchesAll(new RegExp(`grant execute on function ${esc(FN)}\\b`))).toHaveLength(1);
    expect(flat.indexOf(`revoke all on function ${FN}`)).toBeLessThan(flat.indexOf(`grant execute on function ${FN}`));
  });

  it("rls_check.sql covers clear_unlock_attempt (grants + behaviour)", () => {
    const rls = readFileSync(join(process.cwd(), "supabase", "tests", "rls_check.sql"), "utf8");
    expect(rls).toContain("20261111001100_unlock_tuning.sql");
    expect(rls).toContain("RLS FAIL [clear_unlock_attempt grants]");
    expect(rls).toContain("RLS FAIL [anon clear_unlock_attempt]");
    expect(rls).toContain("RLS FAIL [authenticated clear_unlock_attempt]");
    expect(rls).toContain("RLS FAIL [clear_unlock_attempt flow]");
    // the total check count is pinned by the latest milestone suite (1300)
  });

  it("database.types.ts declares clear_unlock_attempt (hand-edited)", () => {
    const types = readFileSync(join(process.cwd(), "src", "lib", "supabase", "database.types.ts"), "utf8");
    expect(types).toMatch(/clear_unlock_attempt: \{\s*Args: \{ p_book: string; p_ip_hash: string \}\s*Returns: boolean/);
  });
});

describe("migrations: Milestone 7 payments (1200)", () => {
  const name = "20261112001200_payments.sql";
  const m = migrations.find((x) => x.name === name);
  const sql = m?.sql ?? "";
  const ws = (s: string) => s.replace(/\s+/g, " ");
  const flat = ws(sql);
  const fns = matchesAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/, sql).map(
    (x) => ({ name: x[1], header: x[2], body: x[3] }),
  );
  const FULFIL = "public.fulfill_book_checkout";
  const RECORD = "public.record_stripe_order_event";
  const fulfil = fns.find((x) => x.name === FULFIL);
  const record = fns.find((x) => x.name === RECORD);
  const SIG = {
    [FULFIL]: "(text, text, text, text, uuid, uuid, integer, text, boolean)",
    [RECORD]: "(text, text, text, text, text, boolean)",
  } as const;

  it("exists, sorts right after 1100 and only adds (no drops except the widened status check)", () => {
    expect(m, `${name} missing`).toBeDefined();
    expect(files.indexOf(name)).toBe(files.indexOf("20261111001100_unlock_tuning.sql") + 1);
    expect(matchesAll(/\bdrop\b/, sql)).toHaveLength(1);
    expect(flat).toContain("alter table public.orders drop constraint orders_status_check;");
    expect(sql).not.toMatch(/disable\s+row\s+level\s+security/);
    expect(sql).not.toMatch(/function\s+private\.protect_book_columns/);
    expect(sql).not.toMatch(/\bcreate\s+policy\b/);
  });

  it("orders: payment intent (unique), paid_at, refunded_at, livemode; widened statuses; one pending per book", () => {
    expect(flat).toMatch(
      /alter table public\.orders add column stripe_payment_intent_id text, add column paid_at timestamptz, add column refunded_at timestamptz, add column livemode boolean;/,
    );
    expect(flat).toContain("add constraint orders_stripe_payment_intent_id_key unique (stripe_payment_intent_id);");
    expect(flat).toContain(
      "add constraint orders_status_check check ( status in ('pending', 'paid', 'failed', 'expired', 'refunded', 'disputed') );",
    );
    expect(flat).toContain("create unique index orders_one_pending_per_book on public.orders (book_id) where status = 'pending';");
    // grants on orders unchanged: no new table grants in this migration
    expect(sql).not.toMatch(/\b(grant|revoke)\s+[a-z_\s,()]+\s+on\s+(?:table\s+)?public\./);
  });

  it("private.stripe_events: RLS on, no policies, nothing for public/anon/authenticated, service_role only", () => {
    expect(flat).toMatch(
      /create table private\.stripe_events \( id text primary key, type text not null, created_at timestamptz not null default now\(\), processed_at timestamptz,/,
    );
    expect(flat).toContain("alter table private.stripe_events enable row level security;");
    expect(flat).toContain("revoke all on table private.stripe_events from public, anon, authenticated;");
    expect(flat).toContain("revoke all on schema private from public, anon, authenticated;");
    expect(flat).toContain("grant select, insert, update on table private.stripe_events to service_role;");
    const grants = matchesAll(/grant\s+[a-z_\s,]+\s+on\s+(?:table\s+)?private\.stripe_events\s+to\s+([a-z_, ]+?)\s*;/, sql).map((g) => g[1].trim());
    expect(grants).toEqual(["service_role"]);
    expect(all).not.toMatch(/grant\s+usage\s+on\s+schema\s+private\s+to\s+[a-z_, ]*\b(anon|authenticated|public)\b/);
  });

  it.each([FULFIL, RECORD])("%s: SECURITY INVOKER, search_path '', returns text (replaced in 1300)", (fn) => {
    const f = fns.find((x) => x.name === fn);
    expect(f, `${fn} missing`).toBeDefined();
    expect(ws(f!.header)).toMatch(/\) returns text language plpgsql volatile security invoker set search_path = '' ?$/);
    expect(f!.header).not.toMatch(/security\s+definer/);
  });

  it.each([FULFIL, RECORD])("%s: EXECUTE revoked from public/anon/authenticated, granted to service_role only", (fn) => {
    const sig = SIG[fn as keyof typeof SIG];
    expect(flat).toContain(`revoke all on function ${fn}${sig} from public, anon, authenticated;`);
    const grants = matchesAll(new RegExp(`grant execute on function ${esc(fn)}\\s*\\([^)]*\\)\\s+to\\s+([a-z_, ]+?)\\s*;`), sql).map((g) =>
      g[1].trim(),
    );
    expect(grants).toEqual(["service_role"]);
    // 1200 + the re-assert in 1300; every grant across all migrations goes to service_role only
    expect(matchesAll(new RegExp(`grant execute on function ${esc(fn)}\\b`))).toHaveLength(2);
    expect(
      matchesAll(new RegExp(`grant execute on function ${esc(fn)}\\s*\\([^)]*\\)\\s+to\\s+([a-z_, ]+?)\\s*;`)).map((g) => g[1].trim()),
    ).toEqual(["service_role", "service_role"]);
    expect(flat.indexOf(`revoke all on function ${fn}`)).toBeLessThan(flat.indexOf(`grant execute on function ${fn}`));
  });

  it("fulfill_book_checkout: signature, 22023 on bad args, dedupe first, then order upsert + entitlement", () => {
    expect(ws(fulfil!.header).trim()).toMatch(
      /^p_event_id text, p_event_type text, p_session_id text, p_payment_intent text, p_book_id uuid, p_user_id uuid, p_amount integer, p_currency text, p_livemode boolean \)/,
    );
    const body = ws(fulfil!.body);
    expect(body).toContain("raise exception 'invalid_argument' using errcode = '22023';");
    const dedupe = body.indexOf("insert into private.stripe_events (id, type) values (p_event_id, p_event_type) on conflict (id) do nothing returning id into v_inserted;");
    expect(dedupe).toBeGreaterThan(0);
    expect(body).toContain("if v_inserted is null then return 'duplicate'; end if;");
    expect(body.indexOf("insert into public.orders")).toBeGreaterThan(dedupe);
    expect(body).toMatch(/where b\.id = p_book_id and b\.user_id = p_user_id for update;/);
    expect(body).toContain("on conflict (stripe_session_id) do update");
    expect(body).toContain("set is_paid = true, max_pages = 100, expires_at = null where b.id = v_book and b.user_id = p_user_id;");
    for (const r of ["'fulfilled'", "'already_paid'", "'book_missing'", "'duplicate'"]) expect(body).toContain(`return ${r};`);
  });

  it("record_stripe_order_event: dedupe via stripe_events, never touches books, only the 4 statuses", () => {
    expect(ws(record!.header).trim()).toMatch(
      /^p_event_id text, p_event_type text, p_session_id text, p_payment_intent text, p_status text, p_livemode boolean \)/,
    );
    const body = ws(record!.body);
    expect(body).toContain("p_status not in ('expired', 'failed', 'refunded', 'disputed')");
    expect(body).toContain("on conflict (id) do nothing returning id into v_inserted;");
    expect(body).not.toMatch(/public\.books|is_paid/);
    expect(body).toContain("refunded_at = case when v_new = 'refunded' then coalesce(o.refunded_at, now()) else o.refunded_at end");
    for (const r of ["'updated'", "'unchanged'", "'order_missing'", "'duplicate'"]) expect(body).toContain(`return ${r};`);
  });

  it("rls_check.sql covers payments (grants, stripe_events, guard, fulfil, replay, mismatch, refund, one pending)", () => {
    const rls = readFileSync(join(process.cwd(), "supabase", "tests", "rls_check.sql"), "utf8");
    expect(rls).toContain(name);
    for (const tag of [
      "payments rpc grants",
      "authenticated fulfill_book_checkout",
      "authenticated record_stripe_order_event",
      "stripe_events",
      "orders insert",
      "orders update",
      "payments guard",
      "fulfil",
      "fulfil replay",
      "fulfil mismatch",
      "refund",
      "one pending",
      "order events",
      "payments args",
    ]) {
      expect(rls).toContain(`RLS FAIL [${tag}]`);
    }
    // the total check count is pinned by the latest milestone suite (1300)
  });

  it("database.types.ts declares the orders columns and both RPCs (hand-edited)", () => {
    const types = readFileSync(join(process.cwd(), "src", "lib", "supabase", "database.types.ts"), "utf8");
    expect(types.match(/stripe_payment_intent_id\??: string \| null/g)).toHaveLength(3);
    expect(types.match(/paid_at\??: string \| null/g)).toHaveLength(3);
    expect(types.match(/refunded_at\??: string \| null/g)).toHaveLength(3);
    expect(types.match(/livemode\??: boolean \| null/g)).toHaveLength(3);
    expect(types).toMatch(/fulfill_book_checkout: \{\s*Args: \{[\s\S]*?p_book_id: string[\s\S]*?\}\s*Returns: string/);
    expect(types).toMatch(/record_stripe_order_event: \{\s*Args: \{[\s\S]*?p_status: string\s*\}\s*Returns: string/);
  });
});

describe("migrations: Milestone 7 payments review (1300)", () => {
  const name = "20261112001300_payments_review.sql";
  const m = migrations.find((x) => x.name === name);
  const sql = m?.sql ?? "";
  const ws = (s: string) => s.replace(/\s+/g, " ");
  const flat = ws(sql);
  const fns = matchesAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/, sql).map(
    (x) => ({ name: x[1], header: x[2], body: x[3] }),
  );
  const FULFIL = "public.fulfill_book_checkout";
  const RECORD = "public.record_stripe_order_event";
  const fulfil = fns.find((x) => x.name === FULFIL);
  const record = fns.find((x) => x.name === RECORD);
  const SIG = {
    [FULFIL]: "(text, text, text, text, uuid, uuid, integer, text, boolean)",
    [RECORD]: "(text, text, text, text, text, boolean)",
  } as const;

  it("exists, sorts right after 1200, only drops+re-adds the status check (1200 untouched)", () => {
    expect(m, `${name} missing`).toBeDefined();
    expect(files.indexOf(name)).toBe(files.indexOf("20261112001200_payments.sql") + 1);
    expect(matchesAll(/\bdrop\b/, sql)).toHaveLength(1);
    expect(flat).toContain("alter table public.orders drop constraint orders_status_check;");
    expect(flat).toContain(
      "add constraint orders_status_check check ( status in ('pending', 'paid', 'failed', 'expired', 'refunded', 'disputed', 'needs_review') );",
    );
    expect(sql).not.toMatch(/disable\s+row\s+level\s+security/);
    expect(sql).not.toMatch(/\bcreate\s+policy\b/);
    expect(sql).not.toMatch(/\b(grant|revoke)\s+[a-z_\s,()]+\s+on\s+(?:table\s+)?(public|private)\./);
  });

  it.each([FULFIL, RECORD])("%s: same signature, SECURITY INVOKER, search_path '', returns text, latest definition", (fn) => {
    const f = fns.find((x) => x.name === fn);
    expect(f, `${fn} missing`).toBeDefined();
    expect(latestFunction(fn)!.body).toBe(f!.body);
    expect(ws(f!.header)).toMatch(/\) returns text language plpgsql volatile security invoker set search_path = '' ?$/);
    expect(f!.header).not.toMatch(/security\s+definer/);
    const sig = SIG[fn as keyof typeof SIG];
    expect(flat).toContain(`revoke all on function ${fn}${sig} from public, anon, authenticated;`);
    const grants = matchesAll(new RegExp(`grant execute on function ${esc(fn)}\\s*\\([^)]*\\)\\s+to\\s+([a-z_, ]+?)\\s*;`), sql).map((g) =>
      g[1].trim(),
    );
    expect(grants).toEqual(["service_role"]);
    expect(flat.indexOf(`revoke all on function ${fn}`)).toBeLessThan(flat.indexOf(`grant execute on function ${fn}`));
  });

  it("record_stripe_order_event: accepts needs_review only from pending / expired / failed, never touches books", () => {
    const body = ws(record!.body);
    expect(body).toContain("p_status not in ('expired', 'failed', 'refunded', 'disputed', 'needs_review')");
    expect(body).toContain("when p_status = 'needs_review' and v_status in ('pending', 'expired', 'failed') then 'needs_review'");
    expect(body).not.toMatch(/public\.books|is_paid/);
    for (const r of ["'updated'", "'unchanged'", "'order_missing'", "'duplicate'"]) expect(body).toContain(`return ${r};`);
  });

  it("fulfill_book_checkout: already_paid_other_session, skips the no-op books update, keeps 1200 semantics", () => {
    const body = ws(fulfil!.body);
    expect(body).toContain("raise exception 'invalid_argument' using errcode = '22023';");
    expect(body.indexOf("on conflict (id) do nothing returning id into v_inserted;")).toBeLessThan(body.indexOf("insert into public.orders"));
    expect(body).toContain("if not (v_was_paid and v_max_pages = 100 and v_expires is null) then update public.books as b");
    expect(body).toContain("o2.stripe_session_id is distinct from p_session_id and o2.status in ('paid', 'disputed')");
    for (const r of ["'fulfilled'", "'already_paid'", "'already_paid_other_session'", "'book_missing'", "'duplicate'"]) {
      expect(body).toContain(`return ${r};`);
    }
  });

  it("rls_check.sql covers the review fixes", () => {
    const rls = readFileSync(join(process.cwd(), "supabase", "tests", "rls_check.sql"), "utf8");
    expect(rls).toContain(name);
    for (const tag of ["needs_review", "double payment", "fulfil no-op"]) expect(rls).toContain(`RLS FAIL [${tag}]`);
    // the total check count is pinned by the latest milestone suite (1400)
  });
});

describe("migrations: Milestone 8 exports (1400, D-047 / D-051)", () => {
  const name = "20261113001400_exports.sql";
  const m = migrations.find((x) => x.name === name);
  const sql = m?.sql ?? "";
  const ws = (s: string) => s.replace(/\s+/g, " ");
  const flat = ws(sql);
  const fns = matchesAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/, sql).map(
    (x) => ({ name: x[1], header: x[2], body: x[3] }),
  );
  const SIG = {
    "public.create_export_job": "(uuid, uuid, bigint, jsonb, text, integer, integer)",
    "public.claim_export": "(uuid, integer)",
    "public.finish_export": "(uuid, uuid, text, bigint, integer)",
    "public.fail_export": "(uuid, uuid, text)",
  } as const;
  const RETURNS = {
    "public.create_export_job": "jsonb",
    "public.claim_export": "uuid",
    "public.finish_export": "boolean",
    "public.fail_export": "boolean",
  } as const;
  const OWNER_COLS = ["id", "book_id", "doc_rev", "status", "bytes", "page_count", "error_code", "created_at", "finished_at"];
  const fn = (n: string) => fns.find((x) => x.name === n);

  it("exists, sorts right after 1300, only adds (no drop, no edits of older objects)", () => {
    expect(m, `${name} missing`).toBeDefined();
    expect(files.indexOf(name)).toBe(files.indexOf("20261112001300_payments_review.sql") + 1);
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.(?!exports\b)/);
    expect(sql).not.toMatch(/disable\s+row\s+level\s+security/);
    expect(fns.map((f) => f.name).sort()).toEqual(Object.keys(SIG).sort());
  });

  it("public.exports: columns, FKs cascade, doc snapshot ≤ 1 MiB, status / lang / code checks", () => {
    expect(flat).toContain("book_id uuid not null references public.books (id) on delete cascade,");
    expect(flat).toContain("user_id uuid not null references auth.users (id) on delete cascade,");
    expect(flat).toContain("doc_rev bigint not null,");
    expect(flat).toContain("doc jsonb not null,");
    expect(flat).toContain("constraint exports_doc_size check (pg_column_size(doc) <= 1048576)");
    expect(flat).toContain("constraint exports_caption_lang_check check (caption_lang in ('en', 'ar'))");
    expect(flat).toContain("constraint exports_status_check check (status in ('queued', 'rendering', 'ready', 'failed'))");
    expect(flat).toContain("status text not null default 'queued',");
    expect(flat).toContain("attempt integer not null default 0,");
    expect(flat).toContain("error_code is null or error_code ~ '^[a-z0-9_]{1,64}$'");
    expect(flat).toContain("bytes is null or bytes between 1 and 52428800");
  });

  it("path must be exactly {user_id}/{book_id}/{id}.pdf (bucket exports convention, 0200)", () => {
    expect(flat).toContain(
      "constraint exports_path_owner check ( path is null or path = (user_id::text || '/' || book_id::text || '/' || id::text || '.pdf') )",
    );
  });

  it("indexes: ready lookup, per-user daily count, one job in flight per book", () => {
    expect(flat).toContain("create index exports_book_ready_idx on public.exports (book_id, doc_rev) where status = 'ready';");
    expect(flat).toContain("create index exports_user_created_idx on public.exports (user_id, created_at);");
    expect(flat).toContain(
      "create unique index exports_one_active_per_book on public.exports (book_id) where status in ('queued', 'rendering');",
    );
  });

  it("RLS on, one owner-only SELECT policy, no client write policies", () => {
    expect(flat).toContain("alter table public.exports enable row level security;");
    const ps = policies.filter((p) => p.table === "public.exports");
    expect(ps).toHaveLength(1);
    expect(ws(ps[0].text)).toContain("for select to authenticated using (user_id = (select auth.uid()))");
  });

  it("grants: nothing for anon; authenticated only column SELECT on the status columns; service_role all", () => {
    const acl = effectiveTablePrivileges();
    expect(sorted(acl["public.exports"]?.anon)).toEqual([]);
    expect(sorted(acl["public.exports"]?.authenticated)).toEqual([]);
    expect(sorted(acl["public.exports"]?.service_role)).toEqual([...ALL_PRIVS].sort());
    expect(flat).toContain("revoke all on table public.exports from public, anon, authenticated;");
    const g = matchesAll(/grant\s+select\s*\(([^)]*)\)\s+on\s+(?:table\s+)?public\.exports\s+to\s+([a-z_, ]+);/);
    expect(g).toHaveLength(1);
    expect(g[0][2].trim()).toBe("authenticated");
    expect(g[0][1].split(",").map((c) => c.trim())).toEqual(OWNER_COLS);
    expect(all).not.toMatch(/grant\s+(insert|update|delete)[^;]*on\s+(?:table\s+)?public\.exports\s+to\s+[a-z_, ]*\b(anon|authenticated)\b/);
  });

  it("src/lib/db/exports.ts owner reads select only granted columns", () => {
    const src = readFileSync(join(process.cwd(), "src", "lib", "db", "exports.ts"), "utf8");
    const cols = src.match(/export const OWNER_EXPORT_COLUMNS =\s*"([^"]+)"/);
    expect(cols).not.toBeNull();
    for (const c of cols![1].split(",").map((x) => x.trim())) expect(OWNER_COLS, c).toContain(c);
  });

  it.each(Object.keys(SIG))("%s: SECURITY INVOKER, search_path '', service_role-only EXECUTE", (n) => {
    const f = fn(n);
    expect(f, `${n} missing`).toBeDefined();
    const ret = RETURNS[n as keyof typeof RETURNS];
    expect(ws(f!.header)).toMatch(new RegExp(`\\) returns ${ret} language plpgsql volatile security invoker set search_path = '' ?$`));
    expect(f!.header).not.toMatch(/security\s+definer/);
    const sig = SIG[n as keyof typeof SIG];
    expect(flat).toContain(`revoke all on function ${n}${sig} from public, anon, authenticated;`);
    expect(flat).toContain(`grant execute on function ${n}${sig} to service_role;`);
    const grants = matchesAll(new RegExp(`grant execute on function ${esc(n)}\\s*\\([^)]*\\)\\s+to\\s+([a-z_, ]+?)\\s*;`)).map((g) =>
      g[1].trim(),
    );
    expect(grants).toEqual(["service_role"]);
    expect(flat.indexOf(`revoke all on function ${n}`)).toBeLessThan(flat.indexOf(`grant execute on function ${n}`));
    expect(ws(f!.body)).toContain("raise exception 'invalid_argument' using errcode = '22023';");
  });

  it("create_export_job: new advisory key space 6, owner + live is_paid, reap → reuse → running → cap → insert", () => {
    const body = ws(fn("public.create_export_job")!.body);
    const used = matchesAll(/hashtextextended\s*\([^,]+,\s*(\d+)\s*\)/).map((x) => x[1]);
    expect(used.filter((k) => k === "6")).toHaveLength(1);
    const lock = body.indexOf("perform pg_advisory_xact_lock(hashtextextended(p_user::text, 6));");
    const owner = body.indexOf("where b.id = p_book and b.user_id = p_user;");
    const paid = body.indexOf("return jsonb_build_object('status', 'not_paid');");
    const rev = body.indexOf("return jsonb_build_object('status', 'stale_rev', 'doc_rev', v_rev);");
    const reap = body.indexOf("set status = 'failed', error_code = 'stale'");
    const ready = body.indexOf("return jsonb_build_object('status', 'ready', 'export_id', v_id);");
    const running = body.indexOf("return jsonb_build_object('status', 'running', 'export_id', v_id, 'doc_rev', v_frev);");
    const cap = body.indexOf("return jsonb_build_object('status', 'daily_cap');");
    const insert = body.indexOf("insert into public.exports");
    const order = [lock, owner, paid, rev, reap, ready, running, cap, insert];
    expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain("e.created_at > now() - interval '24 hours'");
    expect(body).toContain("e.caption_lang = p_caption_lang");
    expect(body).toContain("return jsonb_build_object('status', 'created', 'export_id', v_id);");
  });

  it("claim / finish / fail: lease token checks, attempts capped at 3", () => {
    const claim = ws(fn("public.claim_export")!.body);
    expect(claim).toContain("and e.attempt < 3");
    expect(claim).toContain("(e.status = 'queued' or (e.status = 'rendering' and e.lease_until < now()))");
    expect(claim).toContain("v_secs := least(900, greatest(30, p_lease_seconds));");
    for (const n of ["public.finish_export", "public.fail_export"]) {
      const body = ws(fn(n)!.body);
      expect(body, n).toContain("and e.status = 'rendering' and e.lease_token = p_token;");
      expect(body, n).toContain("lease_token = null, lease_until = null");
      expect(body, n).toContain("return found;");
    }
  });

  it("rls_check.sql covers exports and counts 141 checks", () => {
    const rls = readFileSync(join(process.cwd(), "supabase", "tests", "rls_check.sql"), "utf8");
    expect(rls).toContain(name);
    for (const tag of [
      "exports grants",
      "exports columns",
      "exports rpc grants",
      "exports create",
      "exports running",
      "exports not_paid",
      "exports not_found",
      "exports stale_rev",
      "exports claim",
      "exports token",
      "exports ready reuse",
      "exports fail",
      "exports daily_cap",
      "exports stale",
      "exports path",
      "exports attempts",
      "exports args",
      "exports one active",
      "exports owner read",
      "exports cross-user",
      "exports doc",
      "exports client write",
      "exports client rpc",
      "exports anon",
      "exports cascade",
    ]) {
      expect(rls).toContain(`RLS FAIL [${tag}]`);
    }
    expect(rls).toContain("RLS OK — all 141 checks passed");
  });

  it("database.types.ts declares exports and the 4 RPCs (hand-edited)", () => {
    const types = readFileSync(join(process.cwd(), "src", "lib", "supabase", "database.types.ts"), "utf8");
    expect(types).toMatch(/exports: \{\s*Row: \{[\s\S]*?lease_token: string \| null[\s\S]*?\}\s*Insert:/);
    expect(types).toMatch(/create_export_job: \{\s*Args: \{[\s\S]*?p_doc: Json[\s\S]*?\}\s*Returns: Json/);
    expect(types).toMatch(/claim_export: \{\s*Args: \{ p_export: string; p_lease_seconds: number \}\s*Returns: string/);
    expect(types).toMatch(/finish_export: \{\s*Args: \{[\s\S]*?p_token: string\s*\}\s*Returns: boolean/);
    expect(types).toMatch(/fail_export: \{\s*Args: \{ p_code: string; p_export: string; p_token: string \}\s*Returns: boolean/);
  });
});
