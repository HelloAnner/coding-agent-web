import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SESSION_DIGEST_PROMPT, SELF_CHECK_PROMPT, digestPassed, digestReport } = await jiti.import("./digest.ts");

// The self-check pass ends the run only when the agent's first line says PASS.
test("a pass is done only when the first line says PASS", () => {
  for (const text of ["PASS", "pass", "  PASS\n动了 2 块板", "**PASS** 改完", "通过：两块板都核过了"]) {
    assert.equal(digestPassed(text), true, text);
  }
  for (const text of ["FAIL: 少一条关系", "已经画好了", "先说明一下\nPASS", ""]) {
    assert.equal(digestPassed(text), false, text);
  }
});

test("the PASS marker does not leak into the tooltip", () => {
  assert.equal(digestReport("**PASS** 动了 2 块板"), "动了 2 块板");
  assert.equal(digestReport("FAIL: 少一条关系"), "FAIL: 少一条关系");
  assert.equal(digestReport(""), "已处理完，没有可汇报的内容");
});

test("the prompts keep the rules that regressions dropped before", () => {
  // relations, self-check, better-than-before, multi-region are what the runs lacked.
  for (const rule of ["画系统，不画过程", "事实清单", "条 arrow", "说人话", "不比原来差", "2~4 个区域", "最多动 3 块"]) {
    assert.ok(SESSION_DIGEST_PROMPT.includes(rule), rule);
  }
  for (const rule of ["读回来", "事实条数和区域数", "讨论过程", "PASS"]) {
    assert.ok(SELF_CHECK_PROMPT.includes(rule), rule);
  }
});
