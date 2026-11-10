import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const executablePath = vi.fn(async () => "/tmp/chromium");
vi.mock("@sparticuz/chromium", () => ({
  default: { args: ["--headless='shell'", "--no-sandbox"], executablePath, setGraphicsMode: true },
}));

import { browserLaunchOptions, isServerlessRuntime } from "@/lib/pdf/browser";

describe("isServerlessRuntime", () => {
  it("is true only on Linux with VERCEL or AWS_LAMBDA_FUNCTION_NAME", () => {
    expect(isServerlessRuntime({ VERCEL: "1" }, "linux")).toBe(true);
    expect(isServerlessRuntime({ AWS_LAMBDA_FUNCTION_NAME: "fn" }, "linux")).toBe(true);
    expect(isServerlessRuntime({}, "linux")).toBe(false);
    expect(isServerlessRuntime({ VERCEL: "1" }, "darwin")).toBe(false); // `vercel dev` on a Mac
  });
});

describe("browserLaunchOptions", () => {
  it("serverless: @sparticuz/chromium binary + args, headless shell", async () => {
    const opts = await browserLaunchOptions({ VERCEL: "1", PDF_CHROME_PATH: "/ignored" }, "linux");
    expect(executablePath).toHaveBeenCalled();
    expect(opts.executablePath).toBe("/tmp/chromium");
    expect(opts.headless).toBe("shell");
    expect(opts.args).toEqual(expect.arrayContaining(["--no-sandbox", "--disable-dev-shm-usage"]));
    expect(opts.handleSIGTERM).toBe(false);
  });

  it("serverless: a failing binary inflate is chrome_unavailable", async () => {
    executablePath.mockRejectedValueOnce(new Error("ENOSPC /tmp/chromium"));
    await expect(browserLaunchOptions({ VERCEL: "1" }, "linux")).rejects.toMatchObject({
      code: "chrome_unavailable",
      message: "PDF render failed (chrome_unavailable)",
    });
  });

  it("local: PDF_CHROME_PATH, else chrome_unavailable", async () => {
    const opts = await browserLaunchOptions({ PDF_CHROME_PATH: " /Apps/Chrome " }, "darwin");
    expect(opts.executablePath).toBe("/Apps/Chrome");
    expect(opts.headless).toBe(true);
    await expect(browserLaunchOptions({}, "darwin")).rejects.toMatchObject({ code: "chrome_unavailable" });
    await expect(browserLaunchOptions({ PDF_CHROME_PATH: "  " }, "linux")).rejects.toMatchObject({
      code: "chrome_unavailable",
    });
  });
});
