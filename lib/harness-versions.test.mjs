import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseVersion } = await jiti.import("./harness-versions.ts");

test("reads the version out of every harness's own --version line", () => {
  assert.equal(parseVersion("2.1.318 (Claude Code)"), "2.1.318");
  assert.equal(parseVersion("0.2.0-rc.2"), "0.2.0-rc.2");
  assert.equal(parseVersion("grok 1.0.70 (f50904eaee6c)"), "1.0.70");
  assert.equal(parseVersion("omp/18.7.0"), "18.7.0");
  assert.equal(parseVersion("18.16.0\n"), "18.16.0");
});

test("returns null when a probe printed no version", () => {
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("command not found"), null);
});
