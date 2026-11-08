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
