import { describe, expect, it, vi } from "vitest";
import { UsageError, compBook, parseArgs, validate } from "../scripts/comp-book.mjs";

const BOOK = "11111111-2222-4333-8444-555555555555";
const ADMIN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "99999999-2222-4333-8444-555555555555";

describe("scripts/comp-book.mjs (D-061)", () => {
  it("parses --book / --admin / --reason", () => {
    expect(parseArgs(["--book", BOOK, "--admin", ADMIN, "--reason", "demo"])).toEqual({
      book: BOOK,
      admin: ADMIN,
      reason: "demo",
    });
  });

  it.each([
    [["--revert", "--book", BOOK]],
    [["--book"]],
    [["--book", "--admin", ADMIN]],
    [["--user", BOOK]],
    [[BOOK]],
  ])("rejects %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  it("requires --admin to be listed in ADMIN_USER_IDS (case-insensitive, invalid entries ignored)", () => {
    const args = { book: BOOK, admin: ADMIN.toUpperCase(), reason: "  demo  " };
    expect(validate(args, ` nope, ${ADMIN} `)).toEqual({ book: BOOK, admin: ADMIN, reason: "demo" });
    expect(() => validate(args, OTHER)).toThrow(/ADMIN_USER_IDS/);
    expect(() => validate(args, "")).toThrow(/ADMIN_USER_IDS/);
    expect(() => validate(args, undefined)).toThrow(/ADMIN_USER_IDS/);
  });

  it.each([
    [{ book: "x", admin: ADMIN, reason: "demo" }, /--book/],
    [{ admin: ADMIN, reason: "demo" }, /--book/],
    [{ book: BOOK, admin: "x", reason: "demo" }, /--admin/],
    [{ book: BOOK, admin: ADMIN }, /--reason/],
    [{ book: BOOK, admin: ADMIN, reason: "   " }, /--reason/],
    [{ book: BOOK, admin: ADMIN, reason: "a".repeat(201) }, /--reason/],
    [{ book: BOOK, admin: ADMIN, reason: "demo\nx" }, /--reason/],
  ])("validate rejects %j", (args, msg) => {
    expect(() => validate(args, ADMIN)).toThrow(msg);
  });

  it("accepts a 200-code-point reason (Arabic)", () => {
    const reason = "م".repeat(200);
    expect(validate({ book: BOOK, admin: ADMIN, reason }, ADMIN).reason).toBe(reason);
  });

  it("calls comp_book with the exact args and returns its result", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "comped", error: null });
    await expect(compBook({ rpc }, { book: BOOK, admin: ADMIN, reason: "demo" })).resolves.toBe("comped");
    expect(rpc).toHaveBeenCalledWith("comp_book", { p_book: BOOK, p_admin: ADMIN, p_reason: "demo" });
  });

  it("RPC errors carry the code only; unknown results are rejected", async () => {
    const failing = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "secret detail" } }) };
    await expect(compBook(failing, { book: BOOK, admin: ADMIN, reason: "demo" })).rejects.toThrow(
      /^comp_book failed \(42501\)$/,
    );
    const odd = { rpc: vi.fn().mockResolvedValue({ data: "fulfilled", error: null }) };
    await expect(compBook(odd, { book: BOOK, admin: ADMIN, reason: "demo" })).rejects.toThrow(/bad_result/);
  });
});
