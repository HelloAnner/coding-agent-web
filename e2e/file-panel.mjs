import assert from "node:assert/strict";
import { showSidebarFiles } from "./sidebar.mjs";

export const filePanelFixture = `<!doctype html><html><body style="margin:20px;min-height:2400px">
<label>Notes <input id="notes"></label>
<label>Filter <select id="filter"><option>All</option><option>Pending</option></select></label>
<p>HTML preview state must survive layout changes.</p>
<script>window.previewInstance = Math.random();</script></body></html>`;

export async function checkFilePanel(page, filePath) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  // The explorer lives in the sidebar's files: below the sessions, or its tab.
  await showSidebarFiles(page);
  // The DOM title normalizes Windows paths to forward slashes
  // (lib/file-paths.ts normalizeFilePathSlashes), so match in that form.
  await page.getByTitle(filePath.replace(/\\/g, "/"), { exact: true }).click();
  const panel = page.locator("#file-panel");
  const iframe = panel.locator("iframe");
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.locator("#notes").fill("Keep this note");
  await frame.locator("#filter").selectOption({ label: "Pending" });
  await frame.evaluate(() => scrollTo(0, 120));
  const instance = await frame.evaluate(() => window.previewInstance);
  const width = () => panel.evaluate(async el => {
    await new Promise(requestAnimationFrame);
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
    return el.getBoundingClientRect().width;
  });
  const storedWidths = () => page.evaluate(() => [
    localStorage.getItem("pi-sidebar-width"), localStorage.getItem("pi-right-panel-width"),
  ]);
  // The chat top bar's toggle is the only panel switch (the panel's own copy
  // sat beside a full-width mode that is gone), and on a phone it can hide
  // behind the toolbar overflow: click it in the page.
  const togglePanel = () => page.evaluate(() => {
    document.querySelector('button[aria-controls="file-panel"]')?.click();
  });

  // Include a manually resized split in the round trip.
  const separator = page.locator('[data-resize-handle="right-panel"]');
  if (await separator.isVisible()) await separator.press("ArrowLeft");
  const originalWidth = await width();
  const originalStored = await storedWidths();

  // Closing keeps the viewer mounted: reopening restores the same preview
  // instance, its scroll and its fields, at the same width.
  await togglePanel();
  await page.waitForFunction(() => document.querySelector("#file-panel")?.classList.contains("right-panel-closed"));
  assert.equal(await page.locator("#session-sidebar").evaluate(el => el.inert), false);
  await togglePanel();
  await page.waitForFunction(() => document.querySelector("#file-panel")?.classList.contains("right-panel-open"));
  assert.equal(await frame.evaluate(() => window.previewInstance), instance);
  assert.equal(await frame.evaluate(() => scrollY), 120);
  assert.equal(await frame.locator("#notes").inputValue(), "Keep this note");
  assert.equal(await frame.locator("#filter").inputValue(), "Pending");
  assert.equal(await width(), originalWidth);
  assert.deepEqual(await storedWidths(), originalStored);

  await togglePanel();
  await page.waitForFunction(() => document.querySelector("#file-panel")?.classList.contains("right-panel-closed"));
  console.log(`PASS: file panel width and preview state at ${page.viewportSize().width}px`);
}
