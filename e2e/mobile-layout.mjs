// node e2e/mobile-layout.mjs — real styles and tab markup, no Next server or user data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
import { chromium } from "playwright";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { TabBar } = await jiti.import("@/components/TabBar");
const tabs = renderToStaticMarkup(React.createElement(I18nProvider, null,
  React.createElement(TabBar, {
    tabs: Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, label: `mobile-layout-${i}.tsx`, filePath: `/project/mobile-layout-${i}.tsx` })),
    activeTabId: "0", onSelectTab() {}, onCloseTab() {},
  })));
const css = (await Promise.all([
  "app/globals.css", "app/settings.css", "app/sidebar.css", "dashboard/ui/dashboard.css", "notes/ui/notes.css",
].map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")))).join("\n").replace(/^@import .*;$/gm, "");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const content = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*,*::before,*::after{box-sizing:border-box}body{margin:0}${css}</style>
    <div class="chat-topbar" style="display:flex;height:36px"><button style="width:36px;height:36px">☰</button></div>
    <fieldset class="chat-input-shell" style="padding:0 16px 8px"><div class="chat-input-controls"><button style="width:32px;height:32px">…</button></div></fieldset>
    <button class="chat-scroll-to-bottom is-visible">↓</button>
    <div class="file-panel-header" style="display:flex;height:36px">
      <button class="file-panel-terminal-button">‹</button><div style="flex:1;overflow:hidden">${tabs}</div>
      <button class="file-panel-terminal-button">›</button>
    </div>
    <div class="file-viewer-toolbar" style="display:flex;align-items:center;gap:8px;padding:5px 12px">
      <span class="file-viewer-path">project/a-very-long-file-name.md</span><span class="file-viewer-live-indicator"></span>
      <div class="file-viewer-controls">
        <div class="file-viewer-actions"><button class="file-viewer-icon-button">@</button><button class="file-viewer-icon-button">↵</button></div>
        <div class="file-viewer-mode-switch"><button class="file-viewer-mode-button">Source</button><button class="file-viewer-mode-button">Preview</button><button class="file-viewer-mode-button">Diff</button></div>
        <a class="file-viewer-icon-button">↓</a>
      </div>
    </div>
    <div class="markdown-file-preview" style="padding:24px 32px">Markdown content</div>
    <div class="dashboard-app notes-app" hidden><aside class="dashboard-sidebar is-open"></aside>
      <main class="dashboard-main"><header class="dashboard-topbar"><button class="dashboard-menu-button">☰</button></header>
        <div class="notes-content"><div class="notes-note"><div class="notes-note-bar"><button class="notes-mode">编辑</button></div><article class="notes-preview">Note</article></div></div>
      </main><aside class="notes-agent" hidden><header class="notes-agent-header"><button class="notes-agent-icon">×</button></header><div class="notes-agent-log"></div><form class="notes-agent-composer"><textarea></textarea><button class="notes-agent-send">发送</button></form></aside>
    </div>
    <div class="settings-dialog-backdrop" hidden><section class="settings-dialog-surface"><header class="settings-dialog-header">Settings<button class="config-close-button settings-dialog-close">×</button></header><div class="settings-dialog-main"><div class="settings-section-host"><div class="config-panel-root is-embedded"><div class="config-panel-surface"><div class="config-split-view"><aside class="config-sidebar">Models</aside><div class="config-detail">Model details</div></div></div></div></div></div></section></div>
    <div class="directory-picker-backdrop" hidden style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center"><section class="directory-picker-panel" style="width:520px;max-width:calc(100vw - 16px);height:min(620px,calc(100dvh - 16px));max-height:calc(100dvh - 16px)">Picker</section></div>
    <style>[hidden]{display:none!important}</style>`;
  const rect = (selector) => page.locator(selector).first().boundingBox();
  for (const width of [320, 390, 640, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(content);
    const mobile = width <= 640;
    assert.equal((await rect(".tabbar-scroll")).height, mobile ? 44 : 36);
    assert.equal((await rect(".tabbar-scroll button")).height, mobile ? 44 : 24);
    assert.equal((await rect(".file-panel-header")).height, mobile ? 44 : 36);
    assert.equal((await rect(".chat-topbar button")).height, mobile ? 44 : 36);
    assert.equal(await page.locator(".markdown-file-preview").evaluate((el) => getComputedStyle(el).paddingLeft), mobile ? "16px" : "32px");
    if (!mobile) continue;
    assert.equal((await rect(".chat-input-controls button")).height, 44);
    assert.equal((await rect(".chat-scroll-to-bottom")).height, 44);
    for (const button of await page.locator(".file-viewer-controls button, .file-viewer-controls a").all()) {
      const box = await button.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, `File controls fit ${width}px: ${JSON.stringify(box)}`);
      assert.ok(box.height >= 42, "File controls have touch-sized targets");
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, "No horizontal page overflow");
    // The shared viewport hook publishes the keyboard's remaining height.
    await page.evaluate(() => document.documentElement.style.setProperty("--app-viewport-height", "360px"));
    for (const selector of [".dashboard-app", ".notes-agent", ".settings-dialog-backdrop", ".directory-picker-backdrop"]) {
      await page.locator(selector).evaluate((el) => el.hidden = false);
    }
    assert.equal((await rect(".dashboard-app")).height, 360);
    assert.equal((await rect(".notes-agent")).height, 360);
    assert.equal((await rect(".dashboard-sidebar")).height, 360);
    assert.ok((await rect(".config-sidebar")).height < 190, "Configuration list gives space back to the detail when typing");
    assert.ok((await rect(".config-detail")).height >= 120, "Configuration details remain usable above the keyboard");
    for (const selector of [".settings-dialog-surface", ".directory-picker-panel"]) {
      const box = await rect(selector);
      assert.ok(box.y >= 8 && box.y + box.height <= 352, `${selector} stays above keyboard: ${JSON.stringify(box)}`);
    }
  }
  console.log("Mobile layout: 320/390/640px touch targets, file controls, notes, keyboard dialogs and 1024px desktop pass.");
} finally {
  await browser.close();
}
