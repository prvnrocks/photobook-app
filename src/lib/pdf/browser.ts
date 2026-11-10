import "server-only";
// Headless Chromium for PDF export (D-052). Serverless (Vercel / AWS Lambda on Linux): the
// @sparticuz/chromium headless-shell binary, inflated from its bin/*.br files (shipped via
// outputFileTracingIncludes in next.config.ts). Anywhere else: the Chrome at PDF_CHROME_PATH
// (e.g. Playwright's chromium) — no download, no fallback to a system browser.
//
// Both packages are loaded with dynamic import() so merely importing this module (route
// handlers, tests) never touches the 60+ MB binary. Callers must close the browser — use
// withBrowser() which does it in finally.

import type { Browser, LaunchOptions } from "puppeteer-core";
import { PdfRenderError } from "./errors";

/** Launch budget: cold-start inflation of the serverless binary takes a few seconds. */
export const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
/** CDP call budget (page.pdf of a 20-sheet chunk is one call). */
export const BROWSER_PROTOCOL_TIMEOUT_MS = 120_000;

const COMMON_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-background-networking",
  "--no-first-run",
  "--no-default-browser-check",
  "--mute-audio",
  // Glyph outlines in the PDF, not hinted-for-screen metrics.
  "--font-render-hinting=none",
];

export function isServerlessRuntime(env: Record<string, string | undefined> = process.env, platform: string = process.platform): boolean {
  return platform === "linux" && Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME);
}

/** Launch options for this runtime; throws PdfRenderError('chrome_unavailable'). */
export async function browserLaunchOptions(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): Promise<LaunchOptions> {
  const base: LaunchOptions = {
    timeout: BROWSER_LAUNCH_TIMEOUT_MS,
    protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
    defaultViewport: null,
    // Puppeteer must not install its own SIGINT/SIGTERM/exit handlers in a long-lived server.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };

  if (isServerlessRuntime(env, platform)) {
    try {
      const { default: chromium } = await import("@sparticuz/chromium");
      // No WebGL needed for print: skips inflating swiftshader on cold start.
      chromium.setGraphicsMode = false;
      return {
        ...base,
        executablePath: await chromium.executablePath(),
        args: [...chromium.args, ...COMMON_ARGS],
        headless: "shell",
      };
    } catch {
      throw new PdfRenderError("chrome_unavailable");
    }
  }

  const path = env.PDF_CHROME_PATH?.trim();
  if (!path) throw new PdfRenderError("chrome_unavailable");
  // A full Chrome (Chrome for Testing) only supports new headless; headless-shell binaries accept it too.
  return { ...base, executablePath: path, args: COMMON_ARGS, headless: true };
}

export async function launchBrowser(): Promise<Browser> {
  const opts = await browserLaunchOptions();
  try {
    const { default: puppeteer } = await import("puppeteer-core");
    return await puppeteer.launch(opts);
  } catch {
    throw new PdfRenderError("chrome_unavailable");
  }
}

/** Runs `fn` with a fresh browser and always closes it (kills the process if close hangs). */
export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launchBrowser();
  try {
    return await fn(browser);
  } finally {
    await closeBrowser(browser);
  }
}

export async function closeBrowser(browser: Browser): Promise<void> {
  const proc = browser.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("close timeout")), 5_000);
      }),
    ]);
  } catch {
    try {
      proc?.kill("SIGKILL");
    } catch {
      // already gone
    }
  } finally {
    clearTimeout(timer);
  }
}
