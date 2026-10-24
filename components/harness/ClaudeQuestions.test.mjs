import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ClaudeQuestions } = await jiti.import("./ClaudeQuestions.tsx");
const { ClaudeModels } = await jiti.import("./ClaudeModels.tsx");
const render = (component, props) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(component, props)));

test("native questions keep single and multi choice semantics and accessible labels", () => {
  const html = render(ClaudeQuestions, { questions: [
    { question: "Choose one", header: "One", multiSelect: false, options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] },
    { question: "Choose several", header: "Many", multiSelect: true, options: [{ label: "C", description: "Third" }, { label: "D", description: "Fourth" }] },
  ], onChange: () => {} });
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  assert.match(html, /<legend[^>]*>Choose one<\/legend>/);
  assert.match(html, /<legend[^>]*>Choose several<\/legend>/);
  assert.equal((html.match(/Other answer/g) ?? []).length, 2);
});

test("new-user settings explain where to configure profiles without exposing config contents", () => {
  const html = render(ClaudeModels);
  assert.match(html, /Configure model profiles in this file/);
  assert.match(html, /Refresh/);
  assert.doesNotMatch(html, /ANTHROPIC_AUTH_TOKEN|cc\.toml|scripts\/cc/);
});
