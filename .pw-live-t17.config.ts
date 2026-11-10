import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  reporter: "list",
  outputDir: "/private/tmp/claude-501/-Users-praveenkumar-photobook-app/1f41f252-eef0-4ad1-a2f2-b8ec5611183c/scratchpad/pw-out",
  use: { baseURL: "http://localhost:3717", trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
