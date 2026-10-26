/**
 * The sidebar lists sessions only; a project's files are the right panel's
 * first column, beside the viewer.
 */

/** Shows the file tree: opens the right panel, then its files column on a phone. */
export async function showSidebarFiles(page) {
  const panel = page.locator("#file-panel");
  const show = page.getByRole("button", { name: "Show file panel", exact: true });
  if (await show.isVisible()) await show.click();
  const browser = page.locator("#file-browser");
  if (!(await browser.isVisible())) {
    await panel.getByRole("button", { name: "Files", exact: true }).click();
  }
  await browser.waitFor({ state: "visible" });
}

/** Shows the session rows (the sidebar's only view now). */
export async function showSidebarSessions(page) {
  await page.locator(".sidebar-brand").first().waitFor();
  await page.locator("#session-sidebar-panel-sessions").waitFor({ state: "visible" });
}
