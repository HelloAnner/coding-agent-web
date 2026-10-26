import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("../../../hooks/useI18n.tsx");
const { ClaudeRunningAgentsView } = await jiti.import("./RunningAgents.tsx");

const task = (id, status = "running", type = "subagent") => ({ id, description: id, status, type, background: true, ambient: false });
function render(tasks, connected = true) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ClaudeRunningAgentsView, { snapshot: { connected, foreground: false, tasks } })));
}

test("shows one row per running subagent without the old task panel controls", () => {
  const html = render([task("Review backend"), task("Review frontend"), task("Shell job", "running", "shell"), task("Workflow", "running", "workflow"), task("Completed report", "completed"), task("Pending report", "pending"), task("Paused report", "paused"), task("Failed report", "failed"), task("Stopped report", "stopped")]);
  assert.equal((html.match(/<li /g) ?? []).length, 2);
  assert.match(html, /Review backend/);
  assert.match(html, /Review frontend/);
  for (const hidden of ["Shell job", "Workflow", "Completed report", "Pending report", "Paused report", "Failed report", "Stopped report"]) assert.ok(!html.includes(hidden));
  assert.ok(!html.includes("<button"));
  assert.ok(!html.includes("aria-expanded"));
});

test("removes agents when they finish and hides disconnected snapshots", () => {
  assert.match(render([task("Review")]), /Review/);
  assert.equal(render([task("Review", "completed")]), "");
  assert.equal(render([task("Review")], false), "");
  assert.equal(render([]), "");
});
