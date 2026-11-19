// Task 10: print checks on the share page's PDF card at 375 px (dev fixture /dev-publish, no auth, no
// DB) and the export error lines in the editor's PDF control (static View render is unit-tested in
// tests/pdf-download.test.tsx). Run against `next dev` (the dev route 404s under next start).
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 812 } });

test.describe("print checks on the share page (375 px)", () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get("/dev-publish?state=paid&checks=ok");
    test.skip(res.status() === 404, "/dev-publish is dev-only");
  });

  for (const kind of ["ok", "notes", "errors"] as const) {
    test(`${kind}: summary + lines inside the PDF card, no sideways scroll`, async ({ page }) => {
      await page.goto(`/dev-publish?state=paid&checks=${kind}&toolbar=0`);
      const checks = page.getByTestId("print-checks");
      await expect(checks).toBeVisible();
      await expect(checks).toHaveAttribute("data-state", kind === "errors" ? "error" : kind);
      const summary = await page.getByTestId("print-checks-summary").textContent();
      if (kind === "ok") expect(summary).toBe("Checks passed for digital A5 PDF");
      if (kind === "notes") expect(summary).toBe("Checks passed for digital A5 PDF, with 2 notes");
      if (kind === "errors") {
        expect(summary).toBe("2 things to fix before the PDF can be made");
        await expect(checks.locator("li").first()).toHaveText("Page 5 is empty — add a photo or text, or delete the page");
      }
      expect(await page.locator("body").textContent()).not.toMatch(/print-ready|certified/i);
      // inside the PDF card, above the download button
      const card = page.getByTestId("publish-pdf");
      await expect(card.getByTestId("print-checks")).toBeVisible();
      const [a, b] = await Promise.all([checks.boundingBox(), card.getByTestId("pdf-download").boundingBox()]);
      expect(a!.y).toBeLessThan(b!.y);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (kind !== "ok") {
        await card.scrollIntoViewIfNeeded();
        await card.screenshot({ path: `docs/design/task10-print-checks-375-${kind}.png` });
      }
    });
  }

  test("free books show no checks (no PDF)", async ({ page }) => {
    await page.goto(`/dev-publish?state=live&checks=errors&toolbar=0`);
    await expect(page.getByTestId("publish-pdf-locked")).toBeVisible();
    await expect(page.getByTestId("print-checks")).toHaveCount(0);
  });
});
