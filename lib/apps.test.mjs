import assert from "node:assert/strict";
import test from "node:test";
import { webAppForPath, WEB_APPS } from "./apps.ts";

test("the switcher offers coding and the independent dashboard", () => {
  assert.deepEqual(WEB_APPS.map((app) => [app.id, app.label, app.href]), [
    ["coding", "Coding", "/"],
    ["dashboard", "Dashboard", "/dashboard"],
  ]);
  assert.equal(new Set(WEB_APPS.map((app) => app.id)).size, WEB_APPS.length);
});

test("the app in view comes from the path", () => {
  for (const path of ["/", "/sessions", "/?cwd=x", "/index"]) {
    assert.equal(webAppForPath(path).id, "coding", path);
  }
  for (const path of ["/dashboard", "/dashboard/", "/dashboard/anything"]) {
    assert.equal(webAppForPath(path).id, "dashboard", path);
  }
});
