import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, jsx: { runtime: "automatic" } });
const { HarnessPlugins } = await jiti.import("./HarnessPlugins.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const render = (initialHarness) => renderToStaticMarkup(createElement(I18nProvider, null, createElement(HarnessPlugins, { initialHarness, cwd: null, sessionId: null, onClose() {} })));

test("plugin tabs select the current harness and never initialize the unvisited runtime", () => {
  const pi = render("pi");
  assert.match(pi, /role="tab"[^>]*aria-selected="true"[^>]*>pi<\/button>/);
  assert.match(pi, /Choose a project to manage pi plugins/);
  assert.doesNotMatch(pi, /<iframe/);
  for (const match of pi.matchAll(/aria-controls="([^"]+)"/g)) assert.ok(pi.includes(`id="${match[1]}"`));
  const dsh = render("dsh");
  assert.match(dsh, /role="tab"[^>]*aria-selected="true"[^>]*>dsh<\/button>/);
  assert.match(dsh, /<iframe[^>]*view=plugins/);
  assert.doesNotMatch(dsh, /Choose a project/);
  assert.match(dsh, /role="tabpanel"[^>]*aria-labelledby=/);
  assert.match(render("unsupported"), /Choose a project/);
});
